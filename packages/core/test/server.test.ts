// Covers createServerDeps with a fake chain client: the store rule (C38), the deployer key never
// being read (C40), the relayer check at boot (C43), the judge settings and the dev country flag,
// and, through the real route and judge handler, that the judge code never reaches a response, a
// log line or a warning (FA-9).
// Not covered here: a real RPC, a real Upstash database, loadServerEnv's file loading
// (env-server.test.ts), and node:http (the live local run covers scripts/serve.ts).
import { getAddress, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, parseServerEnv } from "../src/env.js";
import { route, type ServerDeps } from "../src/http.js";
import type { verifyPrivyAccessToken } from "../src/privy.js";
import { BootError, createServerDeps } from "../src/server-deps.js";
import { isSharedStore } from "../src/store.js";

const RELAYER_KEY = `0x${"22".repeat(32)}`;
const RELAYER = privateKeyToAccount(RELAYER_KEY as `0x${string}`).address;
const OTHER_RELAYER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const DEPLOYER_KEY = `0x${"11".repeat(32)}`;
const SEED = `0x${"5a".repeat(32)}`;
const CODE = "MOI-7K4P-QX9M";
const BASE: Record<string, string> = {
  OC_API_KEY: "test-api-key-123456",
  OC_SECRET_KEY: "test-secret-abcdef",
  RELAYER_PRIVATE_KEY: RELAYER_KEY,
  MOI_VAULT_ADDRESS: VAULT.toLowerCase(),
  MOI_PAYOUT_ADDRESS: "0x96e854abddc5c618ca843956d1303017b586ab75",
  MOI_PUBLIC_ORIGIN: "https://moi.example",
};
const UPSTASH = { UPSTASH_REDIS_REST_URL: "https://eu1-fake-store.upstash.io", UPSTASH_REDIS_REST_TOKEN: "fake-upstash-token-0001" };

const savedDeployer = process.env.DEPLOYER_PRIVATE_KEY;
afterEach(() => {
  vi.useRealTimers();
  if (savedDeployer === undefined) delete process.env.DEPLOYER_PRIVATE_KEY;
  else process.env.DEPLOYER_PRIVATE_KEY = savedDeployer;
});

function fakeClient(relayer: string | Error) {
  const calls: { address: string; functionName: string }[] = [];
  const client = {
    async readContract(args: { address: string; functionName: string }) {
      calls.push({ address: args.address, functionName: args.functionName });
      if (args.functionName !== "relayer") throw new Error(`unexpected ${args.functionName}`);
      if (relayer instanceof Error) throw relayer;
      return relayer;
    },
  } as unknown as PublicClient;
  return { client, calls };
}

async function boot(values: Record<string, string>, relayer: string | Error = RELAYER) {
  const reads = new Set<string>();
  const source = new Proxy(values, {
    get(target, prop) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.get(target, prop);
    },
  });
  const warnings: string[] = [];
  const { client, calls } = fakeClient(relayer);
  const deps = await createServerDeps(parseServerEnv(source), { source, client, warn: (line) => warnings.push(line) });
  return { deps, reads, warnings, calls };
}

async function bootError(values: Record<string, string>, relayer: string | Error = RELAYER): Promise<Error> {
  try {
    await boot(values, relayer);
  } catch (err) {
    return err as Error;
  }
  throw new Error("boot did not refuse");
}

