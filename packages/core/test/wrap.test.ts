// Not covered here: the live b402 facilitator (every call goes to a fake api; the live read-only
// /supported check is scratchpad/wo4d/live-requirements.mts), a real payment signature (b402 verifies
// it, not Moi), the HTTP route that reads the header and caps the body, and a real chain or store
// beyond the in-process memory store.
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  erc721Abi,
  getAddress,
  HttpRequestError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";
import { createMemoryStore, keys, type KvStore } from "../src/store.js";
import { Web3ApiError, type Web3Api } from "../src/web3api.js";
import {
  buildPaymentRequirements,
  handleWrap,
  isWrapped,
  WRAP_ASSETS,
  WrapConfigError,
  type PaymentRequirementsV2,
  type WrapDeps,
} from "../src/wrap.js";

const PAY_TO = getAddress("0x96e854abddc5c618ca843956d1303017b586ab75");
const ORIGIN = "https://moi.example";
const PRICE = "0.05";
const SIGNER = "0x34F7a661160780Ce1346e6D7B96D2bE244590899";
const SPENDER = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633";
const UPTO_SPENDER = "0x8c819E6De3df83E0e87bBE7651c5D4e83229b239";

// The data part of the live signed /supported answer for our key, 2026-10-07 12:25 UTC
// (scratchpad/probes/_api_v2_b402_supported_2026-10-07T12-25-28-792Z.json).
const LIVE_SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "United Stables", version: "1", assetTransferMethod: "eip3009", signerAddress: SIGNER } },
    { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "United Stables", version: "1", assetTransferMethod: "permit2-exact", signerAddress: SIGNER, spenderAddress: SPENDER } },
    { x402Version: 2, scheme: "upto", network: "eip155:56", extra: { name: "United Stables", version: "1", assetTransferMethod: "permit2-upto", signerAddress: SIGNER, spenderAddress: UPTO_SPENDER } },
    { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "eip3009", signerAddress: SIGNER } },
    { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "permit2-exact", signerAddress: SIGNER, spenderAddress: SPENDER } },
    { x402Version: 2, scheme: "upto", network: "eip155:56", extra: { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "permit2-upto", signerAddress: SIGNER, spenderAddress: UPTO_SPENDER } },
    { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", signerAddress: SIGNER, spenderAddress: SPENDER } },
    { x402Version: 2, scheme: "upto", network: "eip155:56", extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-upto", signerAddress: SIGNER, spenderAddress: UPTO_SPENDER } },
    { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "USD Coin", version: "1", assetTransferMethod: "permit2-exact", signerAddress: SIGNER, spenderAddress: SPENDER } },
    { x402Version: 2, scheme: "upto", network: "eip155:56", extra: { name: "USD Coin", version: "1", assetTransferMethod: "permit2-upto", signerAddress: SIGNER, spenderAddress: UPTO_SPENDER } },
  ],
  extensions: [],
  signers: { "eip155:*": [SIGNER] },
};

type Call = { path: string; body: unknown };

// A fake signed client: `supported` answers /supported (or throws when it is an Error), and every
// call is recorded so a test can count them.
function fakeApi(supported: unknown = LIVE_SUPPORTED, calls: Call[] = []) {
  const api: Web3Api = {
    get: async () => {
      throw new Error("no GET in wrap");
    },
    post: async (path, body) => {
      calls.push({ path, body });
      if (path !== "/api/v2/b402/supported") throw new Error(`unexpected ${path}`);
      if (supported instanceof Error) throw supported;
      return structuredClone(supported);
    },
  };
  return { api, calls };
}

const asset = (symbol: string) => WRAP_ASSETS.find((a) => a.symbol === symbol)!.address;

