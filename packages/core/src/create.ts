import {
  decodeEventLog,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  isHex,
  parseAbi,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { giftVaultAbi } from "./generated/giftVaultAbi.js";
import { MAX_NOTE_BYTES } from "./gift.js";

/** The largest gift Moi builds, in US dollars of USDT. */
export const MAX_GIFT_USD = "100";

// GiftVault MAX_LIFETIME. The vault checks expiry <= block.timestamp + MAX_LIFETIME, and block time
// only grows after signing, so an expiry that passes here still passes at inclusion.
const MAX_LIFETIME_SECONDS = 90n * 24n * 60n * 60n;
// WHY 10 minutes above the vault's 1 hour MIN_LIFETIME: the vault checks expiry >= block.timestamp
// + 1 hour at inclusion, which comes after the sender reads the clock, reviews and signs. An
// expiry of exactly now + 1 hour would pass here and then revert on chain, costing the sender gas.
const MIN_LIFETIME_SECONDS = 60n * 60n + 10n * 60n;
const DEFAULT_LIFETIME_SECONDS = 30n * 24n * 60n * 60n;
const UINT256_MAX = (1n << 256n) - 1n;
// r, s and v: the only length OpenZeppelin ECDSA.recover accepts in createGift.
const KEY_PROOF_TEXT = /^0x[0-9a-fA-F]{130}$/;

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const GIFT_CREATED_TOPIC = toEventSelector(getAbiItem({ abi: giftVaultAbi, name: "GiftCreated" }));

export type CreateGiftInputCode =
  | "bad_address"
  | "zero_amount"
  | "zero_claim_key"
  | "expiry_out_of_range"
  | "bad_note"
  | "note_too_long"
  | "bad_key_proof";

/** Thrown when a transaction would be refused by the vault or is malformed, so it is never handed out to sign. */
export class CreateGiftInputError extends Error {
  readonly code: CreateGiftInputCode;
  constructor(code: CreateGiftInputCode, message: string) {
    super(message);
    this.name = "CreateGiftInputError";
    this.code = code;
  }
}

export type UnsignedTx = { to: Address; data: Hex; value: 0n };

function address(value: string, what: string): Address {
  try {
    const a = getAddress(value);
    if (a === zeroAddress) throw new Error("zero");
    return a;
  } catch {
    throw new CreateGiftInputError("bad_address", `${what} is not a usable address.`);
  }
}

function positiveAmount(amount: bigint): bigint {
  if (typeof amount !== "bigint" || amount <= 0n || amount > UINT256_MAX) {
    throw new CreateGiftInputError("zero_amount", "The amount must be a whole number of token units above zero.");
  }
  return amount;
}

/** Thirty days after `nowSeconds` (Unix seconds, ideally the latest block's timestamp). */
export function defaultExpiry(nowSeconds: bigint): bigint {
  return nowSeconds + DEFAULT_LIFETIME_SECONDS;
}

/**
 * The approval a sender signs before createGift: approve(vault, amount) on `token`, for exactly
 * this gift's amount and never more (C21). `vault` must be Moi's own configured vault address,
 * never one taken from a response. Throws CreateGiftInputError for a zero or malformed address
 * and for an amount that is zero or above uint256.
 */
export function buildApproveVaultTx(args: { token: Address; amount: bigint; vault: Address }): UnsignedTx {
  const token = address(args.token, "The token");
  const vault = address(args.vault, "The vault");
  const amount = positiveAmount(args.amount);
  return { to: token, data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [vault, amount] }), value: 0n };
}

