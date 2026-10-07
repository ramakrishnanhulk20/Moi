import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  ExecutionRevertedError,
  getAddress,
  keccak256,
  parseTransaction,
  RawContractError,
  recoverTransactionAddress,
  slice,
  toFunctionSelector,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionSerialized,
  type WalletClient,
} from "viem";
import { z } from "zod";
import { CHAIN_ID } from "./chain.js";
import { gasLimitFor } from "./gas.js";
import { giftVaultAbi } from "./generated/giftVaultAbi.js";
import { parseGiftId } from "./gift.js";
import { isSharedStore, keys, StoreError, type KvStore, type StoreKey } from "./store.js";
import { decodeVaultError, readGift, type VaultErrorName } from "./vault.js";

/** A claim measured about 117,000 gas; 300,000 leaves room for the 30 percent pad and a token upgrade. */
export const DEFAULT_CLAIM_GAS_CAP = 300_000n;

const CLAIM_LOCK_SECONDS = 60;
const CLAIM_WAIT_MS = 15_000;
const SEND_LOCK_SECONDS = 30;
const SEND_LOCK_WAIT_MS = 15_000;
const SPENT_TTL_SECONDS = 2 * 24 * 60 * 60;
const RELAYER_TX_TTL_SECONDS = 24 * 60 * 60;
// WHY 5: every refilled nonce is one store read and one node round trip under the 30-second send
// lock, and five keeps the worst case well inside it. A wider gap is refilled five nonces per
// claim, lowest first.
const MAX_GAP_REFILL = 5;
const CLAIM_HASH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLAIM_POLL_MS = 200;
// WHY 3: a claim that passed simulation and still reverted on chain was paid for by the relayer.
// Three such reverts on one gift say it will not land, and its sender can refund it after expiry.
const MAX_CLAIM_ATTEMPTS = 3;
const SEND_LOCK_POLL_MS = 100;
// BSC makes a block every few seconds; a minute covers the queue and a slow node with room to spare.
const EXPIRY_MARGIN_SECONDS = 60n;

const SIGNATURE_TEXT = /^0x[0-9a-fA-F]{130}$/;
const STORED_HASH_TEXT = /^0x[0-9a-f]{64}$/;
const ANY_HASH_TEXT = /^0x[0-9a-fA-F]{64}$/;
const NONCE_TEXT = /^(?:0|[1-9][0-9]{0,15})$/;
// A signed claim is about 340 bytes. Four times that is still far below anything a real claim needs.
const MAX_RAW_TX_HEX = 2 + 2 * 1_400;
const RAW_TX_TEXT = /^0x(?:[0-9a-f]{2})+$/;
// geth, the client BSC nodes run, answers this when its pool already holds the exact bytes sent.
// Other wordings are not matched here; the node is asked for the hash instead.
const ALREADY_KNOWN_TEXT = /already known/i;

const claimFunction = giftVaultAbi.find((item) => item.type === "function" && item.name === "claim");
if (claimFunction === undefined) throw new Error("The generated GiftVault ABI has no claim function.");
const CLAIM_SELECTOR = toFunctionSelector(claimFunction);

/**
 * What the relayer stores per gift once a claim is broadcast: the hash, the signed bytes, when, and
 * how many claims this gift has had sent, this one included.
 */
type ClaimRecord = { hash: Hex; raw: Hex; sentAt: string; attempts: number };
/** A record as read back: the stored fields plus the nonce inside its signed bytes. */
type StoredClaim = ClaimRecord & { nonce: number };
/**
 * A stored claim that no longer stands for its gift: reverted while the gift is still Open, or
 * dead because another mined transaction holds its nonce.
 */
type Replaceable = { dead: boolean };
/** The record this request already found replaceable, so a waiter never hands it back. */
type Stale = Replaceable & { hash: Hex };