describe("buildPaymentRequirements", () => {
  it("offers one requirement per exact kind on chain 56 whose name is listed, with the price in 18 decimals", async () => {
    const { api, calls } = fakeApi();
    const reqs = await buildPaymentRequirements({ api, origin: ORIGIN, payTo: PAY_TO, priceUsd: PRICE }, 7n);
    expect(reqs.map((r) => [r.asset, r.extra.assetTransferMethod])).toEqual([
      [asset("U"), "eip3009"],
      [asset("U"), "permit2-exact"],
      [asset("USD1"), "eip3009"],
      [asset("USD1"), "permit2-exact"],
      [asset("USDT"), "permit2-exact"],
      [asset("USDC"), "permit2-exact"],
    ]);
    for (const r of reqs) {
      expect(r).toMatchObject({ scheme: "exact", network: "eip155:56", amount: "50000000000000000", payTo: PAY_TO, maxTimeoutSeconds: 120 });
    }
    expect(reqs[0]?.extra).toEqual(LIVE_SUPPORTED.kinds[0]?.extra);
    expect(reqs[1]?.extra).toEqual(LIVE_SUPPORTED.kinds[1]?.extra);
    expect(calls).toEqual([{ path: "/api/v2/b402/supported", body: { body: {} } }]);
  });

  it("drops kinds that are upto, another network or version, an unlisted name, or carry a malformed or unknown extra field", async () => {
    const base = LIVE_SUPPORTED.kinds[0]!;
    const permit2 = LIVE_SUPPORTED.kinds[1]!;
    const odd = [
      { ...base, network: "eip155:97" },
      { ...base, x402Version: 1 },
      { ...base, scheme: "upto" },
      { ...base, extra: { ...base.extra, name: "Fake USD" } },
      { ...base, extra: { ...base.extra, signerAddress: "0x1234" } },
      { ...base, extra: { ...base.extra, signerAddress: SIGNER.toLowerCase().replace("0x34f7", "0x34F7") } },
      { ...base, extra: { ...base.extra, payTo: "0x0000000000000000000000000000000000000001" } },
      { ...permit2, extra: { ...permit2.extra, spenderAddress: undefined } },
      { ...permit2, extra: { ...permit2.extra, assetTransferMethod: "permit2-upto" } },
      "not a kind",
      null,
    ];
    const { api } = fakeApi({ kinds: [...odd, permit2] });
    const reqs = await buildPaymentRequirements({ api, origin: ORIGIN, payTo: PAY_TO, priceUsd: PRICE }, 7n);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.extra).toEqual(permit2.extra);
  });

  it("reads /supported once per 10 minutes, shares one call between concurrent callers, and never caches a failure", async () => {
    let now = 1_000_000;
    const { api, calls } = fakeApi();
    const deps = { api, origin: ORIGIN, payTo: PAY_TO, priceUsd: PRICE, now: () => now };
    await Promise.all([buildPaymentRequirements(deps, 1n), buildPaymentRequirements(deps, 2n)]);
    now += 10 * 60 * 1000 - 1;
    await buildPaymentRequirements(deps, 3n);
    expect(calls).toHaveLength(1);
    now += 1;
    await buildPaymentRequirements(deps, 3n);
    expect(calls).toHaveLength(2);

    const failing = fakeApi(new Error("upstream down"));
    const failDeps = { ...deps, api: failing.api };
    await expect(buildPaymentRequirements(failDeps, 1n)).rejects.toThrow("upstream down");
    await expect(buildPaymentRequirements(failDeps, 1n)).rejects.toThrow("upstream down");
    expect(failing.calls).toHaveLength(2);
  });

  it("refuses a kinds list that is missing or oversized", async () => {
    for (const bad of [{}, { kinds: "x" }, null, { kinds: new Array(65).fill(LIVE_SUPPORTED.kinds[0]) }]) {
      const { api } = fakeApi(bad);
      await expect(buildPaymentRequirements({ api, origin: ORIGIN, payTo: PAY_TO, priceUsd: PRICE }, 7n)).rejects.toThrow();
    }
  });

  it("prices by integer math in the asset's decimals", async () => {
    const { api } = fakeApi();
    for (const [price, amount] of [["0.05", "50000000000000000"], ["1", "1000000000000000000"], ["0.000001", "1000000000000"]]) {
      const reqs = await buildPaymentRequirements({ api, origin: ORIGIN, payTo: PAY_TO, priceUsd: price! }, 7n);
      expect(reqs.every((r) => r.amount === amount)).toBe(true);
    }
  });

  it("refuses a bad payee, origin, price or gift id before calling b402", async () => {
    const { api, calls } = fakeApi();
    const good = { api, origin: ORIGIN, payTo: PAY_TO, priceUsd: PRICE };
    const bad: [Partial<typeof good>, bigint][] = [
      [{ payTo: "0x0000000000000000000000000000000000000000" as Address }, 7n],
      [{ payTo: "0x1234" as Address }, 7n],
      [{ origin: "http://moi.example" }, 7n],
      [{ origin: "https://moi.example/app" }, 7n],
      [{ origin: "https://moi.example?x=1" }, 7n],
      [{ origin: "javascript:alert(1)" }, 7n],
      [{ priceUsd: "0" }, 7n],
      [{ priceUsd: "-0.05" }, 7n],
      [{ priceUsd: "0.0000001" }, 7n],
      [{ priceUsd: "1.01" }, 7n],
      [{ priceUsd: "5e-2" }, 7n],
      [{}, 0n],
      [{}, 1n << 256n],
    ];
    for (const [override, giftId] of bad) {
      await expect(buildPaymentRequirements({ ...good, ...override }, giftId)).rejects.toThrow();
    }
    await expect(buildPaymentRequirements({ ...good, priceUsd: "0" }, 7n)).rejects.toBeInstanceOf(WrapConfigError);
    expect(calls).toHaveLength(0);
    const local = await buildPaymentRequirements({ ...good, origin: "http://localhost:3000" }, 7n);
    expect(local).toHaveLength(6);
  });
});

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const OTHER_VAULT = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const SENDER = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const PAYER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const ATTACKER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const SIG = `0x${"11".repeat(65)}`;
const TX = `0x${"ab".repeat(32)}`;
const NONCE_A = `0x${"0a".repeat(32)}`;
const NONCE_B = `0x${"0b".repeat(32)}`;
const START_MS = 1_800_000_000_000;
const NOW_S = BigInt(START_MS / 1000);
const STATE = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;
const SETTLED = { success: true, transaction: TX, payer: PAYER, network: "eip155:56", amount: "50000000000000000" };
const PENDING = { success: false, transaction: TX, payer: PAYER, network: "eip155:56" };

const PRICE_UNITS = 50_000_000_000_000_000n;

