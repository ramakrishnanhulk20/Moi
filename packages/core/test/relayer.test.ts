// Not covered here: a real node. The public and wallet clients are fakes that answer the calls
// the relayer makes, so this proves the relayer's order of operations, its locks, its spend cap
// and the transaction it signs, not how a live node or mempool behaves. test/claim.fork.test.ts
// runs the same code against a BSC fork. Cross-process locking needs a shared store (Upstash);
// these tests use the in-process memory store.
import {
  CallExecutionError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  ExecutionRevertedError,
  getAddress,
  HttpRequestError,
  InvalidInputRpcError,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  RpcRequestError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GasLimitError, gasLimitFor } from "../src/gas.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { newClaimKey, signClaim } from "../src/gift.js";
import {
  ClaimRefusedError,
  confirmClaim,
  createRelayer,
  DailyCapReachedError,
  GasPriceTooHighError,
  RelayerBusyError,
  RelayerInputError,
} from "../src/relayer.js";
import { createMemoryStore, createUpstashStore, isSharedStore, keys, StoreError, type KvStore } from "../src/store.js";
import { decodeVaultError } from "../src/vault.js";

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const OTHER_VAULT = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const DAY = new Date("2026-10-07T12:00:00.000Z");
const BLOCK_TIME = 1_791_374_400n;
const GAS_ESTIMATE = 117_000n;
const PADDED_GAS = (GAS_ESTIMATE * 13n) / 10n;
const GAS_PRICE = 50_000_000n;
const relayerAccount = privateKeyToAccount(generatePrivateKey());

type FakeOptions = {
  revert?: Hex;
  rpcDown?: boolean;
  gasEstimate?: bigint;
  gasPrice?: bigint;
  chainId?: number;
  sendDelayMs?: number;
  nonceFails?: boolean;
  rebroadcastFails?: boolean;
  revertOnce?: Hex;
  callDelayMs?: number;
  stalePendingCount?: number;
  alreadyKnown?: boolean;
  lookupBlind?: boolean;
};

const STATE = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;

function revertError(data: Hex): Error {
  const rpc = new RpcRequestError({ body: {}, error: { code: 3, message: "execution reverted", data }, url: "http://fake-node" });
  return new CallExecutionError(new ExecutionRevertedError({ cause: rpc, message: "execution reverted" }), { to: VAULT });
}

// A node and a vault in one fake. Every broadcast transaction is pending until a test gives it a
// receipt or drops it; `gift` is what getGift answers for any id. `tried` is every send attempt,
// `sent` every one the node took; `node.pending`, when set, is the pending count it reports.
// The mined count is `node.latest` when set, else 7 plus the receipts given, and the node refuses
// any send below it with "nonce too low", as a real one does.
// alreadyKnown makes the node refuse bytes it holds with geth's "already known"; lookupBlind makes
// every hash lookup miss, as a load-balanced node can.
function fakeChain(o: FakeOptions = {}) {
  const sent: Hex[] = [];
  const tried: Hex[] = [];
  const node = { pending: null as number | null, latest: null as number | null };
  const calls: unknown[] = [];
  const receipts = new Map<Hex, "success" | "reverted">();
  const dropped = new Set<Hex>();
  const gift = { state: STATE.Open as number, expiry: BLOCK_TIME + 86_400n };
  const block = { timestamp: BLOCK_TIME };
  let nonce = 7;
  let revertedOnce = false;
  const mined = () => node.latest ?? 7 + receipts.size;
  const known = (hash: Hex) => sent.some((raw) => keccak256(raw) === hash) && !dropped.has(hash);
  const client = {
    getChainId: async () => o.chainId ?? 56,
    call: async (args: unknown) => {
      calls.push(args);
      if (o.callDelayMs) await new Promise((r) => setTimeout(r, o.callDelayMs));
      if (o.rpcDown) throw new HttpRequestError({ url: "http://fake-node", details: "timeout" });
      if (o.revert) throw revertError(o.revert);
      if (o.revertOnce && !revertedOnce) {
        revertedOnce = true;
        throw revertError(o.revertOnce);
      }
      return { data: undefined };
    },
    estimateGas: async () => o.gasEstimate ?? GAS_ESTIMATE,
    getGasPrice: async () => o.gasPrice ?? GAS_PRICE,
    getTransactionCount: async ({ blockTag }: { blockTag?: string }) => {
      if (o.nonceFails) throw new HttpRequestError({ url: "http://fake-node", details: "timeout" });
      if (blockTag === "latest") return mined();
      return o.stalePendingCount ?? node.pending ?? nonce;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const status = receipts.get(hash);
      if (status === undefined) throw new TransactionReceiptNotFoundError({ hash });
      return { status, transactionHash: hash };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (o.lookupBlind || !known(hash)) throw new TransactionNotFoundError({ hash });
      return { hash };
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName !== "getGift") throw new Error(`unexpected read ${functionName}`);
      return { token: VAULT, sender: VAULT, claimKey: VAULT, expiry: gift.expiry, state: gift.state, amount: 1n, sealedNote: "0x" };
    },
    getBlock: async () => ({ timestamp: block.timestamp }),
  } as unknown as PublicClient;
  const walletClient = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      if (o.sendDelayMs) await new Promise((r) => setTimeout(r, o.sendDelayMs));
      tried.push(serializedTransaction);
      if ((parseTransaction(serializedTransaction).nonce ?? 0) < mined()) {
        throw new InvalidInputRpcError(new RpcRequestError({ body: {}, error: { code: -32000, message: "nonce too low" }, url: "http://fake-node" }));
      }
      const hash = keccak256(serializedTransaction);
      const again = sent.some((raw) => keccak256(raw) === hash);
      if (again && o.rebroadcastFails) throw new Error("node refused the bytes");
      if (again && o.alreadyKnown && !dropped.has(hash)) {
        throw new InvalidInputRpcError(new RpcRequestError({ body: {}, error: { code: -32000, message: "already known" }, url: "http://fake-node" }));
      }
      sent.push(serializedTransaction);
      dropped.delete(hash);
      if (!again) nonce += 1;
      return hash;
    },
  } as unknown as WalletClient;
  return { client, walletClient, sent, tried, node, calls, receipts, dropped, gift, block };
}