// Exactly the shape submitClaim writes, lowercase hex only, and the bytes must hash to the hash.
const claimRecordSchema = z
  .strictObject({
    hash: z.string().regex(STORED_HASH_TEXT),
    raw: z.string().max(MAX_RAW_TX_HEX).regex(RAW_TX_TEXT),
    sentAt: z.iso.datetime(),
    attempts: z.number().int().min(1).max(MAX_CLAIM_ATTEMPTS),
  })
  .refine((r) => keccak256(r.raw as Hex) === r.hash);

/** Base class for every refusal the relayer makes on purpose. None of them broadcast anything. */
export class RelayerError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

const REFUSAL_MESSAGES = {
  GiftExpiring: "The gift expires too soon for a claim to land before it.",
  TooManyAttempts: `This gift's last ${MAX_CLAIM_ATTEMPTS} claims reverted on chain. Its sender can take it back after expiry.`,
} as const;

/**
 * The relayer refuses this claim and sends nothing. `name` is "ClaimRefusedError" when the vault
 * would refuse it (`vaultError` is the GiftVault error name, or null), "GiftExpiring" when fewer
 * than 60 seconds remain before the gift's expiry by the latest block (C37), and "TooManyAttempts"
 * when three claims for the gift have already reverted on chain.
 */
export class ClaimRefusedError extends RelayerError {
  readonly vaultError: VaultErrorName | null;
  constructor(vaultError: VaultErrorName | null, name: "ClaimRefusedError" | "GiftExpiring" | "TooManyAttempts" = "ClaimRefusedError") {
    super(name, name === "ClaimRefusedError" ? `The vault would refuse this claim (${vaultError ?? "unknown reason"}).` : REFUSAL_MESSAGES[name]);
    this.vaultError = vaultError;
  }
}

/**
 * Another request holds this gift or the relayer's nonce for longer than the wait allows, or this
 * request outlived its own gift lock before signing (C41). Nothing was sent. Try again later.
 */
export class RelayerBusyError extends RelayerError {
  constructor() {
    super("RelayerBusyError", "The relayer is busy. Try again shortly.");
  }
}

/** Today's spend cap would be exceeded. Try again after midnight UTC. */
export class DailyCapReachedError extends RelayerError {
  constructor() {
    super("DailyCapReachedError", "The relayer has reached its daily spend cap.");
  }
}

/** The node's gas price is above the ceiling. Try again later. */
export class GasPriceTooHighError extends RelayerError {
  constructor() {
    super("GasPriceTooHighError", "Network gas price is above the relayer's ceiling.");
  }
}

/** A claim input failed its parser. The claim route parses first, so this is defence in depth. */
export class RelayerInputError extends RelayerError {
  constructor(message: string) {
    super("RelayerInputError", message);
  }
}

export type ClaimInput = { giftId: bigint; recipient: Address; signature: Hex };

function parseInput(input: ClaimInput): ClaimInput {
  if (typeof input !== "object" || input === null) throw new RelayerInputError("Claim input is missing.");
  let giftId: bigint;
  try {
    giftId = parseGiftId(typeof input.giftId === "bigint" ? input.giftId.toString() : "");
  } catch {
    throw new RelayerInputError("Gift id is not valid.");
  }
  let recipient: Address;
  try {
    recipient = getAddress(input.recipient);
  } catch {
    throw new RelayerInputError("Recipient is not a valid address.");
  }
  if (typeof input.signature !== "string" || !SIGNATURE_TEXT.test(input.signature)) {
    throw new RelayerInputError("Signature must be exactly 65 bytes of hex.");
  }
  return { giftId, recipient, signature: input.signature.toLowerCase() as Hex };
}

function isRevert(err: unknown): boolean {
  if (decodeVaultError(err) !== null) return true;
  if (!(err instanceof BaseError)) return false;
  return (
    err.walk((e) => e instanceof ExecutionRevertedError || e instanceof RawContractError || e instanceof ContractFunctionRevertedError) !== null
  );
}

