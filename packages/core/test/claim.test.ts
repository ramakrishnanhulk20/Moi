// Not covered here: a real node, a real vault and the HTTP layer. The client is a fake that serves
// gift records, block time and account code, and the relayer is either a stub (to drive every
// error path) or the real relayer over fake chain calls. Body size limits, rate limits and how the
// route reads the platform's country header belong to the route, not to handleClaim.
// test/claim.fork.test.ts runs handleClaim against a BSC fork.
import {
  getAddress,
  keccak256,
  type Address,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { handleClaim } from "../src/claim.js";
import { newClaimKey, signClaim } from "../src/gift.js";
import {
  ClaimRefusedError,
  createRelayer,
  DailyCapReachedError,
  GasPriceTooHighError,
  RelayerBusyError,
} from "../src/relayer.js";
import { createMemoryStore, keys, StoreError, type KvStore } from "../src/store.js";
import type { VaultErrorName } from "../src/vault.js";

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const SENDER = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const NOW = 1_800_000_000n;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const STATE = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;

// The one claim key every gift in this file stores, so goodBody's signatures match the gift.
const KEY = newClaimKey();

// Every gift here comes from SENDER, so naming SENDER as the sponsor passes the wrap gate (C24) and
// leaves the other checks to the tests that target them. The gate's own tests use their own store.
const SPONSORED = { store: createMemoryStore(), sponsor: SENDER as Address | null };

type World = {
  state: number;
  expiry: bigint;
  blockTime: bigint;
  code: Record<string, Hex | undefined>;
  compliant: boolean;
  claimKey: Hex;
  readFails?: Error;
  callDelayMs?: number;
};

function world(overrides: Partial<World> = {}): World {
  return { state: STATE.Open, expiry: NOW + 86_400n, blockTime: NOW, code: {}, compliant: true, claimKey: KEY.address, ...overrides };
}

// One fake serves both the reads handleClaim makes and the calls the real relayer makes.
// `rpc` counts every method called, so a test can prove which calls a request never made.
function fakeClient(w: World, sent: Hex[] = []) {
  const rpc: string[] = [];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      rpc.push(functionName);
      if (w.readFails) throw w.readFails;
      if (functionName === "getGift") {
        return { token: NVDAB, sender: SENDER, claimKey: w.claimKey, expiry: w.expiry, state: w.state, amount: 10n ** 15n, sealedNote: "0x" };
      }
      if (functionName === "senderIsCompliant") return w.compliant;
      throw new Error(`unexpected read ${functionName}`);
    },
    getBlock: async () => {
      rpc.push("getBlock");
      return { timestamp: w.blockTime };
    },
    getCode: async ({ address }: { address: Hex }) => {
      rpc.push("getCode");
      return w.code[getAddress(address)];
    },
    getChainId: async () => 56,
    call: async () => {
      rpc.push("call");
      if (w.callDelayMs) await new Promise((r) => setTimeout(r, w.callDelayMs));
      return { data: undefined };
    },
    estimateGas: async () => 117_000n,
    getGasPrice: async () => 50_000_000n,
    getTransactionCount: async () => sent.length,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!sent.some((raw) => keccak256(raw) === hash)) throw new TransactionNotFoundError({ hash });
      return { hash };
    },
  } as unknown as PublicClient;
  const walletClient = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
  } as unknown as WalletClient;
  return { client, walletClient, rpc };
}

// A memory store that records every lock attempt, so a test can prove none was taken.
function countingStore() {
  const inner = createMemoryStore();
  const locks: string[] = [];
  const store: KvStore = { ...inner, setNx: async (k, v, ttl) => (locks.push(k), inner.setNx(k, v, ttl)) };
  return { store, locks };
}

function realRelayer(client: PublicClient, walletClient: WalletClient, store: KvStore = createMemoryStore()) {
  return createRelayer({
    account: privateKeyToAccount(generatePrivateKey()),
    client,
    walletClient,
    vault: VAULT,
    store,
    maxGasPriceWei: 3_000_000_000n,
    dailyCapWei: 10n ** 16n,
    allowMemoryStore: true,
  });
}

