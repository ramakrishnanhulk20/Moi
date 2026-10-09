// Not covered here: a real node, a real vault, the real relayer and Privy. Keys are checked against
// node:crypto's own HKDF as an independent second implementation; the HTTP route, its body cap,
// its cache headers and how it reads the platform's IP and country belong to the route. How the
// judge code gets from the environment to this handler, and the route's log lines, are in
// server.test.ts.
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { bytesToHex, getAddress, recoverTypedDataAddress, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAIM_TYPES, claimDomain } from "../src/gift.js";
import { canonicalClientIp, deriveClientHashKey, deriveJudgeKey, handleJudgeClaim, hashClientId, JudgeConfigError, judgeWalletMessage, parseJudgePool } from "../src/judge.js";
import { PrivyTokenError, type verifyPrivyAccessToken } from "../src/privy.js";
import { ClaimRefusedError, DailyCapReachedError, GasPriceTooHighError, RelayerBusyError, RelayerInputError, type createRelayer } from "../src/relayer.js";
import { createMemoryStore, keys, StoreError, type KvStore } from "../src/store.js";

const SEED = `0x${"5a".repeat(32)}` as const;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function nodeHkdf(seed: string, info: string): string {
  return bytesToHex(new Uint8Array(hkdfSync("sha256", Buffer.from(seed.slice(2), "hex"), "moi-judge-v1", info, 32)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveJudgeKey", () => {
  it("is deterministic and matches HKDF-SHA256 with salt moi-judge-v1 and info gift-<index>", async () => {
    expect(await deriveJudgeKey(SEED, 0)).toBe(await deriveJudgeKey(SEED, 0));
    expect(await deriveJudgeKey(SEED, 7)).toBe(nodeHkdf(SEED, "gift-7"));
  });

  it("gives a distinct, usable key for every index and every seed", async () => {
    const keys = new Set<string>();
    for (let i = 0; i <= 63; i += 1) {
      const key = await deriveJudgeKey(SEED, i);
      const value = BigInt(key);
      expect(value > 0n && value < SECP256K1_N).toBe(true);
      expect(privateKeyToAccount(key).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      keys.add(key);
    }
    expect(keys.size).toBe(64);
    expect(await deriveJudgeKey(`0x${"5b".repeat(32)}`, 0)).not.toBe(await deriveJudgeKey(SEED, 0));
  });

  it("never returns zero or a value at or above the curve order: it derives again with gift-<index>-<n>", async () => {
    const subtle = globalThis.crypto.subtle;
    const infos: string[] = [];
    const real = subtle.deriveBits.bind(subtle);
    const spy = vi.spyOn(subtle, "deriveBits").mockImplementation(async (algorithm, base, length) => {
      infos.push(new TextDecoder().decode((algorithm as { info: Uint8Array }).info));
      if (infos.length === 1) return new ArrayBuffer(32);
      if (infos.length === 2) return Uint8Array.from(Buffer.from(SECP256K1_N.toString(16), "hex")).buffer;
      return real(algorithm, base, length);
    });
    const key = await deriveJudgeKey(SEED, 3);
    spy.mockRestore();
    expect(infos).toEqual(["gift-3", "gift-3-1", "gift-3-2"]);
    expect(key).toBe(nodeHkdf(SEED, "gift-3-2"));
  });

  it("refuses a malformed or all-zero seed and an index outside 0 to 63, without echoing the seed", async () => {
    for (const [seed, index] of [
      [`0x${"5a".repeat(31)}`, 0],
      [`0x${"zz".repeat(32)}`, 0],
      [`0x${"00".repeat(32)}`, 0],
      [SEED, -1],
      [SEED, 64],
      [SEED, 1.5],
    ] as const) {
      const err = await deriveJudgeKey(seed as `0x${string}`, index).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JudgeConfigError);
      expect((err as Error).message).not.toContain(SEED.slice(2, 20));
    }
  });
});

describe("parseJudgePool", () => {
  it("reads giftId:index pairs", () => {
    expect(parseJudgePool("12:0,7:1,100:63")).toEqual(
      new Map([
        [12n, 0],
        [7n, 1],
        [100n, 63],
      ]),
    );
  });

  it("refuses every malformed form", () => {
    for (const text of ["", "12", "12:", ":0", "12:0,", ",12:0", " 12:0", "12:0 ", "12:0;13:1", "012:0", "0:0", "0x0c:0", "-12:0", "12:01", "12:64", "12:-1", "12:1.0", "12:0,12:1", "12:0,13:0", `${1n << 256n}:0`]) {
      expect(() => parseJudgePool(text), text).toThrow(JudgeConfigError);
    }
  });
});

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const SPONSOR = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const APP_ID = "cmuy05pes00wz0ckz26av3gig";
const NOW = 1_800_000_000n;
const TODAY = new Date(Number(NOW) * 1000);
const DAY = TODAY.toISOString().slice(0, 10);
const STATE = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;
const HASH_KEY = `0x${"7c".repeat(32)}` as const;
const CODE = "MOI-7K4P-QX9M";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (text: string) => `0x${createHash("sha256").update(text).digest("hex")}`;

type PoolGift = { state: number; expiry: bigint; claimKey: Hex };

// Pool gift i holds index i, stored with the key deriveJudgeKey gives for that index, unless
// `overrides` says otherwise. `rpc` records every chain call, so a test can prove which never ran.
async function world(giftIds: bigint[], overrides: Record<string, Partial<PoolGift>> = {}) {
  const pool = new Map(giftIds.map((id, i) => [id, i] as const));
  const gifts = new Map<bigint, PoolGift>();
  const derived: Hex[] = [];
  for (const [id, index] of pool) {
    const key = await deriveJudgeKey(SEED, index);
    derived.push(key);
    gifts.set(id, { state: STATE.Open, expiry: NOW + 30n * 86_400n, claimKey: privateKeyToAccount(key).address, ...overrides[id.toString()] });
  }
  const rpc: string[] = [];
  const code: Record<string, Hex> = {};
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args: [bigint] }) => {
      rpc.push(functionName);
      const g = gifts.get(args[0]);
      if (functionName !== "getGift" || g === undefined) throw new Error("unexpected read");
      return { token: NVDAB, sender: SPONSOR, claimKey: g.claimKey, expiry: g.expiry, state: g.state, amount: 10n ** 15n, sealedNote: "0x" };
    },
    getBlock: async () => (rpc.push("getBlock"), { timestamp: NOW }),
    getCode: async ({ address }: { address: Hex }) => (rpc.push("getCode"), code[getAddress(address)]),
  } as unknown as PublicClient;
  return { pool, gifts, derived, client, rpc, code };
}