const recordIn = async (store: KvStore, giftId = 1n, vault: Hex = VAULT) => JSON.parse((await store.get(keys.claim(vault, giftId))) ?? "null");

function relayerFor(
  chain: ReturnType<typeof fakeChain>,
  store: KvStore = createMemoryStore(),
  extra: { dailyCapWei?: bigint; maxGasPriceWei?: bigint; vault?: Hex } = {},
) {
  return createRelayer({
    account: relayerAccount,
    client: chain.client,
    walletClient: chain.walletClient,
    vault: extra.vault ?? VAULT,
    store,
    maxGasPriceWei: extra.maxGasPriceWei ?? 3_000_000_000n,
    dailyCapWei: extra.dailyCapWei ?? 10n ** 16n,
    now: () => DAY,
    allowMemoryStore: true,
  });
}

async function claimInput(giftId = 1n) {
  const key = newClaimKey();
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const signature = await signClaim(key.privateKey, VAULT, 56, giftId, recipient);
  return { giftId, recipient, signature };
}

const vaultError = (name: string) => encodeErrorResult({ abi: giftVaultAbi, errorName: name as "BadSigner" });

async function claimTxData(): Promise<Hex> {
  const input = await claimInput(1n);
  return encodeFunctionData({ abi: giftVaultAbi, functionName: "claim", args: [input.giftId, input.recipient, input.signature] });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("submitClaim", () => {
  it("broadcasts once per gift: a second call returns the same hash with reused true", async () => {
    const chain = fakeChain();
    const relayer = relayerFor(chain);
    const input = await claimInput();
    const first = await relayer.submitClaim(input);
    const second = await relayer.submitClaim(input);
    expect(first.reused).toBe(false);
    expect(second).toEqual({ txHash: first.txHash, reused: true });
    expect(chain.sent).toHaveLength(1);
    expect(first.txHash).toBe(keccak256(chain.sent[0] as Hex));
  });

  it("never returns a hash stored for one vault to a claim on another vault with the same gift id", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const onA = await relayerFor(chain, store).submitClaim(await claimInput(1n));
    const onB = await relayerFor(chain, store, { vault: OTHER_VAULT }).submitClaim(await claimInput(1n));
    expect(onB.reused).toBe(false);
    expect(onB.txHash).not.toBe(onA.txHash);
    expect(chain.sent).toHaveLength(2);
    expect(parseTransaction(chain.sent[1] as Hex).to).toBe(OTHER_VAULT.toLowerCase());
    expect((await recordIn(store, 1n, VAULT)).hash).toBe(onA.txHash);
    expect((await recordIn(store, 1n, OTHER_VAULT)).hash).toBe(onB.txHash);
  });

  it("stores {hash, raw, sentAt, attempts}: the signed bytes that hash to the returned hash, the send time and attempt 1 (C35)", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const { txHash } = await relayerFor(chain, store).submitClaim(await claimInput());
    expect(await recordIn(store)).toEqual({ hash: txHash, raw: chain.sent[0], sentAt: DAY.toISOString(), attempts: 1 });
    expect(keccak256(chain.sent[0] as Hex)).toBe(txHash);
  });

  it("returns a pending or successful claim without sending again", async () => {
    const chain = fakeChain();
    const relayer = relayerFor(chain);
    const input = await claimInput();
    const { txHash } = await relayer.submitClaim(input);
    expect(await relayer.submitClaim(input)).toEqual({ txHash, reused: true });
    chain.receipts.set(txHash, "success");
    chain.gift.state = STATE.Claimed;
    expect(await relayer.submitClaim(input)).toEqual({ txHash, reused: true });
    expect(chain.sent).toHaveLength(1);
  });

  it("claims again when the stored claim reverted and the gift is still Open (C35)", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const relayer = relayerFor(chain, store);
    const input = await claimInput();
    const first = await relayer.submitClaim(input);
    chain.receipts.set(first.txHash, "reverted");
    const retry = await relayer.submitClaim(input);
    expect(retry.reused).toBe(false);
    expect(retry.txHash).not.toBe(first.txHash);
    expect(chain.sent).toHaveLength(2);
    expect(parseTransaction(chain.sent[1] as Hex).nonce).toBe(8);
    expect((await recordIn(store)).hash).toBe(retry.txHash);
    expect(await relayer.submitClaim(input)).toEqual({ txHash: retry.txHash, reused: true });
    expect(chain.sent).toHaveLength(2);
  });

  it("sends one new claim, not two, when two requests find the same reverted claim at once", async () => {
    const chain = fakeChain({ sendDelayMs: 50 });
    const relayer = relayerFor(chain);
    const input = await claimInput();
    const first = await relayer.submitClaim(input);
    chain.receipts.set(first.txHash, "reverted");
    const results = await Promise.all([relayer.submitClaim(input), relayer.submitClaim(input)]);
    expect(chain.sent).toHaveLength(2);
    expect(results[0].txHash).toBe(results[1].txHash);
    expect(results[0].txHash).not.toBe(first.txHash);
    expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
  });

  it("refuses a gift's fourth claim after three reverted ones, sending nothing, and a refusal in between does not reset the count", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const relayer = relayerFor(chain, store);
    const input = await claimInput();
    const first = await relayer.submitClaim(input);
    chain.receipts.set(first.txHash, "reverted");

    chain.gift.expiry = BLOCK_TIME + 30n;
    await expect(relayer.submitClaim(input)).rejects.toMatchObject({ name: "GiftExpiring" });
    expect((await recordIn(store)).attempts).toBe(1);
    chain.gift.expiry = BLOCK_TIME + 86_400n;

    const second = await relayer.submitClaim(input);
    expect((await recordIn(store)).attempts).toBe(2);
    chain.receipts.set(second.txHash, "reverted");
    const third = await relayer.submitClaim(input);
    expect(await recordIn(store)).toMatchObject({ hash: third.txHash, attempts: 3 });
    chain.receipts.set(third.txHash, "reverted");

    const spent = await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"));
    const calls = chain.calls.length;
    for (let i = 0; i < 2; i++) {
      const err = await relayer.submitClaim(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClaimRefusedError);
      expect((err as ClaimRefusedError).name).toBe("TooManyAttempts");
      expect((err as ClaimRefusedError).vaultError).toBeNull();
    }
    expect(chain.sent).toHaveLength(3);
    expect(chain.calls).toHaveLength(calls);
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBe(spent);
    expect(await store.get(keys.claimLock(VAULT, 1n))).toBeNull();
    expect((await recordIn(store)).hash).toBe(third.txHash);
  });

  it("refuses, sending nothing, when the stored claim reverted and the gift is no longer Open", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const relayer = relayerFor(chain, store);
    const input = await claimInput();
    const first = await relayer.submitClaim(input);
    chain.receipts.set(first.txHash, "reverted");
    for (const state of [STATE.Claimed, STATE.Refunded]) {
      chain.gift.state = state;
      const err = await relayer.submitClaim(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClaimRefusedError);
      expect((err as ClaimRefusedError).vaultError).toBe("GiftNotOpen");
    }
    expect(chain.sent).toHaveLength(1);
    expect((await recordIn(store)).hash).toBe(first.txHash);
  });

  it("rebroadcasts a claim the node does not know from its stored bytes, once, and signs nothing new (C35)", async () => {
    const chain = fakeChain();
    const relayer = relayerFor(chain);
    const input = await claimInput();
    const first = await relayer.submitClaim(input);
    chain.dropped.add(first.txHash);
    expect(await relayer.submitClaim(input)).toEqual({ txHash: first.txHash, reused: true });
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]).toBe(chain.sent[0]);
    // Back in the node's pool, so the next request just reads it.
    expect(await relayer.submitClaim(input)).toEqual({ txHash: first.txHash, reused: true });
    expect(chain.sent).toHaveLength(2);
  });

  it("claims afresh when a dropped claim's nonce was taken by another mined claim after a counter reset, never resending its dead bytes (C35)", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const relayer = relayerFor(chain, store);
    const gift1 = await claimInput(1n);
    const dropped = await relayer.submitClaim(gift1);
    const deadRaw = chain.sent[0] as Hex;
    await relayer.submitClaim(await claimInput(2n));
    chain.dropped.add(dropped.txHash);
    await store.del(keys.relayerTx(relayerAccount.address, 7n));
    chain.node.pending = 7;
    const taker = await relayer.submitClaim(await claimInput(3n));
    expect(parseTransaction(chain.sent.at(-1) as Hex).nonce).toBe(7);
    chain.receipts.set(taker.txHash, "success");
    chain.node.pending = 9;
    const tried = chain.tried.length;

    // The dead record is deleted under the gift lock even when the fresh claim is then refused.
    chain.gift.expiry = BLOCK_TIME + 30n;
    await expect(relayer.submitClaim(gift1)).rejects.toMatchObject({ name: "GiftExpiring" });
    expect(await store.get(keys.claim(VAULT, 1n))).toBeNull();
    chain.gift.expiry = BLOCK_TIME + 86_400n;

    const fresh = await relayer.submitClaim(gift1);
    expect(fresh.reused).toBe(false);
    expect(fresh.txHash).not.toBe(dropped.txHash);
    expect(chain.tried.slice(tried)).toEqual([chain.sent.at(-1)]);
    expect(chain.tried.slice(tried)).not.toContain(deadRaw);
    expect(parseTransaction(chain.sent.at(-1) as Hex).nonce).toBe(9);
    expect(await recordIn(store)).toMatchObject({ hash: fresh.txHash, attempts: 1 });
  });

  it("surfaces the node's error when a rebroadcast fails and the node still does not know the claim", async () => {
    const chain = fakeChain({ rebroadcastFails: true });
    const relayer = relayerFor(chain);
    const input = await claimInput();
    const first = await relayer.submitClaim(input);
    chain.dropped.add(first.txHash);
    await expect(relayer.submitClaim(input)).rejects.toThrow("node refused the bytes");
    expect(chain.sent).toHaveLength(1);
  });

  it("deletes a stored claim record that is not exactly one this code wrote, and treats it as absent", async () => {
    const chain = fakeChain();
    const other = await relayerFor(chain).submitClaim(await claimInput(2n));
    const otherGiftRecord = JSON.stringify({ hash: other.txHash, raw: chain.sent[0], sentAt: DAY.toISOString(), attempts: 1 });
    const raw = chain.sent[0] as Hex;
    const bad = [
      "<script>",
      other.txHash,
      "{}",
      otherGiftRecord,
      JSON.stringify({ hash: `0x${"00".repeat(32)}`, raw, sentAt: DAY.toISOString(), attempts: 1 }),
      JSON.stringify({ hash: keccak256(raw), raw: raw.toUpperCase().replace("0X", "0x"), sentAt: DAY.toISOString(), attempts: 1 }),
      JSON.stringify({ hash: keccak256(raw), raw, sentAt: "yesterday", attempts: 1 }),
      JSON.stringify({ hash: keccak256(raw), raw, sentAt: DAY.toISOString(), attempts: 1, extra: 1 }),
      JSON.stringify({ hash: keccak256(raw), raw, sentAt: DAY.toISOString() }),
      JSON.stringify({ hash: keccak256(raw), raw, sentAt: DAY.toISOString(), attempts: 0 }),
      JSON.stringify({ hash: keccak256(raw), raw, sentAt: DAY.toISOString(), attempts: 4 }),
    ];
    for (const value of bad) {
      const store = createMemoryStore();
      await store.set(keys.claim(VAULT, 1n), value);
      const fresh = fakeChain();
      const result = await relayerFor(fresh, store).submitClaim(await claimInput(1n));
      expect(result.reused).toBe(false);
      expect(fresh.sent).toHaveLength(1);
      expect((await recordIn(store)).hash).toBe(result.txHash);
    }
  });

  it("sends exactly one transaction for two concurrent calls on one gift", async () => {
    const chain = fakeChain({ sendDelayMs: 50 });
    const relayer = relayerFor(chain);
    const input = await claimInput();
    const results = await Promise.all([relayer.submitClaim(input), relayer.submitClaim(input)]);
    expect(chain.sent).toHaveLength(1);
    expect(results[0].txHash).toBe(results[1].txHash);
    expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
  });

  it("signs a zero-value claim to the vault on chain 56 whose calldata decodes to exactly the parsed inputs", async () => {
    const chain = fakeChain();
    const input = await claimInput(42n);
    const upper = { ...input, signature: input.signature.toUpperCase().replace("0X", "0x") as Hex, recipient: input.recipient.toLowerCase() as Hex };
    await relayerFor(chain).submitClaim(upper);
    const raw = chain.sent[0] as Hex;
    const tx = parseTransaction(raw);
    expect(tx.to).toBe(VAULT.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.chainId).toBe(56);
    expect(tx.gas).toBe(PADDED_GAS);
    expect(tx.gasPrice).toBe(GAS_PRICE);
    expect(tx.nonce).toBe(7);
    const decoded = decodeFunctionData({ abi: giftVaultAbi, data: tx.data as Hex });
    expect(decoded.functionName).toBe("claim");
    expect(decoded.args).toEqual([42n, input.recipient, input.signature.toLowerCase()]);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] })).toBe(relayerAccount.address);
  });

  it("sends nothing when simulation reverts, and surfaces the vault error name", async () => {
    const store = createMemoryStore();
    const chain = fakeChain({ revert: vaultError("BadSigner") });
    const err = await relayerFor(chain, store).submitClaim(await claimInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimRefusedError);
    expect((err as ClaimRefusedError).vaultError).toBe("BadSigner");
    expect(chain.sent).toHaveLength(0);
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBeNull();
    expect(await store.get(keys.claimLock(VAULT, 1n))).toBeNull();
    expect(await store.get(keys.claim(VAULT, 1n))).toBeNull();
  });

  it("refuses with a null name for a revert that is not a vault error, and sends nothing when the node is down", async () => {
    const tokenError = "0xdeadbeef00000000000000000000000000000000000000000000000000000001" as Hex;
    const reverted = fakeChain({ revert: tokenError });
    const err = await relayerFor(reverted).submitClaim(await claimInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimRefusedError);
    expect((err as ClaimRefusedError).vaultError).toBeNull();
    const down = fakeChain({ rpcDown: true });
    const downErr = await relayerFor(down).submitClaim(await claimInput()).catch((e: unknown) => e);
    expect(downErr).toBeInstanceOf(HttpRequestError);
    expect(reverted.sent.length + down.sent.length).toBe(0);
  });

  it("sends nothing when the gas price is above the ceiling", async () => {
    const store = createMemoryStore();
    const chain = fakeChain({ gasPrice: 3_000_000_001n });
    await expect(relayerFor(chain, store).submitClaim(await claimInput())).rejects.toBeInstanceOf(GasPriceTooHighError);
    expect(chain.sent).toHaveLength(0);
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBeNull();
  });

  it("sends nothing when the padded gas limit is above the claim cap", async () => {
    const chain = fakeChain({ gasEstimate: 250_000n });
    await expect(relayerFor(chain).submitClaim(await claimInput())).rejects.toBeInstanceOf(GasLimitError);
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses at the daily cap and leaves the counter where it was", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const cost = PADDED_GAS * GAS_PRICE;
    const relayer = relayerFor(chain, store, { dailyCapWei: cost + cost / 2n });
    await relayer.submitClaim(await claimInput(1n));
    await expect(relayer.submitClaim(await claimInput(2n))).rejects.toBeInstanceOf(DailyCapReachedError);
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBe(cost.toString());
    expect(chain.sent).toHaveLength(1);
    expect(await store.get(keys.claimLock(VAULT, 2n))).toBeNull();
  });

  it("gives the reservation back when the send fails before broadcast", async () => {
    const store = createMemoryStore();
    const chain = fakeChain({ nonceFails: true });
    await expect(relayerFor(chain, store).submitClaim(await claimInput())).rejects.toBeInstanceOf(HttpRequestError);
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBe("0");
    expect(await store.get(keys.relayerSendLock(relayerAccount.address))).toBeNull();
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses malformed input before touching the store or the chain", async () => {
    const chain = fakeChain();
    const relayer = relayerFor(chain);
    const good = await claimInput();
    const bad = [
      { ...good, signature: `0x${"ab".repeat(64)}` as Hex },
      { ...good, signature: `0x${"ab".repeat(66)}` as Hex },
      { ...good, signature: `0x${"zz".repeat(65)}` as Hex },
      { ...good, giftId: 0n },
      { ...good, giftId: 1n << 256n },
      { ...good, recipient: "0x1234" as Hex },
    ];
    for (const input of bad) await expect(relayer.submitClaim(input)).rejects.toBeInstanceOf(RelayerInputError);
    expect(chain.calls).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses an RPC that is not on chain 56", async () => {
    const chain = fakeChain({ chainId: 97 });
    await expect(relayerFor(chain).submitClaim(await claimInput())).rejects.toThrow("expected 56");
    expect(chain.sent).toHaveLength(0);
  });

  it("answers busy after waiting 15 seconds on a gift another request holds", async () => {
    vi.useFakeTimers();
    const store = createMemoryStore();
    await store.setNx(keys.claimLock(VAULT, 1n), "someone-else", 60);
    const chain = fakeChain();
    const pending = relayerFor(chain, store).submitClaim(await claimInput());
    const outcome = expect(pending).rejects.toBeInstanceOf(RelayerBusyError);
    await vi.advanceTimersByTimeAsync(15_500);
    await outcome;
    expect(chain.sent).toHaveLength(0);
  });

  it("sends one claim, not two, when a request outlives its 60 second gift lock and a second request takes it over (C41)", async () => {
    vi.useFakeTimers();
    const store = createMemoryStore();
    const slow: FakeOptions = { callDelayMs: 61_000 };
    const chain = fakeChain(slow);
    const relayer = relayerFor(chain, store);
    const input = await claimInput();
    const p1 = relayer.submitClaim(input).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_500);
    // Only the first request is slow. If the second one's call also took 61 seconds it would
    // outlive its own lock too, and C41 says it then sends nothing either.
    slow.callDelayMs = 0;
    const p2 = relayer.submitClaim(input).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const [late, holder] = await Promise.all([p1, p2]);
    expect(chain.sent).toHaveLength(1);
    expect(late).toBeInstanceOf(RelayerBusyError);
    expect(holder).toEqual({ txHash: keccak256(chain.sent[0] as Hex), reused: false });
    // The late request gave its spend reservation back.
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBe((PADDED_GAS * GAS_PRICE).toString());
  });

  it("sends one claim, not two, when a request's gift lock runs out during its own broadcast and a second request takes the gift over (C47)", async () => {
    vi.useFakeTimers();
    const store = createMemoryStore();
    // The first request simulates for 59.5 s, so it passes the C41 lock check with half a second
    // left, then its broadcast takes 2 s: the lock runs out while its bytes are in flight.
    const slow: FakeOptions = { callDelayMs: 59_500, sendDelayMs: 2_000 };
    const chain = fakeChain(slow);
    const relayer = relayerFor(chain, store);
    const input = await claimInput();
    const p1 = relayer.submitClaim(input);
    await vi.advanceTimersByTimeAsync(60_200);
    slow.callDelayMs = 0;
    const p2 = relayer.submitClaim(input);
    await vi.runAllTimersAsync();
    const [first, second] = await Promise.all([p1, p2]);
    expect(chain.sent).toHaveLength(1);
    expect(first).toEqual({ txHash: keccak256(chain.sent[0] as Hex), reused: false });
    expect(second).toEqual({ txHash: first.txHash, reused: true });
    expect((await recordIn(store)).hash).toBe(first.txHash);
    // The second request gave its spend reservation back: one claim was paid for.
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBe((PADDED_GAS * GAS_PRICE).toString());
  });

  it("never reuses a nonce when the node keeps reporting a stale, lower pending count (C39)", async () => {
    const store = createMemoryStore();
    const chain = fakeChain({ stalePendingCount: 7 });
    const relayer = relayerFor(chain, store);
    for (const giftId of [1n, 2n, 3n]) await relayer.submitClaim(await claimInput(giftId));
    // The lagging count makes every lower nonce look like a gap, so its same bytes go out again;
    // what matters is that no nonce ever carries two different transactions.
    expect([...new Set(chain.sent)].map((raw) => parseTransaction(raw).nonce)).toEqual([7, 8, 9]);
    expect(await store.get(keys.relayerNonce(relayerAccount.address))).toBe("10");
  });

  it("stores each claim's signed bytes under its nonce, and rebroadcasts a dropped middle one before sending a new claim (C39)", async () => {
    const store = createMemoryStore();
    const chain = fakeChain({ alreadyKnown: true, lookupBlind: true });
    const relayer = relayerFor(chain, store);
    for (const giftId of [1n, 2n, 3n]) await relayer.submitClaim(await claimInput(giftId));
    const [raw7, raw8, raw9] = chain.sent as [Hex, Hex, Hex];
    for (const [nonce, raw] of [[7n, raw7], [8n, raw8], [9n, raw9]] as const) expect(await store.get(keys.relayerTx(relayerAccount.address, nonce))).toBe(raw);

    chain.dropped.add(keccak256(raw8));
    chain.node.pending = 8;
    const tried = chain.tried.length;
    const fourth = await relayer.submitClaim(await claimInput(4n));
    // 8 goes back first; 9 is still held, and the node's "already known" counts as sent even though
    // its lookup misses; only then is the new claim signed, at the counter's nonce.
    expect(chain.tried.slice(tried)).toEqual([raw8, raw9, chain.sent.at(-1)]);
    expect(parseTransaction(chain.sent.at(-1) as Hex).nonce).toBe(10);
    expect(fourth.txHash).toBe(keccak256(chain.sent.at(-1) as Hex));
    expect(await store.get(keys.relayerNonce(relayerAccount.address))).toBe("11");
    expect(await store.get(keys.relayerTx(relayerAccount.address, 10n))).toBe(chain.sent.at(-1));
  });

  it("refills at most five lost nonces per claim, lowest first", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    const relayer = relayerFor(chain, store);
    for (let giftId = 1n; giftId <= 7n; giftId += 1n) await relayer.submitClaim(await claimInput(giftId));
    const first = chain.sent.slice();
    for (const raw of first) chain.dropped.add(keccak256(raw));
    chain.node.pending = 7;
    const tried = chain.tried.length;
    await relayer.submitClaim(await claimInput(8n));
    expect(chain.tried.slice(tried, tried + 5)).toEqual(first.slice(0, 5));
    expect(chain.tried.length - tried).toBe(6);
    expect(parseTransaction(chain.tried.at(-1) as Hex).nonce).toBe(14);
  });

  it("sets the counter back to the node's pending count when the bytes for a lost nonce are missing or not this relayer's claim (C39)", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const variants: ((raws: Hex[]) => Promise<string | null>)[] = [
      async () => null,
      async () => "<script>",
      async (raws) => raws[2] as string,
      async () => stranger.signTransaction({ type: "legacy", chainId: 56, to: VAULT, value: 0n, data: await claimTxData(), gas: PADDED_GAS, gasPrice: GAS_PRICE, nonce: 8 }),
    ];
    for (const stored of variants) {
      const store = createMemoryStore();
      const chain = fakeChain();
      const relayer = relayerFor(chain, store);
      for (const giftId of [1n, 2n, 3n]) await relayer.submitClaim(await claimInput(giftId));
      const value = await stored(chain.sent);
      if (value === null) await store.del(keys.relayerTx(relayerAccount.address, 8n));
      else await store.set(keys.relayerTx(relayerAccount.address, 8n), value);
      chain.dropped.add(keccak256(chain.sent[1] as Hex));
      chain.node.pending = 8;
      const tried = chain.tried.length;
      await relayer.submitClaim(await claimInput(4n));
      expect(chain.tried.length - tried).toBe(1);
      expect(parseTransaction(chain.tried.at(-1) as Hex).nonce).toBe(8);
      expect(await store.get(keys.relayerNonce(relayerAccount.address))).toBe("9");
    }
  });

  it("signs nothing new and gives the reservation back when the node refuses a lost nonce's bytes and does not hold them", async () => {
    const store = createMemoryStore();
    const chain = fakeChain({ rebroadcastFails: true });
    const relayer = relayerFor(chain, store);
    for (const giftId of [1n, 2n]) await relayer.submitClaim(await claimInput(giftId));
    const spent = await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"));
    chain.dropped.add(keccak256(chain.sent[0] as Hex));
    chain.node.pending = 7;
    await expect(relayer.submitClaim(await claimInput(3n))).rejects.toThrow("node refused the bytes");
    expect(chain.sent).toHaveLength(2);
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBe(spent);
    expect(await store.get(keys.relayerNonce(relayerAccount.address))).toBe("9");
    expect(await store.get(keys.relayerSendLock(relayerAccount.address))).toBeNull();
    expect(await store.get(keys.claimLock(VAULT, 3n))).toBeNull();
  });

  it("takes the node's pending count when it is ahead of the stored counter", async () => {
    const store = createMemoryStore();
    await store.set(keys.relayerNonce(relayerAccount.address), "3");
    const chain = fakeChain();
    await relayerFor(chain, store).submitClaim(await claimInput());
    expect(parseTransaction(chain.sent[0] as Hex).nonce).toBe(7);
    expect(await store.get(keys.relayerNonce(relayerAccount.address))).toBe("8");
  });

  it("sends nothing and gives the reservation back when the stored nonce counter is not a whole number", async () => {
    for (const bad of ["7.5", "-1", "07", "abc", "99999999999999999"]) {
      const store = createMemoryStore();
      await store.set(keys.relayerNonce(relayerAccount.address), bad);
      const chain = fakeChain();
      await expect(relayerFor(chain, store).submitClaim(await claimInput())).rejects.toBeInstanceOf(StoreError);
      expect(chain.sent).toHaveLength(0);
      expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBe("0");
    }
  });

  it("refuses a gift 59 seconds from expiry before simulating, and claims one 60 seconds away (C37)", async () => {
    const store = createMemoryStore();
    const chain = fakeChain();
    chain.gift.expiry = BLOCK_TIME + 59n;
    const relayer = relayerFor(chain, store);
    const err = await relayer.submitClaim(await claimInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimRefusedError);
    expect((err as ClaimRefusedError).name).toBe("GiftExpiring");
    expect(chain.calls).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    expect(await store.get(keys.claimLock(VAULT, 1n))).toBeNull();
    expect(await store.get(keys.relayerSpent(relayerAccount.address, "2026-10-07"))).toBeNull();
    chain.gift.expiry = BLOCK_TIME + 60n;
    expect((await relayer.submitClaim(await claimInput())).reused).toBe(false);
    expect(chain.sent).toHaveLength(1);
  });

  it("lets a waiter take the lock and claim when the holder is refused and releases without a record (C36)", async () => {
    const chain = fakeChain({ revertOnce: vaultError("BadSigner"), callDelayMs: 300 });
    const relayer = relayerFor(chain);
    const good = await claimInput();
    const junk = { ...good, signature: (await claimInput()).signature };
    const [refused, claimed] = await Promise.allSettled([relayer.submitClaim(junk), relayer.submitClaim(good)]);
    expect(refused.status).toBe("rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(ClaimRefusedError);
    expect(claimed).toMatchObject({ status: "fulfilled", value: { reused: false } });
    expect(chain.sent).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: giftVaultAbi, data: parseTransaction(chain.sent[0] as Hex).data as Hex });
    expect(decoded.args[2]).toBe(good.signature.toLowerCase());
  });

  it("refuses a memory store, or a wrapper around one, unless allowMemoryStore is true, and accepts the shared store (C38)", () => {
    const chain = fakeChain();
    const base = { account: relayerAccount, client: chain.client, walletClient: chain.walletClient, vault: VAULT, maxGasPriceWei: 3_000_000_000n, dailyCapWei: 10n ** 16n };
    const memory = createMemoryStore();
    expect(() => createRelayer({ ...base, store: memory })).toThrow("shared store");
    expect(() => createRelayer({ ...base, store: memory, allowMemoryStore: false })).toThrow("shared store");
    expect(() => createRelayer({ ...base, store: { ...memory } })).toThrow("shared store");
    expect(() => createRelayer({ ...base, store: memory, allowMemoryStore: true })).not.toThrow();
    const shared = createUpstashStore({ url: "https://eu1-fake-store.upstash.io", token: "fake-upstash-token-0001", fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect(isSharedStore(shared)).toBe(true);
    expect(isSharedStore(memory)).toBe(false);
    expect(isSharedStore({ ...shared })).toBe(false);
    expect(() => createRelayer({ ...base, store: shared })).not.toThrow();
  });

  it("refuses to start with a zero cap or ceiling", () => {
    const chain = fakeChain();
    expect(() => relayerFor(chain, createMemoryStore(), { dailyCapWei: 0n })).toThrow();
    expect(() => relayerFor(chain, createMemoryStore(), { maxGasPriceWei: 0n })).toThrow();
  });
});