// A log as the node returns it: lowercase emitter, ERC-20 Transfer topics and the value as data.
function transferLog(token: Address, to: Address, value: bigint) {
  return {
    address: token.toLowerCase(),
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

const receiptWith = (logs: unknown[], status = "success", transactionHash = TX) => ({ status, transactionHash, logs });
// What the chain shows for a real U settlement: the exact price moved to Ram's wallet.
const PAID_IN_U = receiptWith([transferLog(asset("U"), PAY_TO, PRICE_UNITS)]);

// null is a receipt the node does not have yet; a function is asked on every read, with the hash.
type ReceiptAnswer = unknown | null | ((hash: Hex) => unknown);

// Serves the gift record, a latest block at NOW_S and the settlement receipt. `secondsLeft` is the
// gift's expiry minus that. The node reports chain 56 unless `chainId` says otherwise.
function fakeClient(state: number = STATE.Open, fails?: Error, secondsLeft = 86_400n, receipt: ReceiptAnswer = PAID_IN_U, chainId = 56) {
  return {
    getChainId: async () => {
      if (fails) throw fails;
      return chainId;
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (fails) throw fails;
      if (functionName !== "getGift") throw new Error(`unexpected read ${functionName}`);
      return { token: NVDAB, sender: SENDER, claimKey: SENDER, expiry: NOW_S + secondsLeft, state, amount: 10n ** 15n, sealedNote: "0x" };
    },
    getBlock: async () => {
      if (fails) throw fails;
      return { timestamp: NOW_S };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (fails) throw fails;
      const answer = typeof receipt === "function" ? (receipt as (hash: Hex) => unknown)(hash) : receipt;
      if (answer === null) throw new TransactionReceiptNotFoundError({ hash });
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
  } as unknown as PublicClient;
}

type Answer = unknown | Error | (() => Promise<unknown>);

// A fake b402 behind the fixed-path client: /supported is the live answer, verify answers
// `verify`, and settle answers the `settle` list in order, repeating the last entry.
function b402(script: { verify?: Answer; settle?: Answer[] } = {}) {
  const calls: Call[] = [];
  let settles = 0;
  const answer = async (a: Answer) => {
    if (a instanceof Error) throw a;
    return typeof a === "function" ? (a as () => Promise<unknown>)() : structuredClone(a);
  };
  const api: Web3Api = {
    get: async () => {
      throw new Error("no GET in wrap");
    },
    post: async (path, body) => {
      calls.push({ path, body });
      if (path === "/api/v2/b402/supported") return structuredClone(LIVE_SUPPORTED);
      if (path === "/api/v2/b402/verify") return answer(script.verify ?? { isValid: true, payer: PAYER });
      if (path === "/api/v2/b402/settle") {
        const list = script.settle ?? [SETTLED];
        return answer(list[Math.min(settles++, list.length - 1)]);
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  const count = (path: string) => calls.filter((c) => c.path === path).length;
  return { api, calls, count };
}

function testClock() {
  let t = START_MS;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function wrapDeps(api: Web3Api, overrides: Partial<WrapDeps> = {}): WrapDeps & { store: KvStore } {
  const clock = testClock();
  return { api, client: fakeClient(), vault: VAULT, store: createMemoryStore(() => clock.now()), origin: ORIGIN, payTo: PAY_TO, priceUsd: PRICE, now: clock.now, sleep: clock.sleep, ...overrides };
}

const resourceFor = (giftId: number) => ({ url: `${ORIGIN}/api/wrap/${giftId}`, description: "Moi gift wrapping", mimeType: "application/json" });
// On the same clock as wrapDeps, so it shares that api's /supported cache instead of refetching.
const requirementsOf = async (api: Web3Api) => buildPaymentRequirements({ api, origin: ORIGIN, payTo: PAY_TO, priceUsd: PRICE, now: () => START_MS }, 7n);
const byMethod = (reqs: PaymentRequirementsV2[], symbol: string, method: string) =>
  reqs.find((r) => r.asset === asset(symbol) && r.extra.assetTransferMethod === method)!;

// A requirement as a buyer might echo it back, including a scheme or network this server never offers.
type AnyRequirement = Omit<PaymentRequirementsV2, "scheme" | "network"> & { scheme: string; network: string };

function eip3009Payment(req: AnyRequirement, auth: Record<string, string> = {}, top: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: resourceFor(7),
    accepted: structuredClone(req) as Record<string, unknown>,
    payload: {
      signature: SIG,
      authorization: { from: PAYER, to: req.payTo, value: req.amount, validAfter: "0", validBefore: String(NOW_S + 120n), nonce: NONCE_A, ...auth },
    },
    ...top,
  };
}

function permit2Payment(req: AnyRequirement, auth: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: resourceFor(7),
    accepted: structuredClone(req) as Record<string, unknown>,
    payload: {
      signature: SIG,
      permit2Authorization: {
        permitted: { token: req.asset, amount: req.amount },
        from: PAYER,
        spender: req.extra.spenderAddress,
        nonce: "5",
        deadline: String(NOW_S + 3_600n),
        witness: { to: req.payTo, validAfter: "0" },
        ...auth,
      },
    },
  };
}

const encode = (payment: unknown) => Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
const decodeHeader = (value: string | undefined) => JSON.parse(Buffer.from(value ?? "", "base64").toString("utf8"));

describe("handleWrap", () => {
  it("answers an unpaid request with 402, the x402 v2 body, and the same JSON base64 in PAYMENT-REQUIRED", async () => {
    const { api, calls } = b402();
    const deps = wrapDeps(api);
    const res = await handleWrap(deps, "7", null);
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ x402Version: 2, resource: resourceFor(7), accepts: await requirementsOf(api) });
    expect(Object.keys(res.headers ?? {})).toEqual(["PAYMENT-REQUIRED"]);
    expect(decodeHeader(res.headers?.["PAYMENT-REQUIRED"])).toEqual(res.body);
    expect(calls.map((c) => c.path)).toEqual(["/api/v2/b402/supported"]);
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
  });

  it("builds the 402 only from config: a forged origin, payee or resource in the request changes nothing (C24)", async () => {
    const { api, count } = b402();
    const reqs = await requirementsOf(api);
    const u = byMethod(reqs, "U", "eip3009");
    const forged = eip3009Payment(
      { ...u, payTo: ATTACKER },
      { to: ATTACKER },
      { resource: { url: "https://evil.example/api/wrap/7" } },
    );
    const res = await handleWrap(wrapDeps(api), "7", encode(forged));
    expect(res.status).toBe(402);
    const challenge = decodeHeader(res.headers?.["PAYMENT-REQUIRED"]);
    expect(challenge).toEqual({ x402Version: 2, error: "payment_mismatch", resource: resourceFor(7), accepts: reqs });
    expect(challenge.accepts.every((r: PaymentRequirementsV2) => r.payTo === PAY_TO)).toBe(true);
    // Our own terms with only the resource URL swapped are refused too: nothing in a payment picks the URL.
    const swapped = eip3009Payment(u, {}, { resource: { url: "https://evil.example/api/wrap/7" } });
    expect((await handleWrap(wrapDeps(api), "7", encode(swapped))).body).toMatchObject({ error: "payment_mismatch" });
    expect(count("/api/v2/b402/verify") + count("/api/v2/b402/settle")).toBe(0);
  });

  it("refuses an underpaid amount, another payee, asset or network, and an altered extra, before b402 sees them", async () => {
    const { api, count } = b402();
    const reqs = await requirementsOf(api);
    const u = byMethod(reqs, "U", "eip3009");
    const usdt = byMethod(reqs, "USDT", "permit2-exact");
    const under = (BigInt(u.amount) - 1n).toString();
    const payments = [
      eip3009Payment({ ...u, amount: under }, { value: under }),
      eip3009Payment(u, { value: under }),
      eip3009Payment({ ...u, payTo: ATTACKER }, { to: ATTACKER }),
      eip3009Payment(u, { to: ATTACKER }),
      eip3009Payment({ ...u, asset: asset("USDT") }),
      eip3009Payment({ ...u, network: "eip155:97" }),
      eip3009Payment({ ...u, scheme: "upto" }),
      eip3009Payment({ ...u, maxTimeoutSeconds: 86_400 }),
      eip3009Payment({ ...u, extra: { ...u.extra, signerAddress: ATTACKER } }),
      eip3009Payment({ ...u, extra: { ...u.extra, version: "2" } }),
      eip3009Payment({ ...u, extra: { ...u.extra, spenderAddress: ATTACKER } }),
      eip3009Payment(u, { validBefore: String(NOW_S + 86_401n) }),
      permit2Payment(usdt, { permitted: { token: asset("USDT"), amount: under } }),
      permit2Payment(usdt, { permitted: { token: asset("USDC"), amount: usdt.amount } }),
      permit2Payment(usdt, { spender: ATTACKER }),
      permit2Payment(usdt, { witness: { to: ATTACKER, validAfter: "0" } }),
      permit2Payment(usdt, { deadline: String(NOW_S + 86_401n) }),
      { ...permit2Payment(usdt), payload: eip3009Payment(u).payload },
    ];
    for (const payment of payments) {
      const deps = wrapDeps(api);
      const res = await handleWrap(deps, "7", encode(payment));
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ x402Version: 2, error: "payment_mismatch" });
      expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    }
    expect(count("/api/v2/b402/verify")).toBe(0);
    expect(count("/api/v2/b402/settle")).toBe(0);
  });

  it("answers a header that is not one clean base64 x402 v2 payment with 402 payment_malformed", async () => {
    const { api, count } = b402();
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const good = eip3009Payment(u);
    const bad = [
      "",
      "not base64!",
      encode(good).slice(1),
      `${encode(good)}=`,
      Buffer.from(JSON.stringify(good)).toString("base64url").replace(/=+$/, "") + "-",
      encode({ ...good, x402Version: 1 }),
      encode({ ...good, extra: 1 }),
      encode({ ...good, extensions: { bazaar: { description: "free gifts" } } }),
      encode({ ...good, payload: { ...good.payload, signature: "0x1234" } }),
      encode({ ...good, payload: { ...good.payload, authorization: { ...good.payload.authorization, nonce: "0x12" } } }),
      encode({ ...good, payload: { ...good.payload, authorization: { ...good.payload.authorization, value: "05" } } }),
      Buffer.from("{not json").toString("base64"),
      Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString("base64"),
      "A".repeat(8 * 1024 + 4),
    ];
    for (const header of bad) {
      const res = await handleWrap(wrapDeps(api), "7", header);
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: "payment_malformed" });
    }
    expect(count("/api/v2/b402/verify")).toBe(0);
  });

  it("settles a valid payment, marks the gift once, answers with PAYMENT-RESPONSE, and is idempotent after", async () => {
    const { api, calls, count } = b402();
    const deps = wrapDeps(api);
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const payment = eip3009Payment(u);
    const res = await handleWrap(deps, "7", encode(payment));
    expect(res).toMatchObject({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });
    expect(Object.keys(res.headers ?? {})).toEqual(["PAYMENT-RESPONSE"]);
    expect(decodeHeader(res.headers?.["PAYMENT-RESPONSE"])).toEqual({ success: true, transaction: TX, network: "eip155:56", payer: PAYER });
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(true);
    expect(JSON.parse((await deps.store.get(keys.wrapped(VAULT, 7n))) ?? "")).toEqual({
      txHash: TX,
      asset: asset("U"),
      amount: "50000000000000000",
      settledAt: new Date(START_MS).toISOString(),
    });

    // Standard 2: the decoded payment is the object verify and settle both received, unchanged.
    const verify = calls.find((c) => c.path === "/api/v2/b402/verify")!;
    const settle = calls.find((c) => c.path === "/api/v2/b402/settle")!;
    expect(verify.body).toBe(settle.body);
    expect(verify.body).toEqual({ body: { x402Version: 2, paymentPayload: payment, paymentRequirements: u } });
    expect(new Set(calls.map((c) => c.path))).toEqual(new Set(["/api/v2/b402/supported", "/api/v2/b402/verify", "/api/v2/b402/settle"]));

    const before = calls.length;
    expect(await handleWrap(deps, "7", null)).toEqual({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });
    const another = eip3009Payment(u, { nonce: NONCE_B });
    expect(await handleWrap(deps, "7", encode(another))).toEqual({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });
    expect(calls.length).toBe(before);
    expect(count("/api/v2/b402/settle")).toBe(1);
  });

  it("settles a permit2-exact USDT payment the same way", async () => {
    const { api } = b402();
    const paidInUsdt = receiptWith([transferLog(asset("USDT"), PAY_TO, PRICE_UNITS)]);
    const deps = wrapDeps(api, { client: fakeClient(STATE.Open, undefined, 86_400n, paidInUsdt) });
    const usdt = byMethod(await requirementsOf(api), "USDT", "permit2-exact");
    const res = await handleWrap(deps, "7", encode(permit2Payment(usdt)));
    expect(res).toMatchObject({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });
    expect(JSON.parse((await deps.store.get(keys.wrapped(VAULT, 7n))) ?? "").asset).toBe(asset("USDT"));
  });

  it("refuses a payment nonce already used for another gift, however the nonce is spelled (C24)", async () => {
    const { api, count } = b402();
    const store = createMemoryStore(() => START_MS);
    const reqs = await requirementsOf(api);
    const u = byMethod(reqs, "U", "eip3009");
    const usdt = byMethod(reqs, "USDT", "permit2-exact");
    expect((await handleWrap(wrapDeps(api, { store }), "7", encode(eip3009Payment(u)))).status).toBe(200);

    const replay = eip3009Payment(u, {}, { resource: resourceFor(8) });
    const res = await handleWrap(wrapDeps(api, { store }), "8", encode(replay));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: "payment_reused", resource: resourceFor(8) });

    // NONCE_A as a decimal permit2 nonce is the same 32-byte number, so it is the same mark.
    const sameNumber = permit2Payment(usdt, { nonce: BigInt(NONCE_A).toString() });
    const viaPermit2 = await handleWrap(wrapDeps(api, { store }), "8", encode({ ...sameNumber, resource: resourceFor(8) }));
    expect(viaPermit2.body).toMatchObject({ error: "payment_reused" });
    expect(await isWrapped(store, VAULT, 8n)).toBe(false);
    expect(count("/api/v2/b402/verify")).toBe(1);
    expect(count("/api/v2/b402/settle")).toBe(1);
  });

  it("refuses the same payment for the same gift id on another vault, without settling it again (C42)", async () => {
    const { api, count } = b402();
    const store = createMemoryStore(() => START_MS);
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const header = encode(eip3009Payment(u, {}, { resource: resourceFor(5) }));
    expect((await handleWrap(wrapDeps(api, { store }), "5", header)).status).toBe(200);
    expect(JSON.parse((await store.get(keys.paymentAuth(PAY_TO, PAYER, NONCE_A))) ?? "")).toMatchObject({ vault: VAULT, giftId: "5" });

    // Gift 5 is Open on vault B too: the fake chain answers Open for any vault.
    const onB = await handleWrap(wrapDeps(api, { store, vault: OTHER_VAULT, client: fakeClient(STATE.Open) }), "5", header);
    expect(onB.status).toBe(402);
    expect(onB.body).toMatchObject({ error: "payment_reused", resource: resourceFor(5) });
    expect(await isWrapped(store, OTHER_VAULT, 5n)).toBe(false);
    expect(count("/api/v2/b402/settle")).toBe(1);
  });

  it("marks nothing when verify says the payment is not valid, and releases its nonce", async () => {
    const leak = "invalid_exact_evm_payload_signature for key sk-live-0001";
    const { api, count } = b402({ verify: { isValid: false, invalidReason: leak, payer: PAYER } });
    const deps = wrapDeps(api);
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const header = encode(eip3009Payment(u));
    for (let i = 0; i < 2; i += 1) {
      const res = await handleWrap(deps, "7", header);
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: "payment_invalid" });
      expect(JSON.stringify(res)).not.toContain("sk-live");
    }
    // The second try reached verify again: the nonce was released, not burned.
    expect(count("/api/v2/b402/verify")).toBe(2);
    expect(count("/api/v2/b402/settle")).toBe(0);
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    expect(await deps.store.get(keys.paymentAuth(PAY_TO, PAYER, NONCE_A))).toBeNull();
    expect(await deps.store.get(keys.wrapped(VAULT, 7n))).toBeNull();

    const garbled = b402({ verify: { isValid: "yes" } });
    expect((await handleWrap(wrapDeps(garbled.api), "7", header)).body).toEqual({ ok: false, error: "facilitator_unavailable" });
    const down = b402({ verify: new Error("verify down") });
    expect((await handleWrap(wrapDeps(down.api), "7", header)).body).toEqual({ ok: false, error: "facilitator_unavailable" });
  });

  it("marks nothing when settle fails before broadcast, frees the gift for a new payment and keeps the old one spent", async () => {
    const leak = "invalid_exact_evm_payload_signature from node https://node.example";
    const { api, count } = b402({ settle: [{ success: false, transaction: "", payer: PAYER, network: "", errorReason: leak }] });
    const deps = wrapDeps(api);
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const res = await handleWrap(deps, "7", encode(eip3009Payment(u)));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: "payment_failed" });
    expect(JSON.stringify(res)).not.toContain("node.example");
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    expect(await deps.store.get(keys.wrapped(VAULT, 7n))).toBeNull();
    // A replay of the same payment asks settle again (b402 answers from its cache) and fails the same way.
    expect((await handleWrap(deps, "7", encode(eip3009Payment(u)))).body).toMatchObject({ error: "payment_failed" });
    expect(count("/api/v2/b402/verify")).toBe(1);
    expect(count("/api/v2/b402/settle")).toBe(2);
    // The payment stays bound to gift 7; a fresh payment for gift 7 is free to try.
    const elsewhere = eip3009Payment(u, {}, { resource: resourceFor(8) });
    expect((await handleWrap(deps, "8", encode(elsewhere))).body).toMatchObject({ error: "payment_reused" });
    expect((await handleWrap(deps, "7", encode(eip3009Payment(u, { nonce: NONCE_B })))).body).toMatchObject({ error: "payment_failed" });
    expect(count("/api/v2/b402/verify")).toBe(2);
  });

  it("polls a pending settlement every 4 seconds and marks it only once b402 reports success", async () => {
    const { api, count } = b402({ settle: [PENDING, new Error("gateway 504"), { nonsense: true }, PENDING, SETTLED] });
    const clock = testClock();
    const deps = wrapDeps(api, { now: clock.now, sleep: clock.sleep });
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const res = await handleWrap(deps, "7", encode(eip3009Payment(u)));
    expect(res).toMatchObject({ status: 200, body: { ok: true, txHash: TX } });
    expect(count("/api/v2/b402/settle")).toBe(5);
    expect(clock.sleeps).toEqual([4_000, 4_000, 4_000, 4_000]);
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(true);
  });

  it("answers 202 with Retry-After once the 25 second budget ends with the settlement pending, marks nothing, and holds gift and payment", async () => {
    const { api, count } = b402({ settle: [PENDING] });
    const clock = testClock();
    const deps = wrapDeps(api, { now: clock.now, sleep: clock.sleep });
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const res = await handleWrap(deps, "7", encode(eip3009Payment(u)));
    expect(res).toEqual({ status: 202, headers: { "Retry-After": "5" }, body: { ok: false, error: "settlement_pending", retryAfterSeconds: 5 } });
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    // 25 seconds at 4 seconds: the first call and 6 polls, then it answers.
    expect(count("/api/v2/b402/settle")).toBe(7);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(25_000);
    expect(JSON.parse((await deps.store.get(keys.paymentAuth(PAY_TO, PAYER, NONCE_A))) ?? "").giftId).toBe("7");
    // A second payment for the same gift could double charge while the first may still land.
    expect((await handleWrap(deps, "7", encode(eip3009Payment(u, { nonce: NONCE_B })))).body).toEqual({ ok: false, error: "wrap_in_progress" });
    expect((await handleWrap(deps, "7", null)).body).toEqual({ ok: false, error: "wrap_in_progress" });
    expect(count("/api/v2/b402/verify")).toBe(1);

    const longer = b402({ settle: [PENDING] });
    const slow = testClock();
    await handleWrap(wrapDeps(longer.api, { now: slow.now, sleep: slow.sleep, settleBudgetMs: 150_000 }), "7", encode(eip3009Payment(u)));
    expect(longer.count("/api/v2/b402/settle")).toBe(38);
  });

  it("resumes the same payment for the same gift on replay, without verify, and marks it once b402 settles it", async () => {
    let confirmed = false;
    const { api, count } = b402({ settle: [async () => structuredClone(confirmed ? SETTLED : PENDING)] });
    const deps = wrapDeps(api);
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const header = encode(eip3009Payment(u));
    expect((await handleWrap(deps, "7", header)).status).toBe(202);

    // Same nonce, different payment bytes: not a replay of this payment.
    const altered = eip3009Payment(u, {}, { payload: { ...eip3009Payment(u).payload, signature: `0x${"22".repeat(65)}` } });
    expect((await handleWrap(deps, "7", encode(altered))).body).toMatchObject({ error: "payment_reused" });
    // The same payment for another gift is still refused.
    const elsewhere = eip3009Payment(u, {}, { resource: resourceFor(8) });
    expect((await handleWrap(deps, "8", encode(elsewhere))).body).toMatchObject({ error: "payment_reused" });

    confirmed = true;
    const resumed = await handleWrap(deps, "7", header);
    expect(resumed).toMatchObject({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });
    expect(decodeHeader(resumed.headers?.["PAYMENT-RESPONSE"])).toMatchObject({ success: true, transaction: TX });
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(true);
    expect(count("/api/v2/b402/verify")).toBe(1);
    expect(count("/api/v2/b402/settle")).toBe(8);
    expect(await handleWrap(deps, "7", header)).toEqual({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });
    expect(count("/api/v2/b402/settle")).toBe(8);
  });

  it("answers 503 with Retry-After when the mark cannot be written after settling, and a replay marks it", async () => {
    const { api, count } = b402();
    let storeDown = true;
    const inner = createMemoryStore(() => START_MS);
    const store: KvStore = {
      ...inner,
      set: async (k, v, ttl) => (storeDown ? Promise.reject(new Error("store down")) : inner.set(k, v, ttl)),
    };
    const deps = wrapDeps(api, { store });
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const header = encode(eip3009Payment(u));
    expect(await handleWrap(deps, "7", header)).toEqual({
      status: 503,
      headers: { "Retry-After": "5" },
      body: { ok: false, error: "store_unavailable", retryAfterSeconds: 5 },
    });
    expect(await isWrapped(store, VAULT, 7n)).toBe(false);
    storeDown = false;
    expect(await handleWrap(deps, "7", header)).toMatchObject({ status: 200, body: { ok: true, txHash: TX } });
    expect(await isWrapped(store, VAULT, 7n)).toBe(true);
    expect(count("/api/v2/b402/verify")).toBe(1);
    expect(count("/api/v2/b402/settle")).toBe(2);
  });

  it("refuses to sell wrapping for a gift with under 10 minutes left, but still resumes a payment already bound to it", async () => {
    const { api, count } = b402();
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const expiring = fakeClient(STATE.Open, undefined, 599n);
    expect(await handleWrap(wrapDeps(api, { client: expiring }), "7", null)).toEqual({ status: 409, body: { ok: false, error: "gift_expiring" } });
    const store = createMemoryStore(() => START_MS);
    expect((await handleWrap(wrapDeps(api, { client: expiring, store }), "7", encode(eip3009Payment(u)))).body).toEqual({ ok: false, error: "gift_expiring" });
    expect(await store.get(keys.paymentAuth(PAY_TO, PAYER, NONCE_A))).toBeNull();
    expect(count("/api/v2/b402/verify")).toBe(0);
    expect((await handleWrap(wrapDeps(api, { client: fakeClient(STATE.Open, undefined, 600n) }), "7", null)).status).toBe(402);

    let confirmed = false;
    const pending = b402({ settle: [async () => structuredClone(confirmed ? SETTLED : PENDING)] });
    const bound = createMemoryStore(() => START_MS);
    const header = encode(eip3009Payment(byMethod(await requirementsOf(pending.api), "U", "eip3009")));
    expect((await handleWrap(wrapDeps(pending.api, { store: bound }), "7", header)).status).toBe(202);
    confirmed = true;
    expect((await handleWrap(wrapDeps(pending.api, { store: bound, client: expiring }), "7", header)).status).toBe(200);
    expect(await isWrapped(bound, VAULT, 7n)).toBe(true);
  });

  it("marks nothing when settle claims success without a usable hash, or for another network or amount", async () => {
    const odd = [
      { ...SETTLED, transaction: "" },
      { ...SETTLED, transaction: "0x1234" },
      { ...SETTLED, network: "eip155:1" },
      { ...SETTLED, amount: "1" },
    ];
    for (const answer of odd) {
      const { api } = b402({ settle: [answer] });
      const deps = wrapDeps(api);
      const u = byMethod(await requirementsOf(api), "U", "eip3009");
      expect(await handleWrap(deps, "7", encode(eip3009Payment(u)))).toEqual({ status: 502, body: { ok: false, error: "settlement_unexpected" } });
      expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    }
  });

  it("marks a settlement only when the chain's receipt shows the exact price moved to the payee in the paid asset (C42)", async () => {
    const OTHER_TX = `0x${"cd".repeat(32)}`;
    // Among the asset's other events, and beside an NFT-shaped Transfer that shares the topic.
    const nftShaped = {
      address: asset("U").toLowerCase(),
      topics: encodeEventTopics({ abi: erc721Abi, eventName: "Transfer", args: { from: PAYER, to: PAY_TO, tokenId: PRICE_UNITS } }),
      data: "0x",
    };
    const approval = {
      address: asset("U").toLowerCase(),
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Approval", args: { owner: PAYER, spender: PAY_TO } }),
      data: encodeAbiParameters([{ type: "uint256" }], [PRICE_UNITS]),
    };
    const mixed = receiptWith([approval, nftShaped, transferLog(asset("U"), PAY_TO, PRICE_UNITS)]);
    const good = b402();
    const goodDeps = wrapDeps(good.api, { client: fakeClient(STATE.Open, undefined, 86_400n, mixed) });
    const u = byMethod(await requirementsOf(good.api), "U", "eip3009");
    expect((await handleWrap(goodDeps, "7", encode(eip3009Payment(u)))).status).toBe(200);
    expect(await isWrapped(goodDeps.store, VAULT, 7n)).toBe(true);

    const wrong = [
      receiptWith([]),
      receiptWith([nftShaped, approval]),
      { ...PAID_IN_U, transactionHash: OTHER_TX },
      receiptWith([transferLog(asset("U"), ATTACKER, PRICE_UNITS)]),
      receiptWith([transferLog(asset("U"), PAY_TO, PRICE_UNITS - 1n)]),
      receiptWith([transferLog(asset("U"), PAY_TO, PRICE_UNITS + 1n)]),
      receiptWith([transferLog(asset("USDT"), PAY_TO, PRICE_UNITS)]),
      receiptWith([transferLog(NVDAB, PAY_TO, PRICE_UNITS)]),
      receiptWith([transferLog(asset("U"), PAY_TO, PRICE_UNITS)], "reverted"),
    ];
    for (const receipt of wrong) {
      const { api } = b402();
      const deps = wrapDeps(api, { client: fakeClient(STATE.Open, undefined, 86_400n, receipt) });
      expect(await handleWrap(deps, "7", encode(eip3009Payment(u)))).toEqual({ status: 502, body: { ok: false, error: "settlement_unexpected" } });
      expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    }

    // No receipt yet is pending, a node that cannot answer marks nothing, and a replay of the
    // same header marks once the chain shows the Transfer.
    let receipt: unknown = null;
    const later = b402();
    const deps = wrapDeps(later.api, { client: fakeClient(STATE.Open, undefined, 86_400n, () => receipt) });
    const header = encode(eip3009Payment(u));
    expect(await handleWrap(deps, "7", header)).toEqual({
      status: 202,
      headers: { "Retry-After": "5" },
      body: { ok: false, error: "settlement_pending", retryAfterSeconds: 5 },
    });
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    receipt = new HttpRequestError({ url: "https://secret-node.example", details: "timeout" });
    const down = await handleWrap(deps, "7", header);
    expect(down).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
    receipt = PAID_IN_U;
    expect(await handleWrap(deps, "7", header)).toMatchObject({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(true);
    expect(later.count("/api/v2/b402/verify")).toBe(1);
    expect(later.count("/api/v2/b402/settle")).toBe(3);
  });

  it("lets one settlement transaction mark one gift: a facilitator answering an old hash marks nothing, a batched receipt marks one gift per Transfer (C44)", async () => {
    // One payment per gift, but b402 answers both with the same hash: the second gift must not ride
    // on the first gift's settlement, whatever the receipt shows.
    const store = createMemoryStore(() => START_MS);
    const { api, count } = b402();
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    expect((await handleWrap(wrapDeps(api, { store }), "7", encode(eip3009Payment(u)))).status).toBe(200);
    const second = eip3009Payment(u, { nonce: NONCE_B }, { resource: resourceFor(8) });
    const stale = await handleWrap(wrapDeps(api, { store }), "8", encode(second));
    expect(stale).toEqual({ status: 502, body: { ok: false, error: "settlement_unexpected" } });
    expect(await isWrapped(store, VAULT, 8n)).toBe(false);
    expect(count("/api/v2/b402/settle")).toBe(2);
    // The first gift's record is untouched and still answers idempotently.
    expect(await handleWrap(wrapDeps(api, { store }), "7", null)).toEqual({ status: 200, body: { ok: true, wrapped: true, txHash: TX } });

    // A receipt holding two exact Transfers is a batch of two settlements: it may mark two gifts,
    // one per Transfer, and never a third.
    const batched = receiptWith([transferLog(asset("U"), PAY_TO, PRICE_UNITS), transferLog(asset("U"), PAY_TO, PRICE_UNITS)]);
    const batchStore = createMemoryStore(() => START_MS);
    const batch = b402();
    const batchDeps = () => wrapDeps(batch.api, { store: batchStore, client: fakeClient(STATE.Open, undefined, 86_400n, batched) });
    const NONCE_C = `0x${"0c".repeat(32)}`;
    expect((await handleWrap(batchDeps(), "7", encode(eip3009Payment(u)))).status).toBe(200);
    expect((await handleWrap(batchDeps(), "8", encode(eip3009Payment(u, { nonce: NONCE_B }, { resource: resourceFor(8) })))).status).toBe(200);
    const third = await handleWrap(batchDeps(), "9", encode(eip3009Payment(u, { nonce: NONCE_C }, { resource: resourceFor(9) })));
    expect(third).toEqual({ status: 502, body: { ok: false, error: "settlement_unexpected" } });
    expect(await isWrapped(batchStore, VAULT, 9n)).toBe(false);

    // A replay after the mark write failed still marks: the Transfer is bound to this very gift.
    let storeDown = true;
    const inner = createMemoryStore(() => START_MS);
    const flaky: KvStore = { ...inner, set: async (k, v, ttl) => (storeDown ? Promise.reject(new Error("store down")) : inner.set(k, v, ttl)) };
    const replayApi = b402();
    const header = encode(eip3009Payment(u));
    expect((await handleWrap(wrapDeps(replayApi.api, { store: flaky }), "7", header)).status).toBe(503);
    storeDown = false;
    expect(await handleWrap(wrapDeps(replayApi.api, { store: flaky }), "7", header)).toMatchObject({ status: 200, body: { ok: true, txHash: TX } });
    expect(await isWrapped(flaky, VAULT, 7n)).toBe(true);
  });

  it("binds a payment nonce per payer, so two senders paying with the same Permit2 nonce both wrap, and one sender cannot reuse theirs", async () => {
    // Two payments, two settlements: b402 names a different hash for each and the chain shows a
    // receipt under that hash.
    const TX2 = `0x${"ef".repeat(32)}`;
    const { api, count } = b402({ settle: [SETTLED, { ...SETTLED, transaction: TX2 }] });
    const store = createMemoryStore(() => START_MS);
    const paidInUsdt = (hash: Hex) => receiptWith([transferLog(asset("USDT"), PAY_TO, PRICE_UNITS)], "success", hash);
    const client = fakeClient(STATE.Open, undefined, 86_400n, paidInUsdt);
    const usdt = byMethod(await requirementsOf(api), "USDT", "permit2-exact");
    // Permit2 nonces are chosen by each wallet, often counting from zero, so two wallets collide.
    expect((await handleWrap(wrapDeps(api, { store, client }), "7", encode(permit2Payment(usdt, { nonce: "0" })))).status).toBe(200);
    const other = { ...permit2Payment(usdt, { nonce: "0", from: ATTACKER }), resource: resourceFor(8) };
    expect((await handleWrap(wrapDeps(api, { store, client }), "8", encode(other))).status).toBe(200);
    expect(await isWrapped(store, VAULT, 8n)).toBe(true);
    expect(count("/api/v2/b402/settle")).toBe(2);
    // The same wallet replaying its own nonce for a third gift is still refused before verify.
    const replay = { ...permit2Payment(usdt, { nonce: "0" }), resource: resourceFor(9) };
    expect((await handleWrap(wrapDeps(api, { store, client }), "9", encode(replay))).body).toMatchObject({ error: "payment_reused" });
    expect(count("/api/v2/b402/verify")).toBe(2);
  });

  it("refuses to read or mark anything when its node is not on chain 56 (C45)", async () => {
    const { api, calls } = b402();
    const wrongChain = fakeClient(STATE.Open, undefined, 86_400n, PAID_IN_U, 97);
    const deps = wrapDeps(api, { client: wrongChain });
    expect(await handleWrap(deps, "7", null)).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
    const u = byMethod(await requirementsOf(b402().api), "U", "eip3009");
    expect(await handleWrap(deps, "7", encode(eip3009Payment(u)))).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
    expect(calls).toEqual([]);
    expect(await isWrapped(deps.store, VAULT, 7n)).toBe(false);
  });

  it("lets only one of two different payments for one gift reach settle", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api, count } = b402({
      settle: [
        async () => {
          await gate;
          return structuredClone(SETTLED);
        },
      ],
    });
    const deps = wrapDeps(api);
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const first = handleWrap(deps, "7", encode(eip3009Payment(u)));
    const second = handleWrap(deps, "7", encode(eip3009Payment(u, { nonce: NONCE_B })));
    const loser = await Promise.race([first, second]);
    expect(loser).toEqual({ status: 409, body: { ok: false, error: "wrap_in_progress" } });
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(count("/api/v2/b402/settle")).toBe(1);
  });

  it("refuses a bad id, a missing or closed gift, and fails closed when the chain, store or b402 cannot answer", async () => {
    const { api } = b402();
    expect((await handleWrap(wrapDeps(api), "07", null)).body).toEqual({ ok: false, error: "bad_gift_id" });
    expect((await handleWrap(wrapDeps(api), "0x7", null)).status).toBe(400);
    expect(await handleWrap(wrapDeps(api, { client: fakeClient(STATE.None) }), "7", null)).toEqual({ status: 404, body: { ok: false, error: "gift_not_found" } });
    for (const state of [STATE.Claimed, STATE.Refunded]) {
      expect(await handleWrap(wrapDeps(api, { client: fakeClient(state) }), "7", null)).toEqual({ status: 409, body: { ok: false, error: "gift_not_open" } });
    }
    const chainDown = await handleWrap(wrapDeps(api, { client: fakeClient(STATE.Open, new Error("rpc https://secret-node.example down")) }), "7", null);
    expect(chainDown).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });

    const broken: KvStore = { ...createMemoryStore(), get: async () => Promise.reject(new Error("store down")) };
    expect((await handleWrap(wrapDeps(api, { store: broken }), "7", null)).body).toEqual({ ok: false, error: "store_unavailable" });
    const u = byMethod(await requirementsOf(api), "U", "eip3009");
    const noWrites: KvStore = { ...createMemoryStore(), setNx: async () => Promise.reject(new Error("store down")) };
    const { api: api2, count } = b402();
    expect((await handleWrap(wrapDeps(api2, { store: noWrites }), "7", encode(eip3009Payment(u)))).body).toEqual({ ok: false, error: "store_unavailable" });
    expect(count("/api/v2/b402/verify")).toBe(0);

    const corrupt = createMemoryStore();
    await corrupt.set(keys.wrapped(VAULT, 7n), '{"txHash":"not a hash"}');
    expect((await handleWrap(wrapDeps(api, { store: corrupt }), "7", null)).body).toEqual({ ok: false, error: "store_unavailable" });

    const noB402 = b402();
    const down: Web3Api = { ...noB402.api, post: async () => Promise.reject(new Error("b402 down")) };
    expect((await handleWrap(wrapDeps(down), "7", null)).body).toEqual({ ok: false, error: "facilitator_unavailable" });
    // b402's own error text (errorData, kept for the call log) never reaches the body (C19).
    const denied = new Web3ApiError("/api/v2/b402/verify", 200, "40104", "No permission: B402 for merchant 1234");
    const deniedApi: Web3Api = { ...noB402.api, post: async (path, body) => (path === "/api/v2/b402/verify" ? Promise.reject(denied) : noB402.api.post(path, body)) };
    const deniedRes = await handleWrap(wrapDeps(deniedApi), "7", encode(eip3009Payment(u)));
    expect(deniedRes).toEqual({ status: 502, body: { ok: false, error: "facilitator_unavailable" } });
    expect(JSON.stringify(deniedRes)).not.toContain("permission");
    expect((await handleWrap(wrapDeps(api, { settleBudgetMs: 0 }), "7", null)).status).toBe(500);
    const empty: Web3Api = { ...noB402.api, post: async () => ({ kinds: [] }) };
    expect((await handleWrap(wrapDeps(empty), "7", null)).body).toEqual({ ok: false, error: "facilitator_unavailable" });
    expect((await handleWrap(wrapDeps(api, { payTo: "0x0000000000000000000000000000000000000000" as Address }), "7", null)).body).toEqual({ ok: false, error: "server_misconfigured" });
    expect((await handleWrap(wrapDeps(api, { origin: "http://moi.example" }), "7", null)).status).toBe(500);
  });
});