// viem nests the node's own message a few levels down, so the whole cause chain is read. The
// bound keeps a cyclic chain finite.
function saysAlreadyKnown(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < 16 && typeof node === "object" && node !== null; depth += 1) {
    const { message, details } = node as { message?: unknown; details?: unknown };
    if ((typeof message === "string" && ALREADY_KNOWN_TEXT.test(message)) || (typeof details === "string" && ALREADY_KNOWN_TEXT.test(details))) {
      return true;
    }
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const newToken = () => globalThis.crypto.randomUUID();

/**
 * The gas relayer for vault claims (C17, C18, C31). It owns one key and uses it for one thing:
 * vault.claim(giftId, recipient, signature), with calldata it encodes itself from parsed inputs.
 * The vault accepts claim() only from this address, and still needs the claim key's signature, so
 * a stolen relayer key can refuse claims but cannot take a gift (C31, C2).
 * `store` must be the shared store (createUpstashStore). Any other store, the in-process memory
 * store included, is accepted only with `allowMemoryStore: true`, which is for tests and a
 * one-process script, never a server (C38).
 * Throws at creation when an option is missing or not above zero, the account is not local, or
 * the store is not shared and allowMemoryStore is not true.
 */
export function createRelayer(opts: {
  account: LocalAccount;
  client: PublicClient;
  walletClient: WalletClient;
  vault: Address;
  store: KvStore;
  maxGasPriceWei: bigint;
  dailyCapWei: bigint;
  claimGasCap?: bigint;
  now?: () => Date;
  allowMemoryStore?: boolean;
}): { submitClaim(input: ClaimInput): Promise<{ txHash: Hex; reused: boolean }> } {
  const { account, client, walletClient, store, maxGasPriceWei, dailyCapWei } = opts;
  const claimGasCap = opts.claimGasCap ?? DEFAULT_CLAIM_GAS_CAP;
  const now = opts.now ?? (() => new Date());
  if (account?.type !== "local" || typeof account.signTransaction !== "function") {
    throw new Error("The relayer needs a local account that signs in this process.");
  }
  const relayer = getAddress(account.address);
  const vault = getAddress(opts.vault);
  for (const [name, value] of [["maxGasPriceWei", maxGasPriceWei], ["dailyCapWei", dailyCapWei], ["claimGasCap", claimGasCap]] as const) {
    if (typeof value !== "bigint" || value <= 0n) throw new Error(`${name} must be a bigint above zero.`);
  }
  if (typeof store?.setNx !== "function") throw new Error("The relayer needs a key-value store.");
  // WHY (C38): with a store only one process sees, two server instances each hold their own
  // claim records, locks, spend and nonce counter, so the same gift could be claimed twice over
  // and the daily cap counted twice. Only an explicit opt-in accepts that.
  if (!isSharedStore(store) && opts.allowMemoryStore !== true) {
    throw new Error("The relayer needs the shared store. allowMemoryStore: true is for tests and one-process scripts only.");
  }

  let chainChecked = false;
  async function assertChain(): Promise<void> {
    if (chainChecked) return;
    const id = await client.getChainId();
    if (id !== CHAIN_ID) throw new Error(`RPC is on chain ${id}, expected ${CHAIN_ID}.`);
    chainChecked = true;
  }

  // Signed bytes read back from the store are checked like input (standard 3): they count only
  // when they are what signClaimTx makes, a legacy zero-value claim() to this vault on chain 56
  // signed by this relayer. Returns their nonce and gift id, or null for anything else.
  async function ownClaimTx(value: string): Promise<{ nonce: number; giftId: bigint } | null> {
    if (value.length > MAX_RAW_TX_HEX || !RAW_TX_TEXT.test(value)) return null;
    try {
      const tx = parseTransaction(value as Hex);
      if (tx.type !== "legacy" || tx.chainId !== CHAIN_ID || typeof tx.nonce !== "number") return null;
      if (typeof tx.to !== "string" || getAddress(tx.to) !== vault || (tx.value ?? 0n) !== 0n) return null;
      if (tx.data === undefined || slice(tx.data, 0, 4) !== CLAIM_SELECTOR) return null;
      const call = decodeFunctionData({ abi: giftVaultAbi, data: tx.data });
      if (call.functionName !== "claim") return null;
      const signer = await recoverTransactionAddress({ serializedTransaction: value as TransactionSerialized });
      if (getAddress(signer) !== relayer) return null;
      return { nonce: tx.nonce, giftId: call.args[0] };
    } catch {
      return null;
    }
  }

  // A value read back from the store is checked like input (standard 3, C25): only a record this
  // code wrote, whose bytes are this relayer's claim of this very gift, counts. Anything else is
  // null, which every caller treats as no record (C35).
  async function parseRecord(value: string, giftId: bigint): Promise<StoredClaim | null> {
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      return null;
    }
    const parsed = claimRecordSchema.safeParse(json);
    if (!parsed.success) return null;
    const record = parsed.data as ClaimRecord;
    const tx = await ownClaimTx(record.raw);
    if (tx === null || tx.giftId !== giftId) return null;
    return { ...record, nonce: tx.nonce };
  }

  // Only a request holding the gift lock deletes a malformed record, so a lock-free reader can
  // never delete a good record the lock holder wrote in between.
  async function readRecord(k: StoreKey, giftId: bigint, holdsLock: boolean): Promise<StoredClaim | null> {
    const value = await store.get(k);
    if (value === null) return null;
    const record = await parseRecord(value, giftId);
    if (record === null && holdsLock) await store.del(k);
    return record;
  }

  async function receiptOf(hash: Hex) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
  }

  async function nodeKnows(hash: Hex): Promise<boolean> {
    try {
      await client.getTransaction({ hash });
      return true;
    } catch (err) {
      if (err instanceof TransactionNotFoundError) return false;
      throw err;
    }
  }

  /**
   * C35: what a stored claim is worth now. A success, or a transaction the node still holds, is
   * the answer for this gift. A revert while the gift is still Open gives {dead: false}: the record
   * no longer counts and the caller may claim again. A revert on a gift that is no longer Open is
   * refused. A transaction the node does not know whose nonce is below the relayer's mined count
   * gives {dead: true}: another transaction took that nonce, so its bytes can never land and the
   * caller may claim afresh. Any other transaction the node does not know is sent again, as the
   * same signed bytes, once. Never deletes: only the gift lock holder does that.
   */
  async function resolveRecord(record: StoredClaim, giftId: bigint): Promise<{ txHash: Hex; reused: boolean } | Replaceable> {
    const judge = async (status: string): Promise<{ txHash: Hex; reused: boolean } | Replaceable> => {
      if (status === "success") return { txHash: record.hash, reused: true };
      if ((await readGift(client, vault, giftId)).state === "Open") return { dead: false };
      throw new ClaimRefusedError("GiftNotOpen");
    };
    const receipt = await receiptOf(record.hash);
    if (receipt !== null) return judge(receipt.status);
    if (await nodeKnows(record.hash)) return { txHash: record.hash, reused: true };
    const mined = await client.getTransactionCount({ address: relayer, blockTag: "latest" });
    if (record.nonce < mined) {
      // WHY the second receipt read: it comes after the count, so this very claim being mined
      // between the first read and the count is seen as mined, never as its nonce being taken.
      const late = await receiptOf(record.hash);
      return late === null ? { dead: true } : judge(late.status);
    }
    // WHY the same bytes: they carry the same nonce, so a rebroadcast can only put the original
    // claim back in the queue, never add a second one.
    try {
      const nodeHash = await walletClient.sendRawTransaction({ serializedTransaction: record.raw });
      if (typeof nodeHash !== "string" || nodeHash.toLowerCase() !== record.hash) {
        throw new Error("The node reported a different hash for the rebroadcast claim.");
      }
    } catch (err) {
      // Behind a load balancer one node can refuse bytes another already holds. What counts is
      // whether the node now has the transaction, judged by asking, not by its error text.
      if (!(await nodeKnows(record.hash))) throw err;
    }
    return { txHash: record.hash, reused: true };
  }

  async function releaseQuietly(k: StoreKey, token: string): Promise<void> {
    try {
      if ((await store.get(k)) === token) await store.del(k);
    } catch {
      // Every lock carries a TTL, so a failed release only delays the next request.
    }
  }

  // `stale` is the record this request already found replaceable (reverted on an Open gift, or
  // dead). Seeing it again means the holder has not replaced it yet, so it is never the answer.
  async function waitForOtherRequest(
    claim: { giftId: bigint; recipient: Address; signature: Hex },
    claimKey: StoreKey,
    lockKey: StoreKey,
    stale: Stale | null,
  ): Promise<{ txHash: Hex; reused: boolean }> {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      await sleep(CLAIM_POLL_MS);
      const record = await readRecord(claimKey, claim.giftId, false);
      if (record !== null && record.hash !== stale?.hash) return { txHash: record.hash, reused: true };
      // WHY (C36): a holder that finished without a record (its claim was refused) leaves the
      // gift free, so this request takes the lock itself instead of answering busy. Under the
      // lock the record is read again, so a record written just before the release still wins.
      const lockToken = newToken();
      if (await store.setNx(lockKey, lockToken, CLAIM_LOCK_SECONDS)) return claimUnderLock(claim, claimKey, lockKey, lockToken, stale);
      if (Date.now() >= deadline) throw new RelayerBusyError();
    }
  }

  // Read back like input (standard 3): only a whole number this code wrote counts. Anything else
  // stops the send (fail closed) rather than guessing a nonce.
  async function readNonceCounter(): Promise<number | null> {
    const value = await store.get(keys.relayerNonce(relayer));
    if (value === null) return null;
    const n = NONCE_TEXT.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n)) throw new StoreError("stored relayer nonce is not a whole number");
    return n;
  }

  async function takeSendLock(token: string): Promise<boolean> {
    const deadline = Date.now() + SEND_LOCK_WAIT_MS;
    for (;;) {
      if (await store.setNx(keys.relayerSendLock(relayer), token, SEND_LOCK_SECONDS)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(SEND_LOCK_POLL_MS);
    }
  }

  // The only place the relayer key signs. It refuses anything but a zero-value claim() call to
  // the vault on chain 56, so a later edit elsewhere cannot widen what the key signs (C17).
  async function signClaimTx(tx: { data: Hex; gas: bigint; gasPrice: bigint; nonce: number }): Promise<Hex> {
    if (slice(tx.data, 0, 4) !== CLAIM_SELECTOR) throw new Error("The relayer signs vault claim calls only.");
    return account.signTransaction({ type: "legacy", chainId: CHAIN_ID, to: vault, value: 0n, data: tx.data, gas: tx.gas, gasPrice: tx.gasPrice, nonce: tx.nonce });
  }

  // Bytes stored for a nonce count only when ownClaimTx accepts them and they carry that nonce.
  // Anything else is null, which the gap refill treats as missing.
  async function readSentRaw(nonce: number): Promise<Hex | null> {
    const value = await store.get(keys.relayerTx(relayer, BigInt(nonce)));
    if (value === null) return null;
    const tx = await ownClaimTx(value);
    return tx !== null && tx.nonce === nonce ? (value as Hex) : null;
  }

  // The same bytes carry the same nonce, so sending them again can only refill that nonce, never
  // add a second transaction. Success is the node taking them, saying its pool already holds them,
  // or knowing the hash when asked: behind a load balancer the node that answers the send may not
  // be the one that answers the lookup.
  async function rebroadcast(raw: Hex): Promise<void> {
    const hash = keccak256(raw);
    try {
      const nodeHash = await walletClient.sendRawTransaction({ serializedTransaction: raw });
      if (typeof nodeHash !== "string" || nodeHash.toLowerCase() !== hash) {
        throw new Error("The node reported a different hash for a rebroadcast transaction.");
      }
    } catch (err) {
      if (saysAlreadyKnown(err) || (await nodeKnows(hash))) return;
      throw err;
    }
  }

  /**
   * The nonce for the next claim, read under the send lock (C39). The node's pending count is used
   * unless the relayer's stored counter is above it. Then the nonces from the pending count up to
   * the counter, at most five, are gaps the node has lost: their stored signed bytes are sent again,
   * lowest first, and the counter is the answer. A rebroadcast the node refuses and does not hold
   * throws, so nothing new is signed above a gap that could not be refilled.
   */
  async function chooseNonce(): Promise<number> {
    const [counted, pending] = await Promise.all([readNonceCounter(), client.getTransactionCount({ address: relayer, blockTag: "pending" })]);
    if (counted === null || counted <= pending) return pending;
    const gap = Array.from({ length: Math.min(counted - pending, MAX_GAP_REFILL) }, (_, i) => pending + i);
    const raws = await Promise.all(gap.map(readSentRaw));
    if (raws.some((raw) => raw === null)) {
      // WHY: without the signed bytes for a lost nonce the gap cannot be refilled, and a claim sent
      // above a gap waits behind it for good. Going back to the node's count lets this claim take
      // the lowest free nonce and close the gap. The claim that was dropped keeps its own record;
      // once this claim is mined on that nonce, the C35 path finds that record dead and the next
      // request for its gift claims afresh.
      await store.set(keys.relayerNonce(relayer), String(pending));
      return pending;
    }
    for (const raw of raws) await rebroadcast(raw as Hex);
    return counted;
  }

  async function claimUnderLock(
    claim: { giftId: bigint; recipient: Address; signature: Hex },
    claimKey: StoreKey,
    lockKey: StoreKey,
    lockToken: string,
    stale: Stale | null,
  ): Promise<{ txHash: Hex; reused: boolean }> {
    const { giftId, recipient, signature } = claim;
    let releaseClaimLock = true;
    try {
      await assertChain();
      // Another holder may have written a fresh record between this request's first read and
      // its lock. A record other than the one already found replaceable is resolved afresh.
      const current = await readRecord(claimKey, giftId, true);
      let attempts = 1;
      if (current !== null) {
        let replaceable: Replaceable;
        if (stale !== null && current.hash === stale.hash) {
          replaceable = stale;
        } else {
          const resolved = await resolveRecord(current, giftId);
          if ("txHash" in resolved) return resolved;
          replaceable = resolved;
        }
        if (replaceable.dead) {
          // WHY (C35): another mined transaction holds this claim's nonce, so its bytes can only
          // fail "nonce too low". Deleted here, under the gift lock, so a lock-free reader can
          // never delete a record written in between. It never reverted, so the fresh claim
          // takes its attempt number instead of counting it as a failure.
          await store.del(claimKey);
          attempts = current.attempts;
        } else {
          // WHY (C35): this claim reverted while the gift is still Open, so its record no longer
          // blocks a new claim. It is kept, not deleted, until the new claim's record replaces it
          // under this lock, so its attempt count survives a refusal before the new send.
          if (current.attempts >= MAX_CLAIM_ATTEMPTS) throw new ClaimRefusedError(null, "TooManyAttempts");
          attempts = current.attempts + 1;
        }
      }

      // WHY (C37): a claim mined after expiry reverts and the relayer still pays for it, so a gift
      // this close to expiry is refused by block time before anything is simulated or sent. A
      // gift that is not Open is left to the simulation, which names the vault's own reason.
      const [gift, latest] = await Promise.all([readGift(client, vault, giftId), client.getBlock({ blockTag: "latest" })]);
      if (gift.state === "Open" && gift.expiry - latest.timestamp < EXPIRY_MARGIN_SECONDS) throw new ClaimRefusedError(null, "GiftExpiring");

      const data = encodeFunctionData({ abi: giftVaultAbi, functionName: "claim", args: [giftId, recipient, signature] });
      try {
        await client.call({ account: relayer, to: vault, data, blockTag: "latest" });
      } catch (err) {
        if (isRevert(err)) throw new ClaimRefusedError(decodeVaultError(err));
        throw err;
      }

      const gas = await gasLimitFor(client, relayer, { to: vault, data }, claimGasCap);
      const gasPrice = await client.getGasPrice();
      if (gasPrice <= 0n || gasPrice > maxGasPriceWei) throw new GasPriceTooHighError();

      const cost = gas * gasPrice;
      const spentKey = keys.relayerSpent(relayer, now().toISOString().slice(0, 10));
      const spent = await store.incrBy(spentKey, cost, SPENT_TTL_SECONDS);
      if (spent > dailyCapWei) {
        await store.incrBy(spentKey, -cost, SPENT_TTL_SECONDS);
        throw new DailyCapReachedError();
      }

      const sendToken = newToken();
      if (!(await takeSendLock(sendToken))) {
        await store.incrBy(spentKey, -cost, SPENT_TTL_SECONDS);
        throw new RelayerBusyError();
      }
      let txHash: Hex;
      let raw: Hex;
      try {
        // WHY (C41): the gift lock runs out after 60 seconds whatever this request is doing, and a
        // slow node can stretch the steps above past that. Another request may then hold the gift
        // and send its own claim, so a request that no longer holds its own token sends nothing.
        // Checked here, under the send lock, because nothing below can be undone once signed.
        if ((await store.get(lockKey)) !== lockToken) throw new RelayerBusyError();
        // WHY (C39): one read of a load-balanced node can lag behind a claim another instance just
        // sent, and reusing its nonce would replace or jam that claim. The relayer's own counter in
        // the shared store remembers every send; the chain count wins only when it is ahead, which
        // covers transactions sent outside this code. Both are read under the send lock.
        const nonce = await chooseNonce();
        raw = (await signClaimTx({ data, gas, gasPrice, nonce })).toLowerCase() as Hex;
        txHash = keccak256(raw);
        releaseClaimLock = false;
        const nodeHash = await walletClient.sendRawTransaction({ serializedTransaction: raw });
        if (typeof nodeHash !== "string" || nodeHash.toLowerCase() !== txHash) {
          throw new Error("The node reported a different hash for the claim transaction.");
        }
        try {
          // Written before the counter, so the counter never names a nonce whose bytes were not
          // offered to the store first.
          await store.set(keys.relayerTx(relayer, BigInt(nonce)), raw, RELAYER_TX_TTL_SECONDS);
        } catch {
          // The claim is live. A missed write matters only if the node later drops it; the gap
          // refill then finds no bytes and goes back to the node's count.
        }
        try {
          await store.set(keys.relayerNonce(relayer), String(nonce + 1));
        } catch {
          // The claim is live, so its hash is the answer. A missed write leaves the counter one
          // behind, and the next send still takes the chain's count when that is ahead.
        }
      } catch (err) {
        // Before the broadcast nothing was spent, so the reservation goes back. After it, the
        // transaction may be live, so the reservation stays (the cap errs toward spending less).
        if (releaseClaimLock) await store.incrBy(spentKey, -cost, SPENT_TTL_SECONDS).catch(() => undefined);
        throw err;
      } finally {
        await releaseQuietly(keys.relayerSendLock(relayer), sendToken);
      }

      try {
        // WHY the signed bytes (C35): if the node later drops this transaction, the next request
        // for the gift sends exactly these bytes again instead of signing a second claim.
        const record: ClaimRecord = { hash: txHash, raw, sentAt: now().toISOString(), attempts };
        await store.set(claimKey, JSON.stringify(record), CLAIM_HASH_TTL_SECONDS);
        releaseClaimLock = true;
      } catch {
        // The claim is on its way. Report it, and let the gift lock expire so a retry cannot
        // broadcast again before the vault itself shows the gift as claimed.
      }
      return { txHash, reused: false };
    } finally {
      if (releaseClaimLock) await releaseQuietly(lockKey, lockToken);
    }
  }

  /**
   * Submits one claim, at most once per live transaction per gift id (C18, C35). In order:
   * 1. a stored record for this gift (C35): a successful or pending transaction is returned with
   *    reused true; one the node does not know is rebroadcast from its stored signed bytes, once,
   *    and returned, unless its nonce is below the relayer's mined count, which makes it dead; a
   *    revert while the gift is still Open, or a dead record, lets this request claim again; a
   *    revert on a gift no longer Open throws ClaimRefusedError("GiftNotOpen");
   * 2. the per-gift lock is taken (60 s); a request that finds it held waits up to 15 s for the
   *    holder's record, taking the lock itself if the holder releases without one (C36), else
   *    throws RelayerBusyError;
   * 3. under the lock the record is read again and a malformed or dead one deleted. A reverted
   *    one is kept until the new claim's record replaces it; when it is the gift's third reverted
   *    claim, ClaimRefusedError named "TooManyAttempts" is thrown and nothing is sent;
   * 4. an Open gift with less than 60 seconds left before its expiry, by the latest block's
   *    time, throws ClaimRefusedError named "GiftExpiring" (C37);
   * 5. claim calldata is encoded here from the parsed inputs (signature exactly 65 bytes);
   * 6. the claim is simulated from the relayer address at the latest block; a revert throws
   *    ClaimRefusedError with the vault's error name, and nothing is sent;
   * 7. the gas limit comes from gasLimitFor under claimGasCap, and the node's gas price must be at
   *    most maxGasPriceWei (else GasPriceTooHighError);
   * 8. gas x price is added to today's UTC spend; past dailyCapWei it is taken back off and
   *    DailyCapReachedError is thrown;
   * 9. under the relayer-wide send lock (30 s, waited for up to 15 s) the gift lock must still hold
   *    this request's own token, else the spend reservation goes back and RelayerBusyError is
   *    thrown with nothing signed or sent (C41). Then the nonce is the node's
   *    pending count, or the relayer's stored counter when that is higher (C39). In that case the
   *    stored signed bytes for the nonces in between, at most five, are sent again first, lowest
   *    first ("already known" counts as sent); if any of them is missing, the counter goes back to
   *    the pending count and that is the nonce. The transaction is then signed and sent, its
   *    signed bytes are stored under its nonce for a day, and the counter is set to nonce plus one;
   * 10. the record {hash, raw, sentAt, attempts} is stored for 30 days and the gift lock released.
   * Throws RelayerInputError for bad input, StoreError when the store fails, and the RPC's own
   * error when the node fails. Once a send may have happened, the gift lock is left to expire
   * rather than released, so a failure can never lead straight to a second broadcast.
   */
  async function submitClaim(input: ClaimInput): Promise<{ txHash: Hex; reused: boolean }> {
    const claim = parseInput(input);
    const claimKey = keys.claim(vault, claim.giftId);
    const lockKey = keys.claimLock(vault, claim.giftId);

    let stale: Stale | null = null;
    const existing = await readRecord(claimKey, claim.giftId, false);
    if (existing !== null) {
      await assertChain();
      const resolved = await resolveRecord(existing, claim.giftId);
      if ("txHash" in resolved) return resolved;
      stale = { hash: existing.hash, dead: resolved.dead };
    }

    const lockToken = newToken();
    if (!(await store.setNx(lockKey, lockToken, CLAIM_LOCK_SECONDS))) return waitForOtherRequest(claim, claimKey, lockKey, stale);
    return claimUnderLock(claim, claimKey, lockKey, lockToken, stale);
  }

  return { submitClaim };
}

/**
 * C16: true only when the transaction's receipt exists, succeeded, and holds a GiftClaimed log
 * emitted by `vault` for exactly `giftId` and `recipient` (addresses through getAddress on both
 * sides). A returned hash alone never counts. Returns false when there is no receipt yet;
 * throws when the node itself fails, so a caller can tell "not yet" from "cannot tell".
 */
export async function confirmClaim(client: PublicClient, vault: Address, txHash: Hex, giftId: bigint, recipient: Address): Promise<boolean> {
  if (typeof txHash !== "string" || !ANY_HASH_TEXT.test(txHash) || typeof giftId !== "bigint") return false;
  const expectedVault = getAddress(vault);
  const expectedRecipient = getAddress(recipient);
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return false;
    throw err;
  }
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) return false;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== expectedVault) continue;
    try {
      const event = decodeEventLog({ abi: giftVaultAbi, eventName: "GiftClaimed", topics: log.topics, data: log.data, strict: true });
      if (event.args.giftId === giftId && getAddress(event.args.recipient) === expectedRecipient) return true;
    } catch {
      // Another vault event in the same transaction; keep looking.
    }
  }
  return false;
}