/**
 * The createGift call a sender signs. Refuses locally everything the vault would refuse on its
 * inputs (C3), so a sender never signs a transaction that is certain to revert:
 * - a zero amount;
 * - a zero or malformed claim-key, token or vault address;
 * - an expiry outside nowSeconds + 1 hour 10 minutes to nowSeconds + 90 days inclusive (which
 *   also catches milliseconds passed as seconds; the extra 10 minutes covers the time between
 *   reading the clock and inclusion, against the vault's own 1 hour bound);
 * - a sealed note that is not even-length hex or is above MAX_NOTE_BYTES (512) bytes;
 * - a key proof that is not exactly 65 bytes of hex.
 * Not checked here: that the token is listed and the claim key unused (the vault checks both;
 * the caller should take the token from the vault's list), that the key proof was signed by the
 * claim key for the address that will send this transaction (make it with gift.ts signKeyProof;
 * the vault refuses any other with BadKeyProof, C32), and a transaction left unsigned for more
 * than 10 minutes.
 * Throws CreateGiftInputError with a fixed code. Sends nothing.
 */
export function buildCreateGiftTx(args: {
  vault: Address;
  token: Address;
  amount: bigint;
  claimKeyAddress: Address;
  expiry: bigint;
  sealedNote: Hex;
  keyProof: Hex;
  nowSeconds: bigint;
}): UnsignedTx {
  const vault = address(args.vault, "The vault");
  const token = address(args.token, "The token");
  const amount = positiveAmount(args.amount);
  let claimKey: Address;
  try {
    claimKey = getAddress(args.claimKeyAddress);
  } catch {
    throw new CreateGiftInputError("bad_address", "The claim key address is not a valid address.");
  }
  if (claimKey === zeroAddress) throw new CreateGiftInputError("zero_claim_key", "The claim key address is zero.");

  const { expiry, nowSeconds } = args;
  if (typeof expiry !== "bigint" || typeof nowSeconds !== "bigint" || nowSeconds <= 0n) {
    throw new CreateGiftInputError("expiry_out_of_range", "The expiry and the current time must be Unix seconds.");
  }
  if (expiry < nowSeconds + MIN_LIFETIME_SECONDS || expiry > nowSeconds + MAX_LIFETIME_SECONDS) {
    throw new CreateGiftInputError("expiry_out_of_range", "The expiry must be between 1 hour 10 minutes and 90 days from now.");
  }

  const note = args.sealedNote;
  if (typeof note !== "string" || note.length % 2 !== 0 || !isHex(note, { strict: true })) {
    throw new CreateGiftInputError("bad_note", "The sealed note is not hex.");
  }
  if ((note.length - 2) / 2 > MAX_NOTE_BYTES) {
    throw new CreateGiftInputError("note_too_long", `The sealed note is above ${MAX_NOTE_BYTES} bytes.`);
  }

  const proof = args.keyProof;
  if (typeof proof !== "string" || !KEY_PROOF_TEXT.test(proof)) {
    throw new CreateGiftInputError("bad_key_proof", "The claim key proof must be exactly 65 bytes of hex.");
  }

  const data = encodeFunctionData({
    abi: giftVaultAbi,
    functionName: "createGift",
    args: [token, amount, claimKey, expiry, note.toLowerCase() as Hex, proof.toLowerCase() as Hex],
  });
  return { to: vault, data, value: 0n };
}

/** The receipt fields readGiftIdFromReceipt reads. A viem TransactionReceipt fits it. */
export type ReceiptLike = {
  status: string;
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
};

/**
 * The gift id from a createGift receipt: the GiftCreated log emitted by `vault` itself. Logs from
 * any other address are ignored, so a token or a lookalike contract in the same transaction
 * cannot supply the id. Throws when the receipt did not succeed, when there is not exactly one
 * GiftCreated log from the vault, or when that log does not decode.
 */
export function readGiftIdFromReceipt(receipt: ReceiptLike, vault: Address): bigint {
  const expected = getAddress(vault);
  if (receipt?.status !== "success") throw new Error("The createGift transaction did not succeed.");
  const ids: bigint[] = [];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== expected || log.topics[0]?.toLowerCase() !== GIFT_CREATED_TOPIC) continue;
    const event = decodeEventLog({
      abi: giftVaultAbi,
      eventName: "GiftCreated",
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
      strict: true,
    });
    ids.push(event.args.giftId);
  }
  if (ids.length !== 1) throw new Error(`Expected exactly one GiftCreated event from the vault, found ${ids.length}.`);
  return ids[0]!;
}