type Judge = { userId: string; account: PrivateKeyAccount; wallet: Hex; accessToken: string };

function newJudges(n: number): Judge[] {
  return Array.from({ length: n }, (_, i) => {
    const account = privateKeyToAccount(generatePrivateKey());
    return {
      userId: `did:privy:judge${i}`,
      account,
      wallet: account.address,
      accessToken: `eyJhbGciOiJFUzI1NiJ9.judge-${i}-${generatePrivateKey().slice(2, 18)}.c2ln`,
    };
  });
}

// Stands in for verifyPrivyAccessToken: a judge's own token gives that judge's user id.
function fakeVerifier(judges: Judge[]) {
  const calls: string[] = [];
  const verify = (async (token: string) => {
    calls.push(token);
    const judge = judges.find((j) => j.accessToken === token);
    if (judge === undefined) throw new PrivyTokenError("invalid");
    return { userId: judge.userId };
  }) as typeof verifyPrivyAccessToken;
  return { verify, calls };
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ISSUED = stamp(TODAY.getTime() - 30_000);

type ProofOptions = { recipient?: Hex; signer?: PrivateKeyAccount; userId?: string; issuedAt?: string; walletProof?: string; judgeCode?: string };

// The body a judge's page sends: the wallet signs judgeWalletMessage, as the page will.
async function judgeBody(j: Judge, o: ProofOptions = {}) {
  const recipient = o.recipient ?? j.wallet;
  const issuedAt = o.issuedAt ?? ISSUED;
  const message = judgeWalletMessage({ recipient, userId: o.userId ?? j.userId, issuedAt });
  const walletProof = o.walletProof ?? (await (o.signer ?? j.account).signMessage({ message }));
  return { accessToken: j.accessToken, recipient, walletProof, issuedAt, judgeCode: o.judgeCode ?? CODE, declaration: true };
}

type Submitted = { giftId: bigint; recipient: Hex; signature: Hex };

function fakeRelayer(outcome: (n: number) => { txHash: Hex; reused: boolean } | Error = (n) => ({ txHash: `0x${n.toString(16).padStart(64, "0")}`, reused: false }), delayMs = 0) {
  const seen: Submitted[] = [];
  const relayer = {
    submitClaim: async (input: Submitted) => {
      seen.push(input);
      const result = outcome(seen.length);
      if (delayMs > 0) await sleep(delayMs);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as ReturnType<typeof createRelayer>;
  return { relayer, seen };
}

function countingStore() {
  const inner = createMemoryStore(() => Number(NOW) * 1000);
  const writes: string[] = [];
  const store: KvStore = {
    ...inner,
    setNx: async (k, v, ttl) => (writes.push(k), inner.setNx(k, v, ttl)),
    set: async (k, v, ttl) => (writes.push(k), inner.set(k, v, ttl)),
    incrBy: async (k, n, ttl) => (writes.push(k), inner.incrBy(k, n, ttl)),
  };
  return { store, writes };
}

async function setup(giftIds: bigint[], opts: { judges?: number; overrides?: Record<string, Partial<PoolGift>>; relayer?: ReturnType<typeof fakeRelayer> } = {}) {
  const w = await world(giftIds, opts.overrides);
  const judges = newJudges(opts.judges ?? 2);
  const verifier = fakeVerifier(judges);
  const relayer = opts.relayer ?? fakeRelayer();
  const { store, writes } = countingStore();
  const deps = {
    client: w.client,
    vault: VAULT,
    relayer: relayer.relayer,
    store,
    judgeSeed: SEED,
    pool: w.pool,
    judgeCode: CODE,
    privyAppId: APP_ID,
    clientHashKey: HASH_KEY,
    verifyAccessToken: verifier.verify,
    now: () => TODAY,
  };
  const claim = async (j: Judge, ip = "203.0.113.7", extra: ProofOptions & { country?: string | null } = {}) =>
    handleJudgeClaim(deps, await judgeBody(j, extra), { country: extra.country === undefined ? "IN" : extra.country, clientIp: ip });
  const userKey = async (j: Judge) => keys.judgeUser(VAULT, await hashClientId(HASH_KEY, j.userId));
  // An IPv4 client's network is its own address, so this is that address's per-network key.
  const ipKey = async (ip: string) => keys.judgeNetworkDay(VAULT, await hashClientId(HASH_KEY, ip), DAY);
  const giftKey = (id: bigint) => keys.judgeGiftTaken(VAULT, id);
  const hourKey = keys.judgeHour(VAULT, TODAY.toISOString().slice(0, 13));
  return { ...w, judges, verifier, relayer, store, writes, deps, claim, userKey, ipKey, giftKey, hourKey };
}

describe("handleJudgeClaim", () => {
  it("hands a judge the first pool gift, signed by that gift's judge key for their own wallet", async () => {
    const t = await setup([101n, 102n]);
    const [judge] = t.judges as [Judge];
    const res = await t.claim(judge);
    expect(res).toEqual({ status: 200, body: { ok: true, giftId: "101", txHash: `0x${"1".padStart(64, "0")}` } });
    const sent = t.relayer.seen[0]!;
    expect(sent.recipient).toBe(judge.wallet);
    const signer = await recoverTypedDataAddress({
      domain: claimDomain(VAULT, 56),
      types: CLAIM_TYPES,
      primaryType: "Claim",
      message: { giftId: 101n, recipient: judge.wallet },
      signature: sent.signature,
    });
    expect(signer).toBe(privateKeyToAccount(t.derived[0]!).address);
  });

  it("answers a second claim by the same user with 409, even from another network", async () => {
    const t = await setup([101n, 102n]);
    const [judge] = t.judges as [Judge];
    expect((await t.claim(judge)).status).toBe(200);
    expect(await t.claim(judge, "198.51.100.9")).toEqual({ status: 409, body: { ok: false, error: "already_claimed" } });
    expect(t.relayer.seen).toHaveLength(1);
  });

  it("answers a second user from the same network on the same day with 429, and frees that user's mark", async () => {
    const t = await setup([101n, 102n]);
    const [first, second] = t.judges as [Judge, Judge];
    expect((await t.claim(first, "203.0.113.7")).status).toBe(200);
    // An IPv4-mapped IPv6 spelling is the same network.
    expect((await t.claim(second, "::FFFF:203.0.113.7")).body).toEqual({ ok: false, error: "too_many_from_network" });
    expect(await t.store.get(await t.userKey(second))).toBeNull();
    expect((await t.claim(second, "198.51.100.9")).status).toBe(200);
  });

  it("counts an IPv6 client by its /64: a second judge in the same /64 that day gets 429, one in another /64 passes", async () => {
    const t = await setup([101n, 102n, 103n], { judges: 4 });
    const [first, sameNet, spelledOut, otherNet] = t.judges as [Judge, Judge, Judge, Judge];
    expect((await t.claim(first, "2001:db8:1:2::1")).body).toMatchObject({ ok: true, giftId: "101" });
    expect(await t.claim(sameNet, "2001:db8:1:2:ffff:ffff:ffff:fffe")).toEqual({ status: 429, body: { ok: false, error: "too_many_from_network" } });
    expect(await t.store.get(await t.userKey(sameNet))).toBeNull();
    expect((await t.claim(spelledOut, "2001:0DB8:0001:0002:0000:0000:0000:abcd")).body).toEqual({ ok: false, error: "too_many_from_network" });
    expect((await t.claim(otherNet, "2001:db8:1:3::1")).body).toMatchObject({ ok: true, giftId: "102" });
  });

  it("answers the fifth judge claim inside one UTC hour with 429 judges_busy, leaving no mark, and lets it through the next hour", async () => {
    const t = await setup([101n, 102n, 103n, 104n, 105n, 106n], { judges: 5 });
    const fifth = t.judges[4]!;
    for (const [i, j] of t.judges.slice(0, 4).entries()) expect((await t.claim(j, `198.51.100.${i + 1}`)).status).toBe(200);
    expect(await t.claim(fifth, "198.51.100.5")).toEqual({ status: 429, body: { ok: false, error: "judges_busy" } });
    expect(await t.store.get(await t.userKey(fifth))).toBeNull();
    expect(await t.store.get(await t.ipKey("198.51.100.5"))).toBeNull();
    expect(await t.store.get(t.hourKey)).toBe("4");
    expect(t.relayer.seen).toHaveLength(4);

    const nextHour = new Date(TODAY.getTime() + 60 * 60_000);
    const body = await judgeBody(fifth, { issuedAt: stamp(nextHour.getTime() - 30_000) });
    expect((await handleJudgeClaim({ ...t.deps, now: () => nextHour }, body, { country: "IN", clientIp: "198.51.100.5" })).body).toMatchObject({ ok: true, giftId: "105" });
  });

  it("never gives two concurrent judges the same gift", async () => {
    // Four judges, the most one hour lets through, racing for three gifts.
    const t = await setup([101n, 102n, 103n], { judges: 4, relayer: fakeRelayer(undefined, 5) });
    const results = await Promise.all(t.judges.map((j, i) => t.claim(j, `198.51.100.${i + 1}`)));
    const given = results.flatMap((r) => (r.body.ok ? [r.body.giftId] : []));
    expect(new Set(given).size).toBe(3);
    expect(given.sort()).toEqual(["101", "102", "103"]);
    expect(results.filter((r) => !r.body.ok).map((r) => r.body)).toEqual([{ ok: false, error: "pool_empty" }]);
    expect(new Set(t.relayer.seen.map((s) => s.giftId)).size).toBe(3);
  });

  it("skips a closed, nearly expired or mismatched pool gift and keeps it taken", async () => {
    const t = await setup([101n, 102n, 103n, 104n, 105n], {
      overrides: { "101": { state: STATE.Claimed }, "102": { expiry: NOW + 599n }, "103": { claimKey: SPONSOR } },
    });
    const [first, second] = t.judges as [Judge, Judge];
    expect((await t.claim(first, "198.51.100.1")).body).toMatchObject({ ok: true, giftId: "104" });
    for (const id of [101n, 102n, 103n]) expect(await t.store.get(t.giftKey(id))).not.toBeNull();
    const reads = t.rpc.filter((c) => c === "getGift").length;
    expect((await t.claim(second, "198.51.100.2")).body).toMatchObject({ ok: true, giftId: "105" });
    expect(t.rpc.filter((c) => c === "getGift").length).toBe(reads + 1);
  });

  it("answers 410 when the pool is empty and frees the user and network marks", async () => {
    const t = await setup([101n], { overrides: { "101": { state: STATE.Refunded } } });
    const [judge] = t.judges as [Judge];
    expect(await t.claim(judge)).toEqual({ status: 410, body: { ok: false, error: "pool_empty" } });
    expect(await t.store.get(await t.userKey(judge))).toBeNull();
    expect(await t.store.get(await t.ipKey("203.0.113.7"))).toBeNull();
    expect(await t.store.get(t.hourKey)).toBe("0");
    expect(t.relayer.seen).toHaveLength(0);
  });

  it("signs exactly the four-line wallet message, and refuses fields that would add a line", () => {
    const wallet = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(judgeWalletMessage({ recipient: wallet.toLowerCase(), userId: "did:privy:abc", issuedAt: "2027-01-15T08:00:00Z" })).toBe(
      `Moi judge gift\nWallet: ${wallet}\nPrivy user: did:privy:abc\nIssued at: 2027-01-15T08:00:00Z`,
    );
    expect(() => judgeWalletMessage({ recipient: wallet, userId: "did:privy:abc\nWallet: 0x0", issuedAt: "2027-01-15T08:00:00Z" })).toThrow();
    expect(() => judgeWalletMessage({ recipient: wallet, userId: "did:privy:abc", issuedAt: "2027-01-15T08:00:00.000Z" })).toThrow();
  });

  it("refuses a wallet proof by another key, for another user, stale, from the future or malformed, before any store write", async () => {
    const t = await setup([101n]);
    const [judge, other] = t.judges as [Judge, Judge];
    const refused = async (o: ProofOptions) => (await t.claim(judge, undefined, o)).body;
    expect(await refused({ signer: other.account })).toEqual({ ok: false, error: "wallet_not_verified" });
    expect(await refused({ recipient: other.wallet })).toEqual({ ok: false, error: "wallet_not_verified" });
    expect(await refused({ userId: other.userId })).toEqual({ ok: false, error: "wallet_not_verified" });
    expect(await t.claim(judge, undefined, { issuedAt: stamp(TODAY.getTime() - 6 * 60_000) })).toEqual({ status: 401, body: { ok: false, error: "proof_expired" } });
    expect(await refused({ issuedAt: stamp(TODAY.getTime() + 2 * 60_000) })).toEqual({ ok: false, error: "proof_expired" });
    expect(await refused({ walletProof: "0x1234" })).toEqual({ ok: false, error: "bad_wallet_proof" });
    const real = (await judgeBody(judge)).walletProof;
    expect(await refused({ walletProof: `${real} ` })).toEqual({ ok: false, error: "bad_wallet_proof" });
    const body = { ...(await judgeBody(judge)), issuedAt: "2027-01-15T07:59:30.000Z" };
    expect((await handleJudgeClaim(t.deps, body, { country: "IN", clientIp: "203.0.113.7" })).body).toEqual({ ok: false, error: "bad_wallet_proof" });
    expect(t.writes).toHaveLength(0);
    expect(t.relayer.seen).toHaveLength(0);
  });

  it("refuses a recipient that is a contract, even with a valid proof, before any store write", async () => {
    const t = await setup([101n]);
    const [judge] = t.judges as [Judge];
    t.code[judge.wallet] = "0x6080604052";
    expect((await t.claim(judge)).body).toEqual({ ok: false, error: "bad_recipient" });
    expect(t.writes).toHaveLength(0);
  });

  it("refuses a restricted or unknown place before any verify call or chain read", async () => {
    const t = await setup([101n]);
    const [judge] = t.judges as [Judge];
    expect(await t.claim(judge, undefined, { country: "US" })).toEqual({ status: 403, body: { ok: false, error: "restricted_place" } });
    expect((await t.claim(judge, undefined, { country: null })).body).toEqual({ ok: false, error: "unknown_place" });
    expect(t.verifier.calls).toHaveLength(0);
    expect(t.rpc).toHaveLength(0);
    expect(t.writes).toHaveLength(0);
  });

  it("refuses a client address that is not an IP address before any store write", async () => {
    const t = await setup([101n]);
    const [judge] = t.judges as [Judge];
    for (const ip of ["", "localhost", "203.0.113.7:80", "fe80::1%eth0", "203.0.113", "010.0.0.1", "1.2.3.4.5"]) {
      expect((await t.claim(judge, ip)).body, ip).toEqual({ ok: false, error: "unknown_network" });
    }
    expect(t.writes).toHaveLength(0);
    expect(canonicalClientIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("releases the gift, user and network marks when the relayer fails, so the judge can retry", async () => {
    const t = await setup([101n, 102n], { relayer: fakeRelayer((n) => (n === 1 ? new RelayerBusyError() : { txHash: `0x${"ab".repeat(32)}`, reused: false })) });
    const [judge] = t.judges as [Judge];
    expect(await t.claim(judge)).toEqual({ status: 429, body: { ok: false, error: "busy" } });
    for (const k of [await t.userKey(judge), await t.ipKey("203.0.113.7"), t.giftKey(101n)]) expect(await t.store.get(k)).toBeNull();
    expect((await t.claim(judge)).body).toMatchObject({ ok: true, giftId: "101" });
  });

  it("still releases every mark on each relayer refusal that is thrown before anything is sent", async () => {
    const refusals: [Error, string][] = [
      [new ClaimRefusedError("GiftNotOpen"), "claim_refused"],
      [new ClaimRefusedError(null, "GiftExpiring"), "gift_expiring"],
      [new RelayerBusyError(), "busy"],
      [new DailyCapReachedError(), "daily_cap"],
      [new GasPriceTooHighError(), "gas_price_high"],
      [new RelayerInputError("Gift id is not valid."), "claim_refused"],
    ];
    for (const [err, code] of refusals) {
      const t = await setup([101n, 102n], { relayer: fakeRelayer((n) => (n === 1 ? err : { txHash: `0x${"ab".repeat(32)}`, reused: false })) });
      const [judge] = t.judges as [Judge];
      expect((await t.claim(judge)).body, code).toEqual({ ok: false, error: code });
      for (const k of [await t.userKey(judge), await t.ipKey("203.0.113.7"), t.giftKey(101n)]) expect(await t.store.get(k)).toBeNull();
      expect(await t.store.get(t.hourKey)).toBe("0");
      expect((await t.claim(judge)).body).toMatchObject({ ok: true, giftId: "101" });
    }
  });

  it("keeps every mark when the relayer fails in a way that may follow a broadcast, so a retry never takes a second gift (F1)", async () => {
    // The claim for gift 101 lands on chain, then the node times out before the relayer can say so.
    let gifts: Map<bigint, PoolGift> | undefined;
    const relayer = fakeRelayer((n) => {
      if (n > 1) return { txHash: `0x${n.toString(16).padStart(64, "0")}`, reused: false };
      gifts!.get(101n)!.state = STATE.Claimed;
      return new Error("timeout");
    });
    const t = await setup([101n, 102n], { relayer });
    gifts = t.gifts;
    const [judge] = t.judges as [Judge];
    expect(await t.claim(judge)).toEqual({ status: 202, body: { ok: false, error: "claim_pending" } });
    expect(await t.claim(judge, undefined, { issuedAt: stamp(TODAY.getTime() - 10_000) })).toEqual({ status: 409, body: { ok: false, error: "already_claimed" } });
    expect(t.relayer.seen.map((s) => s.giftId)).toEqual([101n]);
    for (const k of [await t.userKey(judge), await t.ipKey("203.0.113.7"), t.giftKey(101n)]) expect(await t.store.get(k)).not.toBeNull();
    expect(await t.store.get(t.hourKey)).toBe("1");
  });

  it("keeps a gift taken when the relayer reuses an earlier claim, and frees the judge to take the next", async () => {
    const t = await setup([101n, 102n], { relayer: fakeRelayer((n) => ({ txHash: `0x${n.toString(16).padStart(64, "0")}`, reused: n === 1 })) });
    const [judge] = t.judges as [Judge];
    expect(await t.claim(judge)).toEqual({ status: 503, body: { ok: false, error: "try_again" } });
    expect(await t.store.get(t.giftKey(101n))).not.toBeNull();
    expect(await t.store.get(await t.userKey(judge))).toBeNull();
    expect((await t.claim(judge)).body).toMatchObject({ ok: true, giftId: "102" });
  });

  it("stores the judge and the network only as keyed hashes: a plain SHA-256 is never a key, and another key gives other records (C46)", async () => {
    const t = await setup([101n]);
    const [judge] = t.judges as [Judge];
    expect((await t.claim(judge)).status).toBe(200);
    expect(await t.store.get(await t.userKey(judge))).not.toBeNull();
    expect(await t.store.get(await t.ipKey("203.0.113.7"))).not.toBeNull();
    expect(await t.store.get(keys.judgeUser(VAULT, sha(judge.userId)))).toBeNull();
    expect(await t.store.get(keys.judgeNetworkDay(VAULT, sha("203.0.113.7"), DAY))).toBeNull();
    const written = t.writes.filter((k) => k.includes(":judgeuser:") || k.includes(":judgeip:"));
    expect(written).toEqual([await t.userKey(judge), await t.ipKey("203.0.113.7")]);

    // The keyed hash is HMAC-SHA256: node:crypto agrees, and a different key changes every mark.
    const otherKey = `0x${"7d".repeat(32)}` as const;
    expect(await hashClientId(HASH_KEY, "203.0.113.7")).toBe(`0x${createHmac("sha256", Buffer.from(HASH_KEY.slice(2), "hex")).update("203.0.113.7").digest("hex")}`);
    expect(await hashClientId(otherKey, "203.0.113.7")).not.toBe(await hashClientId(HASH_KEY, "203.0.113.7"));
    for (const bad of ["0x1234", `0x${"7c".repeat(31)}`, HASH_KEY.slice(2)]) {
      await expect(hashClientId(bad as `0x${string}`, "x")).rejects.toBeInstanceOf(JudgeConfigError);
    }

    // The server's key comes from a 32-byte secret by HKDF: fixed for one secret, never the secret.
    const secret = `0x${"22".repeat(32)}` as const;
    const derived = await deriveClientHashKey(secret);
    expect(derived).toMatch(/^0x[0-9a-f]{64}$/);
    expect(derived).toBe(await deriveClientHashKey(secret));
    expect(derived).toBe(bytesToHex(new Uint8Array(hkdfSync("sha256", Buffer.from(secret.slice(2), "hex"), "moi-client-hash-v1", "client-id", 32))));
    expect(derived).not.toBe(await deriveClientHashKey(`0x${"23".repeat(32)}`));
    for (const bad of [`0x${"00".repeat(32)}`, "0x1234"]) {
      const err = await deriveClientHashKey(bad as `0x${string}`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JudgeConfigError);
      expect((err as Error).message).not.toContain(bad.slice(2, 10));
    }
  });

  it("never puts the seed, a derived key, the access token or the judge code in a response, and never throws", async () => {
    const leaky = (text: string) => Object.assign(new Error(text), { cause: new Error(text) });
    const t = await setup([101n, 102n]);
    const [judge] = t.judges as [Judge];
    const secrets = [SEED, SEED.slice(2), ...t.derived, ...t.derived.map((k) => k.slice(2)), judge.accessToken, CODE, "7K4P", "QX9M"];
    const responses: unknown[] = [];
    const run = async (deps: Partial<typeof t.deps>) =>
      responses.push(await handleJudgeClaim({ ...t.deps, ...deps }, await judgeBody(judge), { country: "IN", clientIp: "203.0.113.7" }));
    await run({ verifyAccessToken: (async (token: string) => Promise.reject(leaky(`bad token ${token}`))) as typeof verifyPrivyAccessToken });
    await run({ verifyAccessToken: (async () => Promise.reject(new PrivyTokenError("expired"))) as typeof verifyPrivyAccessToken });
    // A relayer failure that may follow a broadcast keeps the judge's marks (F1), so it runs on its own store.
    await run({ relayer: fakeRelayer(() => leaky(`relayer saw ${t.derived[0]} and ${SEED}`)).relayer, store: createMemoryStore(() => Number(NOW) * 1000) });
    await run({ relayer: fakeRelayer(() => ({ txHash: "0xnot-a-hash" as Hex, reused: false })).relayer });
    await run({ store: { ...t.store, setNx: async () => Promise.reject(new StoreError(`store saw ${SEED}`)) } });
    await run({ pool: null as unknown as Map<bigint, number> });
    await run({ judgeSeed: "0x1234" as `0x${string}` });
    // A configured code outside its exact form refuses every claim rather than matching loosely.
    await run({ judgeCode: CODE.toLowerCase() });
    await run({ store: { ...t.store, get: async () => Promise.reject(new StoreError(`store saw ${CODE}`)) } });
    responses.push(await handleJudgeClaim(t.deps, await judgeBody(judge, { judgeCode: "MOI-7K4P-QX9N" }), { country: "IN", clientIp: "203.0.113.7" }));
    await run({});
    expect(responses.map((r) => (r as { body: unknown }).body)).toEqual([
      { ok: false, error: "auth_unavailable" },
      { ok: false, error: "token_expired" },
      { ok: false, error: "claim_pending" },
      { ok: false, error: "relayer_unavailable" },
      { ok: false, error: "store_unavailable" },
      { ok: false, error: "server_misconfigured" },
      { ok: false, error: "server_misconfigured" },
      { ok: false, error: "server_misconfigured" },
      { ok: false, error: "store_unavailable" },
      { ok: false, error: "bad_judge_code" },
      { ok: true, giftId: "101", txHash: `0x${"1".padStart(64, "0")}` },
    ]);
    const text = JSON.stringify(responses);
    for (const secret of secrets) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
  });
});

describe("handleJudgeClaim: the judge code (FA-9)", () => {
  const counterFor = async (ip: string, at = TODAY) => keys.rateLimit("client", await hashClientId(HASH_KEY, ip), `judgecode-${Math.floor(at.getTime() / 60_000)}`);

  it("lets the right code through to the usual flow, in any letter case and with spaces, and counts nothing", async () => {
    const t = await setup([101n, 102n, 103n], { judges: 3 });
    const [a, b, c] = t.judges as [Judge, Judge, Judge];
    expect((await t.claim(a, "198.51.100.1")).body).toMatchObject({ ok: true, giftId: "101" });
    expect((await t.claim(b, "198.51.100.2", { judgeCode: "moi-7k4p-qx9m" })).body).toMatchObject({ ok: true, giftId: "102" });
    expect((await t.claim(c, "198.51.100.3", { judgeCode: "  MOI - 7K4P -\tqx9m " })).body).toMatchObject({ ok: true, giftId: "103" });
    expect(t.writes.some((k) => k.includes(":ratelimit:"))).toBe(false);
  });

  it("refuses a wrong, missing, one-off or oversized code with 403 before the place, the verifier, the chain or any write but its counter", async () => {
    const t = await setup([101n]);
    const [judge] = t.judges as [Judge];
    const base = await judgeBody(judge);
    const missing: Record<string, unknown> = { ...base };
    delete missing.judgeCode;
    const bodies: unknown[] = [
      { ...base, judgeCode: "MOI-2222-3333" },
      missing,
      { ...base, judgeCode: "MOI-7K4P-QX9N" },
      // 33 characters: refused by length even though it would normalise to the code.
      { ...base, judgeCode: `${CODE}${" ".repeat(20)}` },
      { ...base, judgeCode: 7 },
    ];
    for (const body of bodies) {
      // US is a restricted place, so 403 bad_judge_code here proves the code is checked first.
      expect(await handleJudgeClaim(t.deps, body, { country: "US", clientIp: "203.0.113.7" })).toEqual({ status: 403, body: { ok: false, error: "bad_judge_code" } });
    }
    expect(t.verifier.calls).toHaveLength(0);
    expect(t.rpc).toHaveLength(0);
    const counter = await counterFor("203.0.113.7");
    expect(t.writes).toEqual(Array.from({ length: 5 }, () => counter));
    expect(await t.store.get(counter)).toBe("5");
  });

  it("answers 429 from the sixth wrong code in a minute, to the right code too, for that client and minute only", async () => {
    const t = await setup([101n, 102n]);
    const [judge, other] = t.judges as [Judge, Judge];
    const wrong = await judgeBody(judge, { judgeCode: "MOI-2222-3333" });
    for (let i = 0; i < 5; i += 1) expect((await handleJudgeClaim(t.deps, wrong, { country: "IN", clientIp: "203.0.113.7" })).status).toBe(403);
    // The IPv4-mapped spelling of the same address counts in the same bucket.
    expect(await handleJudgeClaim(t.deps, wrong, { country: "IN", clientIp: "::ffff:203.0.113.7" })).toEqual({ status: 429, body: { ok: false, error: "rate_limited" } });
    expect(await t.claim(judge, "203.0.113.7")).toEqual({ status: 429, body: { ok: false, error: "rate_limited" } });
    expect(t.verifier.calls).toHaveLength(0);

    expect((await t.claim(other, "198.51.100.9")).body).toMatchObject({ ok: true, giftId: "101" });
    const nextMinute = { ...t.deps, now: () => new Date(TODAY.getTime() + 60_000) };
    expect((await handleJudgeClaim(nextMinute, await judgeBody(judge), { country: "IN", clientIp: "203.0.113.7" })).body).toMatchObject({ ok: true, giftId: "102" });
  });
});