describe("createServerDeps", () => {
  it("boots on the shared store and builds every dependency from config", async () => {
    const { deps, warnings, calls } = await boot({ ...BASE, ...UPSTASH });
    expect(deps.storeKind).toBe("upstash");
    expect(isSharedStore(deps.store)).toBe(true);
    expect(warnings).toEqual([]);
    expect(deps).toMatchObject({
      vault: VAULT,
      payTo: "0x96E854aBDdc5C618ca843956d1303017b586aB75",
      sponsor: null,
      origin: "https://moi.example",
      wrapPriceUsd: "0.05",
      judge: null,
      privyAppId: null,
      devAllowUnknownCountry: false,
    });
    expect(deps.api).not.toBe(deps.wrapApi);
    expect(typeof deps.relayer.submitClaim).toBe("function");
    expect(typeof deps.getStocks).toBe("function");
    expect(calls).toEqual([{ address: VAULT, functionName: "relayer" }]);
  });

  it("refuses a memory store unless MOI_ALLOW_MEMORY_STORE is exactly 1, and warns when it is used (C38)", async () => {
    for (const flag of [undefined, "true", "yes", "0", " 1"]) {
      const values = flag === undefined ? BASE : { ...BASE, MOI_ALLOW_MEMORY_STORE: flag };
      const err = await bootError(values);
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).variables).toEqual(["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]);
    }
    const { deps, warnings } = await boot({ ...BASE, MOI_ALLOW_MEMORY_STORE: "1" });
    expect(deps.storeKind).toBe("memory");
    expect(isSharedStore(deps.store)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("C38");
  });

  it("never reads DEPLOYER_PRIVATE_KEY, even when the environment holds it (C40)", async () => {
    process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;
    const values = { ...BASE, ...UPSTASH, DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY, MOI_JUDGE_POOL: "7:0", MOI_JUDGE_SEED: SEED, MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app123" };
    const { deps, reads } = await boot(values);
    expect(reads.has("DEPLOYER_PRIVATE_KEY")).toBe(false);
    const text = JSON.stringify(deps, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v));
    expect(text).not.toContain("1111111111");
  });

  it("boots only when the vault's relayer on chain is the relayer key's address (C43)", async () => {
    expect((await boot({ ...BASE, ...UPSTASH }, RELAYER.toLowerCase())).deps.vault).toBe(VAULT);

    const mismatch = await bootError({ ...BASE, ...UPSTASH }, OTHER_RELAYER);
    expect(mismatch).toBeInstanceOf(BootError);
    expect(mismatch.message).toContain(`only accepts claims from relayer ${OTHER_RELAYER}`);
    expect(mismatch.message).toContain(`RELAYER_PRIVATE_KEY belongs to ${RELAYER}`);
    expect(mismatch.message).not.toContain("2222222222");

    const down = await bootError({ ...BASE, ...UPSTASH }, new Error("fetch failed: https://rpc.example/secret-path-key"));
    expect(down).toBeInstanceOf(BootError);
    expect(down.message).toContain("Could not read the relayer");
    expect(down.message).not.toContain("secret-path-key");
  });

  it("checks the settings before reading the chain, so a bad setting makes no RPC call", async () => {
    const warnings: string[] = [];
    const { client, calls } = fakeClient(RELAYER);
    await expect(createServerDeps(parseServerEnv(BASE), { source: BASE, client, warn: (l) => warnings.push(l) })).rejects.toBeInstanceOf(EnvError);
    expect(calls).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("closes judge gifts without a pool and then never reads the seed", async () => {
    const { deps, reads } = await boot({ ...BASE, ...UPSTASH, MOI_JUDGE_SEED: SEED, MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app123" });
    expect(deps.judge).toBeNull();
    expect(deps.privyAppId).toBe("app123");
    expect(reads.has("MOI_JUDGE_SEED")).toBe(false);
  });

  it("opens judge gifts with a parsed pool, a usable seed, the judge code and a Privy app id", async () => {
    const { deps } = await boot({ ...BASE, ...UPSTASH, MOI_JUDGE_POOL: "12:0,13:1", MOI_JUDGE_SEED: SEED, MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app123" });
    expect(deps.judge?.seed).toBe(SEED);
    expect(deps.judge?.code).toBe(CODE);
    expect([...(deps.judge?.pool ?? [])]).toEqual([
      [12n, 0],
      [13n, 1],
    ]);
  });

  it("names every judge setting that is missing or malformed, never its value", async () => {
    const cases: [Record<string, string>, string[]][] = [
      [{ MOI_JUDGE_POOL: "12:0" }, ["MOI_JUDGE_SEED", "MOI_JUDGE_CODE", "NEXT_PUBLIC_PRIVY_APP_ID"]],
      // FA-9: a pool without a judge code does not boot.
      [{ MOI_JUDGE_POOL: "12:0", MOI_JUDGE_SEED: SEED, NEXT_PUBLIC_PRIVY_APP_ID: "app123" }, ["MOI_JUDGE_CODE"]],
      [{ MOI_JUDGE_POOL: "12:0", MOI_JUDGE_SEED: SEED, MOI_JUDGE_CODE: "moi-7k4p-qx9m", NEXT_PUBLIC_PRIVY_APP_ID: "app123" }, ["MOI_JUDGE_CODE"]],
      [{ MOI_JUDGE_POOL: "12:0,12:1", MOI_JUDGE_SEED: SEED, MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app123" }, ["MOI_JUDGE_POOL"]],
      [{ MOI_JUDGE_POOL: "12:0", MOI_JUDGE_SEED: "0xnotaseed", MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app123" }, ["MOI_JUDGE_SEED"]],
      [{ MOI_JUDGE_POOL: "12:0", MOI_JUDGE_SEED: `0x${"00".repeat(32)}`, MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app123" }, ["MOI_JUDGE_SEED"]],
      [{ MOI_JUDGE_POOL: "12:0", MOI_JUDGE_SEED: SEED, MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app-123!" }, ["NEXT_PUBLIC_PRIVY_APP_ID"]],
    ];
    for (const [extra, names] of cases) {
      const err = await bootError({ ...BASE, ...UPSTASH, ...extra });
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).variables).toEqual(names);
      for (const value of Object.values(extra)) expect(err.message).not.toContain(value);
    }
  });

  it("derives the client hash key from the relayer key, the same on every boot and never the key itself (C46)", async () => {
    const first = (await boot({ ...BASE, ...UPSTASH })).deps.clientHashKey;
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).toBe((await boot({ ...BASE, ...UPSTASH })).deps.clientHashKey);
    expect(first).not.toBe(RELAYER_KEY);
    expect(first).not.toContain("2222222222");
    const otherKey = `0x${"33".repeat(32)}` as const;
    const other = await boot({ ...BASE, ...UPSTASH, RELAYER_PRIVATE_KEY: otherKey }, privateKeyToAccount(otherKey).address);
    expect(other.deps.clientHashKey).not.toBe(first);
  });

  it("allows an unknown country only when MOI_DEV_ALLOW_UNKNOWN_COUNTRY is exactly 1", async () => {
    expect((await boot({ ...BASE, ...UPSTASH, MOI_DEV_ALLOW_UNKNOWN_COUNTRY: "1" })).deps.devAllowUnknownCountry).toBe(true);
    for (const flag of ["true", "0", "yes"]) {
      expect((await boot({ ...BASE, ...UPSTASH, MOI_DEV_ALLOW_UNKNOWN_COUNTRY: flag })).deps.devAllowUnknownCountry).toBe(false);
    }
  });

  it("keeps the judge code out of every response, log line and warning on the real route (FA-9)", async () => {
    // Mid-minute, so the six wrong codes below always land in one counting window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 8, 12, 0, 10));
    const { deps, warnings } = await boot({ ...BASE, MOI_ALLOW_MEMORY_STORE: "1", MOI_JUDGE_POOL: "12:0", MOI_JUDGE_SEED: SEED, MOI_JUDGE_CODE: CODE, NEXT_PUBLIC_PRIVY_APP_ID: "app123" });
    const lines: string[] = [];
    const served: ServerDeps = { ...deps, log: (line) => lines.push(line), verifyAccessToken: (async () => Promise.reject(new Error("offline"))) as typeof verifyPrivyAccessToken };
    const send = (judgeCode: string, clientIp: string) =>
      route(served, { method: "POST", path: "/api/judge", headers: {}, body: JSON.stringify({ judgeCode }), clientIp, country: "IN", region: null });
    const answers = [];
    for (let i = 0; i < 6; i += 1) answers.push(await send("MOI-2222-3333", "203.0.113.7"));
    answers.push(await send(CODE.toLowerCase(), "203.0.113.7"));
    // The right code from a fresh client passes the code check and stops at the missing access token.
    answers.push(await send(CODE, "198.51.100.9"));
    expect(answers.map((a) => [a.status, (JSON.parse(a.body) as { error: string }).error])).toEqual([
      ...Array.from({ length: 5 }, () => [403, "bad_judge_code"]),
      [429, "rate_limited"],
      [429, "rate_limited"],
      [401, "bad_token"],
    ]);
    expect(lines).toHaveLength(8);
    const text = [...answers.map((a) => JSON.stringify(a)), ...lines, ...warnings].join("\n").toLowerCase();
    for (const part of [CODE, "7K4P", "QX9M"]) expect(text).not.toContain(part.toLowerCase());
  });
});