describe("decodeVaultError", () => {
  it("names a GiftVault error in a real viem call error, and nothing else", () => {
    expect(decodeVaultError(revertError(vaultError("GiftNotOpen")))).toBe("GiftNotOpen");
    const highS = encodeErrorResult({ abi: giftVaultAbi, errorName: "ECDSAInvalidSignatureS", args: [`0x${"ff".repeat(32)}`] });
    expect(decodeVaultError(revertError(highS))).toBe("ECDSAInvalidSignatureS");
    expect(decodeVaultError(revertError("0x08c379a0" as Hex))).toBeNull();
    expect(decodeVaultError(new Error("execution reverted: GiftNotOpen"))).toBeNull();
    expect(decodeVaultError("GiftNotOpen")).toBeNull();
    expect(decodeVaultError(null)).toBeNull();
  });
});

describe("gasLimitFor", () => {
  const client = (estimate: bigint | Error) =>
    ({
      estimateGas: async () => {
        if (estimate instanceof Error) throw estimate;
        return estimate;
      },
    }) as unknown as PublicClient;

  it("takes the higher of the given gas and the estimate, plus 30 percent", async () => {
    expect(await gasLimitFor(client(100_000n), VAULT, { to: VAULT, data: "0x" }, 1_000_000n)).toBe(130_000n);
    expect(await gasLimitFor(client(100_000n), VAULT, { to: VAULT, data: "0x", gas: 200_000n }, 1_000_000n)).toBe(260_000n);
  });

  it("refuses a failed estimate and a limit above the cap", async () => {
    await expect(gasLimitFor(client(new Error("node down")), VAULT, { to: VAULT, data: "0x" }, 1_000_000n)).rejects.toBeInstanceOf(GasLimitError);
    await expect(gasLimitFor(client(800_000n), VAULT, { to: VAULT, data: "0x" }, 1_000_000n)).rejects.toBeInstanceOf(GasLimitError);
  });
});