describe("isWrapped", () => {
  it("is true only for a settlement record, never for a lock, a missing key or a malformed value", async () => {
    const store = createMemoryStore();
    const k = keys.wrapped(VAULT, 7n);
    expect(await isWrapped(store, VAULT, 7n)).toBe(false);
    const record = { txHash: TX, asset: asset("U"), amount: "50000000000000000", settledAt: new Date(START_MS).toISOString() };
    const values = [
      JSON.stringify({ lock: "6f1c2b4e-8a7d-4c3b-9e2f-1a2b3c4d5e6f", payment: NONCE_A }),
      JSON.stringify({ ...record, txHash: TX.toUpperCase().replace("0X", "0x") }),
      JSON.stringify({ ...record, asset: NVDAB }),
      JSON.stringify({ ...record, extra: true }),
      JSON.stringify({ ...record, amount: "05" }),
      "true",
      "not json",
    ];
    for (const v of values) {
      await store.set(k, v);
      expect(await isWrapped(store, VAULT, 7n)).toBe(false);
    }
    await store.set(k, JSON.stringify(record));
    expect(await isWrapped(store, VAULT, 7n)).toBe(true);
    expect(await isWrapped(store, VAULT, 8n)).toBe(false);
    const down: KvStore = { ...store, get: async () => Promise.reject(new Error("store down")) };
    await expect(isWrapped(down, VAULT, 7n)).rejects.toThrow("store down");
  });
});