type Submitted = { giftId: bigint; recipient: Hex; signature: Hex };

function stubRelayer(outcome: { txHash: Hex; reused: boolean } | Error, seen: Submitted[] = []) {
  return {
    submitClaim: async (input: Submitted) => {
      seen.push(input);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as ReturnType<typeof createRelayer>;
}

async function goodBody(giftId = 9n, key: Hex = KEY.privateKey) {
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const signature = await signClaim(key, VAULT, 56, giftId, recipient);
  return { giftId: giftId.toString(), recipient, signature, declaration: true as const };
}

// The same signature with s replaced by n - s and v flipped: it recovers to the same key, but the
// vault (OpenZeppelin ECDSA) refuses a high s.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function highSTwin(signature: Hex): Hex {
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130) === "1b" ? "1c" : "1b";
  return `${signature.slice(0, 66)}${(SECP256K1_N - s).toString(16).padStart(64, "0")}${v}` as Hex;
}

const IN = { country: "IN" };

describe("handleClaim", () => {
  it("submits a valid claim with parsed values and answers 200", async () => {
    const seen: Submitted[] = [];
    const body = await goodBody();
    const res = await handleClaim(
      { client: fakeClient(world()).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer({ txHash: TX_HASH, reused: false }, seen) },
      { ...body, recipient: body.recipient.toLowerCase(), signature: body.signature.toUpperCase().replace("0X", "0x") },
      IN,
    );
    expect(res).toEqual({ status: 200, body: { ok: true, txHash: TX_HASH, reused: false } });
    expect(seen).toEqual([{ giftId: 9n, recipient: body.recipient, signature: body.signature.toLowerCase() }]);
  });

  it("refuses each malformed field with its own code and never reaches the relayer", async () => {
    const seen: Submitted[] = [];
    const deps = { client: fakeClient(world()).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer({ txHash: TX_HASH, reused: false }, seen) };
    const good = await goodBody();
    const cases: [unknown, number, string][] = [
      [null, 400, "bad_request"],
      ["giftId=9", 400, "bad_request"],
      [[good], 400, "bad_request"],
      [{ ...good, extra: 1 }, 400, "bad_request"],
      [{ ...good, giftId: "09" }, 400, "bad_gift_id"],
      [{ ...good, giftId: "0" }, 400, "bad_gift_id"],
      [{ ...good, giftId: "-9" }, 400, "bad_gift_id"],
      [{ ...good, giftId: "0x9" }, 400, "bad_gift_id"],
      [{ ...good, giftId: 9 }, 400, "bad_gift_id"],
      [{ ...good, giftId: "9".repeat(79) }, 400, "bad_gift_id"],
      [{ ...good, recipient: "0x1234" }, 400, "bad_recipient"],
      [{ ...good, recipient: `${good.recipient} ` }, 400, "bad_recipient"],
      [{ ...good, recipient: zeroAddress }, 400, "bad_recipient"],
      [{ ...good, signature: good.signature.slice(0, 130) }, 400, "bad_signature"],
      [{ ...good, signature: `${good.signature}00` }, 400, "bad_signature"],
      [{ ...good, signature: good.signature.slice(2) }, 400, "bad_signature"],
      [{ ...good, signature: `0x${"zz".repeat(65)}` }, 400, "bad_signature"],
      [{ ...good, declaration: "true" }, 403, "no_declaration"],
      [{ ...good, declaration: false }, 403, "no_declaration"],
      [{ giftId: good.giftId, recipient: good.recipient, signature: good.signature }, 403, "no_declaration"],
    ];
    for (const [body, status, error] of cases) {
      expect(await handleClaim(deps, body, IN)).toEqual({ status, body: { ok: false, error } });
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses restricted and unknown places, and allows an unknown place only with the dev flag", async () => {
    const deps = { client: fakeClient(world()).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer({ txHash: TX_HASH, reused: false }) };
    const body = await goodBody();
    expect(await handleClaim(deps, body, { country: "US" })).toEqual({ status: 403, body: { ok: false, error: "restricted_place" } });
    expect(await handleClaim(deps, body, { country: "UA", region: "43" })).toEqual({ status: 403, body: { ok: false, error: "restricted_place" } });
    expect(await handleClaim(deps, body, {})).toEqual({ status: 403, body: { ok: false, error: "unknown_place" } });
    expect((await handleClaim({ ...deps, devAllowUnknownCountry: true }, body, {})).status).toBe(200);
  });

  it("refuses a gift that is not open or has expired by block time", async () => {
    const relayer = stubRelayer({ txHash: TX_HASH, reused: false });
    const body = await goodBody();
    const run = (w: World) => handleClaim({ client: fakeClient(w).client, vault: VAULT, ...SPONSORED, relayer }, body, IN);
    expect(await run(world({ state: STATE.None }))).toEqual({ status: 409, body: { ok: false, error: "gift_not_open" } });
    expect(await run(world({ state: STATE.Refunded }))).toEqual({ status: 409, body: { ok: false, error: "gift_not_open" } });
    expect(await run(world({ expiry: NOW }))).toEqual({ status: 409, body: { ok: false, error: "gift_expired" } });
    expect((await run(world({ expiry: NOW + 1n }))).status).toBe(200);
    expect(await run(world({ state: 9 }))).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
  });

  it("refuses a contract recipient and accepts a plain or EIP-7702 delegated account", async () => {
    const relayer = stubRelayer({ txHash: TX_HASH, reused: false });
    const body = await goodBody();
    const run = (code: Hex | undefined) =>
      handleClaim({ client: fakeClient(world({ code: { [body.recipient]: code } })).client, vault: VAULT, ...SPONSORED, relayer }, body, IN);
    const delegate = "c0ffee254729296a45a3885639ac7e10f9d54979";
    expect(await run("0x6080604052" as Hex)).toEqual({ status: 400, body: { ok: false, error: "bad_recipient" } });
    expect(await run(`0xef0100${delegate}00` as Hex)).toEqual({ status: 400, body: { ok: false, error: "bad_recipient" } });
    expect(await run(`0xef0100${delegate.slice(2)}` as Hex)).toEqual({ status: 400, body: { ok: false, error: "bad_recipient" } });
    expect((await run(`0xef0100${delegate}` as Hex)).status).toBe(200);
    expect((await run(`0xEF0100${delegate.toUpperCase()}` as Hex)).status).toBe(200);
    expect((await run("0x" as Hex)).status).toBe(200);
    expect((await run(undefined)).status).toBe(200);
  });

  it("refuses while the vault's compliance check refuses the original sender", async () => {
    const deps = { client: fakeClient(world({ compliant: false })).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer({ txHash: TX_HASH, reused: false }) };
    expect(await handleClaim(deps, await goodBody(), IN)).toEqual({ status: 409, body: { ok: false, error: "sender_blocked" } });
  });

  it("maps every relayer and chain failure to a fixed code without leaking its text", async () => {
    const leak = "upstream said: key sk-live-0001 at https://node.example";
    const vaultCases: [VaultErrorName | null, number, string][] = [
      ["GiftNotOpen", 409, "gift_not_open"],
      ["GiftExpired", 409, "gift_expired"],
      ["BadRecipient", 400, "bad_recipient"],
      ["BadSigner", 400, "bad_signature"],
      ["ECDSAInvalidSignature", 400, "bad_signature"],
      ["ECDSAInvalidSignatureLength", 400, "bad_signature"],
      ["ECDSAInvalidSignatureS", 400, "bad_signature"],
      ["SenderNotCompliant", 409, "sender_blocked"],
      ["EnforcedPause", 409, "claims_paused"],
      ["NotRelayer", 502, "relayer_unavailable"],
      ["SafeERC20FailedOperation", 409, "claim_refused"],
      [null, 409, "claim_refused"],
    ];
    const cases: [Error, number, string][] = [
      ...vaultCases.map(([name, status, code]): [Error, number, string] => [new ClaimRefusedError(name), status, code]),
      [new ClaimRefusedError(null, "GiftExpiring"), 409, "gift_expiring"],
      [new ClaimRefusedError(null, "TooManyAttempts"), 409, "too_many_attempts"],
      [new RelayerBusyError(), 429, "busy"],
      [new DailyCapReachedError(), 429, "daily_cap"],
      [new GasPriceTooHighError(), 502, "gas_price_high"],
      [new StoreError(leak), 502, "store_unavailable"],
      [new Error(leak), 502, "chain_unavailable"],
    ];
    const body = await goodBody();
    for (const [err, status, error] of cases) {
      const res = await handleClaim({ client: fakeClient(world()).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer(err) }, body, IN);
      expect(res).toEqual({ status, body: { ok: false, error } });
    }
    const readFailure = await handleClaim(
      { client: fakeClient(world({ readFails: new Error(leak) })).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer({ txHash: TX_HASH, reused: false }) },
      body,
      IN,
    );
    expect(readFailure).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
    expect(JSON.stringify(readFailure)).not.toContain("sk-live");
  });

  it("refuses a relayer answer that is not a transaction hash", async () => {
    const deps = { client: fakeClient(world()).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer({ txHash: "0x1234" as Hex, reused: false }) };
    expect(await handleClaim(deps, await goodBody(), IN)).toEqual({ status: 502, body: { ok: false, error: "relayer_unavailable" } });
  });

  it("refuses a signature that does not recover to the gift's claim key: no lock, no simulation, no other chain call (C36)", async () => {
    const good = await goodBody();
    const junk = [
      (await goodBody(9n, newClaimKey().privateKey)).signature,
      highSTwin(good.signature),
      `${good.signature.slice(0, 130)}00` as Hex,
      `${good.signature.slice(0, 130)}01` as Hex,
      `0x${"00".repeat(65)}` as Hex,
      (await goodBody(10n)).signature,
    ];
    for (const state of [STATE.Open, STATE.Claimed]) {
      for (const signature of junk) {
        const { client, walletClient, rpc } = fakeClient(world({ state }));
        const { store, locks } = countingStore();
        const res = await handleClaim({ client, vault: VAULT, ...SPONSORED, relayer: realRelayer(client, walletClient, store) }, { ...good, signature }, IN);
        expect(res).toEqual({ status: 400, body: { ok: false, error: "bad_signature" } });
        expect(locks).toEqual([]);
        expect(rpc).toEqual(["getGift"]);
      }
    }
    // The real signature still passes the same check.
    expect((await handleClaim({ client: fakeClient(world()).client, vault: VAULT, ...SPONSORED, relayer: stubRelayer({ txHash: TX_HASH, reused: false }) }, good, IN)).status).toBe(200);
  });

  it("answers gift_expiring, with no simulation and nothing sent, 59 seconds before expiry (C37)", async () => {
    const sent: Hex[] = [];
    const { client, walletClient, rpc } = fakeClient(world({ expiry: NOW + 59n }), sent);
    const res = await handleClaim({ client, vault: VAULT, ...SPONSORED, relayer: realRelayer(client, walletClient) }, await goodBody(), IN);
    expect(res).toEqual({ status: 409, body: { ok: false, error: "gift_expiring" } });
    expect(rpc).not.toContain("call");
    expect(sent).toHaveLength(0);
  });

  it("lets a valid claim through while junk claims for the same gift arrive alongside it (no busy)", async () => {
    const sent: Hex[] = [];
    const { client, walletClient } = fakeClient(world({ callDelayMs: 50 }), sent);
    const relayer = realRelayer(client, walletClient);
    const good = await goodBody();
    const junk = { ...good, signature: (await goodBody(9n, newClaimKey().privateKey)).signature };
    const results = await Promise.all([junk, junk, good, junk].map((b) => handleClaim({ client, vault: VAULT, ...SPONSORED, relayer }, b, IN)));
    expect(results.map((r) => r.status)).toEqual([400, 400, 200, 400]);
    expect(results[2]?.body).toMatchObject({ ok: true, reused: false });
    expect(sent).toHaveLength(1);
  });

  it("returns the stored hash, not a new transaction, when the gift is already claimed", async () => {
    const w = world();
    const sent: Hex[] = [];
    const { client, walletClient } = fakeClient(w, sent);
    const relayer = realRelayer(client, walletClient);
    const body = await goodBody();
    const first = await handleClaim({ client, vault: VAULT, ...SPONSORED, relayer }, body, IN);
    expect(first.status).toBe(200);
    w.state = STATE.Claimed;
    const second = await handleClaim({ client, vault: VAULT, ...SPONSORED, relayer }, body, IN);
    expect(second).toEqual({ status: 200, body: { ok: true, txHash: (first.body as { txHash: Hex }).txHash, reused: true } });
    expect(sent).toHaveLength(1);
  });

  it("refuses an unwrapped gift with 402 before the signature check, and passes a wrapped or a sponsor gift (C24)", async () => {
    const seen: Submitted[] = [];
    const good = await goodBody();
    const junk = { ...good, signature: (await goodBody(9n, newClaimKey().privateKey)).signature };
    const other = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
    const run = async (gate: { store: KvStore; sponsor: Address | null }, body = good, w = world()) => {
      const { client, rpc } = fakeClient(w);
      const res = await handleClaim({ client, vault: VAULT, relayer: stubRelayer({ txHash: TX_HASH, reused: false }, seen), ...gate }, body, IN);
      return { res, rpc };
    };
    const notWrapped = { status: 402, body: { ok: false, error: "gift_not_wrapped" } };
    const store = createMemoryStore();
    for (const sponsor of [null, other]) {
      for (const body of [good, junk]) {
        const { res, rpc } = await run({ store, sponsor }, body);
        expect(res).toEqual(notWrapped);
        expect(rpc).toEqual(["getGift"]);
      }
      expect((await run({ store, sponsor }, good, world({ state: STATE.Claimed }))).res).toEqual(notWrapped);
    }
    // A wrap still settling holds a lock under the same key; it is not a wrap.
    await store.set(keys.wrapped(VAULT, 9n), JSON.stringify({ lock: "6f1c2b4e-8a7d-4c3b-9e2f-1a2b3c4d5e6f", payment: `0x${"0a".repeat(32)}` }));
    expect((await run({ store, sponsor: null })).res).toEqual(notWrapped);
    expect(seen).toHaveLength(0);

    const record = { txHash: `0x${"cd".repeat(32)}`, asset: "0xcE24439F2D9C6a2289F741120FE202248B666666", amount: "50000000000000000", settledAt: "2026-10-07T12:00:00.000Z" };
    await store.set(keys.wrapped(VAULT, 9n), JSON.stringify(record));
    expect((await run({ store, sponsor: null })).res.status).toBe(200);
    // The wrapped gift still needs its own claim key's signature.
    expect((await run({ store, sponsor: null }, junk)).res).toEqual({ status: 400, body: { ok: false, error: "bad_signature" } });
    // The sponsor's gift passes on an empty store, whatever case the address is written in.
    expect((await run({ store: createMemoryStore(), sponsor: SENDER.toLowerCase() as Address })).res.status).toBe(200);
    expect(seen).toHaveLength(2);

    const down: KvStore = { ...createMemoryStore(), get: async () => Promise.reject(new StoreError("store down sk-live-0001")) };
    const failed = (await run({ store: down, sponsor: null })).res;
    expect(failed).toEqual({ status: 502, body: { ok: false, error: "store_unavailable" } });
    expect((await run({ store: down, sponsor: SENDER })).res.status).toBe(200);
  });
});