describe("confirmClaim", () => {
  const HASH = `0x${"12".repeat(32)}` as Hex;
  const recipient = privateKeyToAccount(generatePrivateKey()).address;

  function claimedLog(address: Hex, giftId: bigint, to: Hex) {
    return {
      address,
      topics: encodeEventTopics({ abi: giftVaultAbi, eventName: "GiftClaimed", args: { giftId, recipient: to } }),
      data: encodeAbiParameters([{ type: "uint256" }], [5n]),
    };
  }

  const client = (receipt: unknown) =>
    ({
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (receipt === null) throw new TransactionReceiptNotFoundError({ hash });
        return receipt;
      },
    }) as unknown as PublicClient;

  const receipt = (status: string, logs: unknown[]) => ({ status, transactionHash: HASH, logs });

  it("is true only for a successful receipt with this vault's GiftClaimed for this gift and recipient", async () => {
    expect(await confirmClaim(client(receipt("success", [claimedLog(VAULT, 3n, recipient)])), VAULT, HASH, 3n, recipient)).toBe(true);
    expect(await confirmClaim(client(receipt("success", [claimedLog(VAULT, 3n, recipient)])), VAULT, HASH, 4n, recipient)).toBe(false);
    expect(await confirmClaim(client(receipt("success", [claimedLog(VAULT, 3n, VAULT)])), VAULT, HASH, 3n, recipient)).toBe(false);
    const elsewhere = getAddress("0x00000000000000000000000000000000000000aa");
    expect(await confirmClaim(client(receipt("success", [claimedLog(elsewhere, 3n, recipient)])), VAULT, HASH, 3n, recipient)).toBe(false);
    expect(await confirmClaim(client(receipt("reverted", [claimedLog(VAULT, 3n, recipient)])), VAULT, HASH, 3n, recipient)).toBe(false);
    expect(await confirmClaim(client(receipt("success", [])), VAULT, HASH, 3n, recipient)).toBe(false);
  });

  it("is false with no receipt yet and for a malformed hash", async () => {
    expect(await confirmClaim(client(null), VAULT, HASH, 3n, recipient)).toBe(false);
    expect(await confirmClaim(client(null), VAULT, "0x1234" as Hex, 3n, recipient)).toBe(false);
  });
});
