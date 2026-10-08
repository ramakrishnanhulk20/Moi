import {
  decodeEventLog,
  erc20Abi,
  getAddress,
  isAddress,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { z } from "zod";
import { parseAmount } from "./amounts.js";
import { assertChain } from "./chain.js";
import { parseGiftId } from "./gift.js";
import { keys, type KvStore, type StoreKey } from "./store.js";
import { readGift } from "./vault.js";
import type { Web3Api } from "./web3api.js";

/** A stablecoin a gift's wrapping fee can be paid in. `name` is the EIP-712 name b402 lists it under. */
export type WrapAsset = { symbol: string; address: Address; decimals: number; name: string };

/**
 * The one list of assets the wrapping fee is taken in. b402's /supported names a token only by its
 * EIP-712 name and gives no address, so this list is the bridge; a /supported kind whose name is not
 * here is ignored. Proved on BSC mainnet at block 126276537 (2026-10-07) by
 * scratchpad/wo4d/assets.mjs: each address has code, its name() equals the /supported name, and
 * decimals() is 18. For U and USD1 (eip3009) the on-chain DOMAIN_SEPARATOR also equals the EIP-712
 * domain of that name, version "1", chain 56 and the address. USDT and USDC are offered only through
 * Permit2, which signs against Permit2's own domain.
 */
export const WRAP_ASSETS: readonly WrapAsset[] = Object.freeze(
  [
    { symbol: "U", address: "0xcE24439F2D9C6a2289F741120FE202248B666666", decimals: 18, name: "United Stables" },
    { symbol: "USD1", address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", decimals: 18, name: "World Liberty Financial USD" },
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, name: "Tether USD" },
    { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, name: "USD Coin" },
  ].map((a) => Object.freeze({ ...a, address: getAddress(a.address) })),
);

export const WRAP_NETWORK = "eip155:56";
/**
 * How long a buyer's payment signature should stay valid. The Agentic Wallet signs eip3009
 * payments valid for 120 seconds, so a shorter window would only cause expired payments.
 */
export const WRAP_MAX_TIMEOUT_SECONDS = 120;
const SUPPORTED_CACHE_MS = 10 * 60 * 1000;
// /supported listed 10 kinds on 2026-10-07. A reply far above that is not one to build a 402 from.
const MAX_SUPPORTED_KINDS = 64;
// The fee is a few cents. One dollar is the ceiling so a typo in the setting cannot ask for $50.
const MAX_PRICE_MICRO_USD = 1_000_000n;

/** Thrown when the server's own wrap settings (payee, origin, price) are unusable. */
export class WrapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapConfigError";
  }
}

/** One x402 v2 payment requirement, the shape b402 verifies and settles against. */
export type PaymentRequirementsV2 = {
  scheme: "exact";
  network: typeof WRAP_NETWORK;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

const addressText = z.string().refine((a) => isAddress(a));
const nameText = z.string().min(1).max(64);
const versionText = z.string().min(1).max(16);

// Only the two "exact" methods are offered; permit2-upto lets the merchant pick the amount at
// settle time, which is not a promise this fee makes. Each extra is checked key by key before it is
// copied to a buyer (standard 3): an unknown key, or a signer or spender that is not an address,
// drops the kind instead of passing it on.
const extraSchema = z.union([
  z.strictObject({
    name: nameText,
    version: versionText,
    assetTransferMethod: z.literal("eip3009"),
    signerAddress: addressText,
    spenderAddress: z.null().optional(),
  }),
  z.strictObject({
    name: nameText,
    version: versionText,
    assetTransferMethod: z.literal("permit2-exact"),
    signerAddress: addressText,
    spenderAddress: addressText,
  }),
]);

const kindSchema = z.object({
  x402Version: z.literal(2),
  scheme: z.literal("exact"),
  network: z.literal(WRAP_NETWORK),
  extra: extraSchema,
});

type Kind = { name: string; extra: Record<string, unknown> };

const supportedCache = new WeakMap<Web3Api, { fetchedAt: number; kinds: Promise<Kind[]> }>();

async function fetchKinds(api: Web3Api): Promise<Kind[]> {
  const data = await api.post("/api/v2/b402/supported", { body: {} });
  const kinds = (data as { kinds?: unknown } | null)?.kinds;
  if (!Array.isArray(kinds) || kinds.length > MAX_SUPPORTED_KINDS) throw new Error("b402 /supported has no usable kinds list");
  const usable: Kind[] = [];
  for (const raw of kinds) {
    const kind = kindSchema.safeParse(raw);
    if (!kind.success) continue;
    usable.push({ name: kind.data.extra.name, extra: structuredClone((raw as { extra: Record<string, unknown> }).extra) });
  }
  return usable;
}

// One /supported call per api client per 10 minutes, shared by concurrent callers. A failed call
// is not cached, so the next request asks again instead of serving an error for 10 minutes.
function cachedKinds(api: Web3Api, now: number): Promise<Kind[]> {
  const hit = supportedCache.get(api);
  if (hit !== undefined && now - hit.fetchedAt < SUPPORTED_CACHE_MS && now >= hit.fetchedAt) return hit.kinds;
  const kinds = fetchKinds(api);
  const entry = { fetchedAt: now, kinds };
  supportedCache.set(api, entry);
  kinds.catch(() => {
    if (supportedCache.get(api) === entry) supportedCache.delete(api);
  });
  return kinds;
}

/** The payee from server config through getAddress. Throws WrapConfigError for a malformed or zero address. */
export function canonicalPayTo(payTo: string): Address {
  let address: Address;
  try {
    address = getAddress(payTo);
  } catch {
    throw new WrapConfigError("The wrap payee address is not a valid address.");
  }
  if (address === zeroAddress) throw new WrapConfigError("The wrap payee address is the zero address.");
  return address;
}

/**
 * The site origin from server config, through the standard URL parser: https, or http on
 * localhost for development, with no path, query or fragment. Returns the parser's origin (no
 * trailing slash). Throws WrapConfigError otherwise.
 */
export function canonicalOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new WrapConfigError("The public origin is not a valid URL.");
  }
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  if (!allowed || url.href !== `${url.origin}/`) {
    throw new WrapConfigError("The public origin must be an https origin (or http://localhost) with no path, query or fragment.");
  }
  return url.origin;
}

/**
 * The wrap price in US dollars as a plain decimal string ("0.05"): above zero, at most $1 and at
 * most 6 decimal places. Returns it unchanged. Throws WrapConfigError otherwise. Every place that
 * reads the price uses this check, so the setting and the 402 can never disagree on what is valid.
 */
export function checkWrapPriceUsd(priceUsd: string): string {
  let micro: bigint;
  try {
    micro = parseAmount(priceUsd, 6);
  } catch {
    throw new WrapConfigError("The wrap price must be a decimal number of dollars above zero with at most 6 decimal places.");
  }
  if (micro > MAX_PRICE_MICRO_USD) throw new WrapConfigError("The wrap price is above the $1 ceiling.");
  return priceUsd;
}

/** The x402 v2 resource a wrap payment is for: `${origin}/api/wrap/${giftId}`, from config and the parsed id only (C24). */
export function wrapResource(origin: string, giftId: bigint): { url: string; description: string; mimeType: string } {
  const id = parseGiftId(typeof giftId === "bigint" ? giftId.toString() : "");
  return { url: `${canonicalOrigin(origin)}/api/wrap/${id}`, description: "Moi gift wrapping", mimeType: "application/json" };
}

/**
 * The 402 payment requirements for wrapping gift `giftId`: one per "exact" kind on eip155:56 in
 * b402's /supported answer (cached 10 minutes per api client) whose EIP-712 name is in WRAP_ASSETS,
 * in /supported order. Each carries the price in that asset's decimals by integer math (the
 * stablecoins are taken at one dollar each), the payee from config, a 120-second timeout and the
 * kind's `extra` copied verbatim. Built only from config and the parsed gift id, never from a
 * request header (C24); the resource URL lives beside the list (wrapResource), as x402 v2 and
 * b402's V2 API place it. Returns an empty list when no kind qualifies.
 * Throws WrapConfigError for a bad payee, origin or price, LinkError for a gift id outside 1 to
 * 2^256 - 1, and whatever the api throws when /supported cannot be read.
 */
export async function buildPaymentRequirements(
  deps: { api: Web3Api; origin: string; payTo: Address; priceUsd: string; now?: () => number },
  giftId: bigint,
): Promise<PaymentRequirementsV2[]> {
  wrapResource(deps.origin, giftId);
  const payTo = canonicalPayTo(deps.payTo);
  const priceUsd = checkWrapPriceUsd(deps.priceUsd);
  const kinds = await cachedKinds(deps.api, (deps.now ?? Date.now)());
  const requirements: PaymentRequirementsV2[] = [];
  for (const kind of kinds) {
    const asset = WRAP_ASSETS.find((a) => a.name === kind.name);
    if (asset === undefined) continue;
    requirements.push({
      scheme: "exact",
      network: WRAP_NETWORK,
      amount: parseAmount(priceUsd, asset.decimals).toString(),
      asset: asset.address,
      payTo,
      maxTimeoutSeconds: WRAP_MAX_TIMEOUT_SECONDS,
      extra: structuredClone(kind.extra),
    });
  }
  return requirements;
}

/** Every answer the wrap route can give that is not a 200. Short, fixed, never upstream text (C19). */
export type WrapErrorCode =
  | "bad_gift_id"
  | "gift_not_found"
  | "gift_not_open"
  | "gift_expiring"
  | "wrap_in_progress"
  | "payment_malformed"
  | "payment_mismatch"
  | "payment_reused"
  | "payment_invalid"
  | "payment_failed"
  | "settlement_pending"
  | "settlement_unexpected"
  | "facilitator_unavailable"
  | "store_unavailable"
  | "chain_unavailable"
  | "server_misconfigured";

export type WrapResponse = { status: number; headers?: Record<string, string>; body: unknown };

/** The x402 v2 header names: the 402 challenge, the buyer's signed payment, and the settlement receipt. */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

const STATUS: Record<WrapErrorCode, number> = {
  bad_gift_id: 400,
  gift_not_found: 404,
  gift_not_open: 409,
  gift_expiring: 409,
  wrap_in_progress: 409,
  payment_malformed: 402,
  payment_mismatch: 402,
  payment_reused: 402,
  payment_invalid: 402,
  payment_failed: 402,
  settlement_pending: 202,
  settlement_unexpected: 502,
  facilitator_unavailable: 502,
  store_unavailable: 502,
  chain_unavailable: 502,
  server_misconfigured: 500,
};

// A real payment header is about 1.5 KB of base64. Anything past 8 KB is refused before decoding.
const MAX_PAYMENT_HEADER_CHARS = 8 * 1024;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const DAY_SECONDS = 86_400;
// One payment marks one gift. The mark outlives any payment Moi accepts, because an authorization
// valid longer than a day is refused (MAX_AUTHORIZATION_SECONDS), so a replay after the mark expires
// is already past its own deadline.
const PAYMENT_NONCE_TTL_SECONDS = 30 * DAY_SECONDS;
const MAX_AUTHORIZATION_SECONDS = DAY_SECONDS;
// A settlement receipt stays on chain for good, so the Transfer that marked a gift stays marked for
// as long as the store allows (ten years), not just as long as a payment can be replayed.
const SETTLEMENT_USED_TTL_SECONDS = 10 * 365 * DAY_SECONDS;
// b402 keeps reconciling a broadcast settlement for about 30 minutes. Holding the gift for that long
// after an unfinished settlement stops a second payment for the same gift while the first may land.
const WRAP_LOCK_TTL_SECONDS = 30 * 60;
// b402's settle page asks for a poll about every 3 to 5 seconds.
const SETTLE_POLL_INTERVAL_MS = 4_000;
// One request waits this long at most; a payment still settling after it is resumed by replaying
// it, so no single serverless invocation has to outlast b402's confirmation.
export const DEFAULT_SETTLE_BUDGET_MS = 25_000;
const MAX_SETTLE_BUDGET_MS = 300_000;
export const WRAP_RETRY_AFTER_SECONDS = 5;
// The same margin the judge handout keeps: a gift with less than this left could expire before a
// claim lands, so nobody pays to wrap it.
const MIN_SECONDS_LEFT = 10n * 60n;
const MARK_WRITE_ATTEMPTS = 3;
const MAX_STORED_VALUE_CHARS = 1_024;
const TX_HASH_TEXT = /^0x[0-9a-fA-F]{64}$/;
const HEX32_TEXT = /^0x[0-9a-f]{64}$/;
const UINT256_LIMIT = 1n << 256n;

const uintText = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const signatureText = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

const eip3009Payload = z.strictObject({
  signature: signatureText,
  authorization: z.strictObject({
    from: addressText,
    to: addressText,
    value: uintText,
    validAfter: uintText,
    validBefore: uintText,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});

const permit2Payload = z.strictObject({
  signature: signatureText,
  permit2Authorization: z.strictObject({
    permitted: z.strictObject({ token: addressText, amount: uintText }),
    from: addressText,
    spender: addressText,
    nonce: uintText,
    deadline: uintText,
    // b402 binds a facilitator into the witness only for permit2-upto, which is never offered here.
    witness: z.strictObject({ to: addressText, validAfter: uintText, facilitator: z.null().optional() }),
  }),
});

// Parsed once, transform free, so the object compared with the requirements is the very object
// sent to verify and to settle (standard 2). Extensions are refused because b402 reads
// extensions.bazaar on settle to publish a listing, and no buyer gets to write Moi's listing.
const paymentPayloadSchema = z.strictObject({
  x402Version: z.literal(2),
  resource: z
    .strictObject({ url: z.string().max(2_048), description: z.string().max(256).optional(), mimeType: z.string().max(128).optional() })
    .optional(),
  accepted: z.strictObject({
    scheme: z.string().max(16),
    network: z.string().max(32),
    amount: uintText,
    asset: addressText,
    payTo: addressText,
    maxTimeoutSeconds: z.number().int().min(1).max(DAY_SECONDS),
    extra: z.record(z.string().max(64), z.unknown()),
  }),
  payload: z.union([eip3009Payload, permit2Payload]),
  extensions: z.strictObject({}).optional(),
});

/** A decoded x402 v2 payment, exactly as the buyer sent it after one schema check. */
export type PaymentPayloadV2 = z.infer<typeof paymentPayloadSchema>;

const wrapRecordSchema = z.strictObject({
  txHash: z.string().regex(HEX32_TEXT),
  asset: addressText.refine((a) => WRAP_ASSETS.some((w) => w.address === getAddress(a))),
  amount: uintText,
  settledAt: z.iso.datetime(),
});

/** What keys.wrapped holds once a gift's wrapping fee has settled on chain. */
export type WrapRecord = z.infer<typeof wrapRecordSchema>;

// While a payment is being settled the gift's wrapped key holds this lock, naming the payment's
// nonce so a replay of that same payment can carry on under it.
const lockSchema = z.strictObject({ lock: z.uuid(), payment: z.string().regex(HEX32_TEXT) });

// What keys.paymentAuth holds: the vault and gift this payment is bound to and a SHA-256 of the
// decoded payment, all server-made (C25), so only that exact payment for that gift on that vault can
// resume (C42). The key is per payee and nonce, not per vault, because a gift id means nothing
// without its vault: gift 5 on one vault and gift 5 on another are different gifts.
const bindingSchema = z.strictObject({
  vault: z.string().refine((a) => isAddress(a) && getAddress(a) === a),
  giftId: z.string().regex(/^[1-9][0-9]{0,77}$/),
  payment: z.string().regex(HEX32_TEXT),
  mark: z.uuid(),
});

// What keys.settlementUsed holds: the one gift a Transfer inside a settlement receipt paid for
// (C44). Never released: the receipt is permanent, so the mark is too.
const settlementBindingSchema = z.strictObject({
  vault: z.string().refine((a) => isAddress(a) && getAddress(a) === a),
  giftId: z.string().regex(/^[1-9][0-9]{0,77}$/),
});

type WrapState =
  | { kind: "none" }
  | { kind: "wrapped"; record: WrapRecord }
  | { kind: "locked"; payment: string; raw: string }
  | { kind: "corrupt" };

function parseStored(value: string): unknown {
  if (typeof value !== "string" || value.length > MAX_STORED_VALUE_CHARS) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// A stored value is read back like input (standard 3, C25): only a record this file wrote counts
// as wrapped, and anything else under the key is neither wrapped nor free.
function readWrapState(value: string | null): WrapState {
  if (value === null) return { kind: "none" };
  const json = parseStored(value);
  const record = wrapRecordSchema.safeParse(json);
  if (record.success) return { kind: "wrapped", record: record.data };
  const lock = lockSchema.safeParse(json);
  return lock.success ? { kind: "locked", payment: lock.data.payment, raw: value } : { kind: "corrupt" };
}

/**
 * True only when keys.wrapped(vault, giftId) holds a settlement record handleWrap wrote: a
 * lowercase transaction hash, a WRAP_ASSETS asset, an amount and a time. An in-flight wrap, a
 * missing key or anything malformed is false. Throws when the store cannot answer (the caller
 * refuses, never treats that as unwrapped or wrapped) and on a vault or gift id the key builder
 * refuses.
 */
export async function isWrapped(store: KvStore, vault: Address, giftId: bigint): Promise<boolean> {
  return readWrapState(await store.get(keys.wrapped(vault, giftId))).kind === "wrapped";
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return `0x${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// One strict decode: standard base64 only, at most 8 KB, valid UTF-8, one JSON.parse, one schema
// parse. Null for anything else, which the caller answers with 402 (fail closed).
function decodePayment(header: string): PaymentPayloadV2 | null {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_PAYMENT_HEADER_CHARS) return null;
  if (header.length % 4 !== 0 || !BASE64_TEXT.test(header)) return null;
  let json: unknown;
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const parsed = paymentPayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// Addresses go through getAddress on both sides (standard 2); every other field, extra included,
// must be identical to what this server offered.
function sameRequirement(ours: PaymentRequirementsV2, theirs: PaymentPayloadV2["accepted"]): boolean {
  return (
    theirs.scheme === ours.scheme &&
    theirs.network === ours.network &&
    theirs.amount === ours.amount &&
    getAddress(theirs.asset) === ours.asset &&
    getAddress(theirs.payTo) === ours.payTo &&
    theirs.maxTimeoutSeconds === ours.maxTimeoutSeconds &&
    sameJson(theirs.extra, ours.extra)
  );
}

type MatchedPayment = { requirement: PaymentRequirementsV2; nonceHex: Hex; payer: Address };

/**
 * The requirement this payment accepted, if it is one this server built, and the signed
 * authorization moves exactly that amount of that asset to the configured payee through that
 * method, before a deadline no more than a day away. b402 checks the signature itself; these checks
 * stop a payment that would verify for a different price, asset or payee.
 */
function matchPayment(
  payment: PaymentPayloadV2,
  requirements: readonly PaymentRequirementsV2[],
  resourceUrl: string,
  nowSeconds: bigint,
): MatchedPayment | null {
  if (payment.resource !== undefined && payment.resource.url !== resourceUrl) return null;
  const requirement = requirements.find((r) => sameRequirement(r, payment.accepted));
  if (requirement === undefined) return null;
  const latestDeadline = nowSeconds + BigInt(MAX_AUTHORIZATION_SECONDS);
  const method = requirement.extra.assetTransferMethod;
  const body = payment.payload;
  if (method === "eip3009" && "authorization" in body) {
    const auth = body.authorization;
    if (getAddress(auth.to) !== requirement.payTo || auth.value !== requirement.amount) return null;
    if (BigInt(auth.validBefore) > latestDeadline) return null;
    return { requirement, nonceHex: auth.nonce.toLowerCase() as Hex, payer: getAddress(auth.from) };
  }
  if (method === "permit2-exact" && "permit2Authorization" in body) {
    const auth = body.permit2Authorization;
    const spender = requirement.extra.spenderAddress;
    if (typeof spender !== "string" || getAddress(auth.spender) !== getAddress(spender)) return null;
    if (getAddress(auth.permitted.token) !== requirement.asset || auth.permitted.amount !== requirement.amount) return null;
    if (getAddress(auth.witness.to) !== requirement.payTo || BigInt(auth.deadline) > latestDeadline) return null;
    const nonce = BigInt(auth.nonce);
    if (nonce >= UINT256_LIMIT) return null;
    // Written in the same 32-byte form as an eip3009 nonce, so one number is one mark however it
    // was spelled. b402 settles a (nonce, network, payer) once and answers repeats from its cache,
    // so this mark must never be finer than that tuple.
    return { requirement, nonceHex: `0x${nonce.toString(16).padStart(64, "0")}`, payer: getAddress(auth.from) };
  }
  return null;
}

type SettleOutcome = { kind: "settled"; txHash: Hex } | { kind: "failed" } | { kind: "pending" } | { kind: "unexpected" };

const settleDataSchema = z.object({
  success: z.boolean(),
  transaction: z.string().max(256),
  network: z.string().max(64).optional(),
  amount: z.string().max(80).optional(),
});

// b402 V2 settle outcomes (Settle Payment V2, "Settlement outcomes and polling"): success with a
// hash is final; success false with an empty transaction never broadcast and is final; success
// false with a hash was broadcast and is polled again. Anything unreadable is polled again, never
// read as success.
function classifySettle(data: unknown, requirement: PaymentRequirementsV2): SettleOutcome | null {
  const parsed = settleDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.success) {
    if (!TX_HASH_TEXT.test(s.transaction)) return { kind: "unexpected" };
    if (s.network !== undefined && s.network !== WRAP_NETWORK) return { kind: "unexpected" };
    if (s.amount !== undefined && s.amount !== requirement.amount) return { kind: "unexpected" };
    return { kind: "settled", txHash: s.transaction.toLowerCase() as Hex };
  }
  return s.transaction === "" ? { kind: "failed" } : { kind: "pending" };
}

type OnChain = { kind: "pending" } | { kind: "unexpected" } | { kind: "paid"; positions: number[] };

/**
 * C42: what the chain itself says about a settlement b402 reported. "paid" only when the node has a
 * receipt for exactly `txHash`, it succeeded, and it holds at least one standard ERC-20 Transfer
 * emitted by the requirement's asset to the requirement's payee for exactly the requirement's
 * amount; `positions` are those Transfers' places in the receipt's log list, the ones from `payer`
 * first. "pending" when the node has no receipt yet. "unexpected" for any other receipt. Throws when
 * the node itself fails, so a caller can tell "not yet" from "cannot tell".
 * Covers a hash that b402 got wrong or that is not this payment's kind of transfer. Does not refuse
 * a Transfer from another address, because no live b402 settlement has yet shown whether the
 * facilitator moves the fee straight from the payer; the caller binds each Transfer to one gift
 * instead (C44), so a receipt can never pay for more gifts than it holds Transfers.
 */
async function settlementOnChain(client: PublicClient, txHash: Hex, requirement: PaymentRequirementsV2, payer: Address): Promise<OnChain> {
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return { kind: "pending" };
    throw err;
  }
  if (receipt.status !== "success" || typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== txHash) return { kind: "unexpected" };
  const amount = BigInt(requirement.amount);
  const fromPayer: number[] = [];
  const fromOthers: number[] = [];
  receipt.logs.forEach((log, position) => {
    if (!isAddress(log.address, { strict: false }) || getAddress(log.address) !== requirement.asset) return;
    try {
      // The library's ERC-20 ABI, decoded strictly, so an NFT Transfer (same topic, the id indexed)
      // or any other event the asset emits never reads as a payment.
      const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.topics, data: log.data, strict: true });
      if (getAddress(event.args.to) !== requirement.payTo || event.args.value !== amount) return;
      (getAddress(event.args.from) === payer ? fromPayer : fromOthers).push(position);
    } catch {
      // Another event from the asset, such as Approval or AuthorizationUsed; keep looking.
    }
  });
  const positions = [...fromPayer, ...fromOthers];
  return positions.length === 0 ? { kind: "unexpected" } : { kind: "paid", positions };
}

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

async function settleWithinBudget(
  api: Web3Api,
  envelope: unknown,
  requirement: PaymentRequirementsV2,
  clock: Clock,
  budgetMs: number,
): Promise<SettleOutcome> {
  const deadline = clock.now() + budgetMs;
  for (;;) {
    let outcome: SettleOutcome | null = null;
    try {
      outcome = classifySettle(await api.post("/api/v2/b402/settle", envelope), requirement);
    } catch {
      // A transport or gateway error says nothing about whether b402 broadcast. Settle is
      // idempotent per payment, so asking again is the only safe reading.
    }
    if (outcome !== null && outcome.kind !== "pending") return outcome;
    if (clock.now() + SETTLE_POLL_INTERVAL_MS > deadline) return { kind: "pending" };
    await clock.sleep(SETTLE_POLL_INTERVAL_MS);
  }
}

const fail = (error: WrapErrorCode): WrapResponse => ({ status: STATUS[error], body: { ok: false, error } });

// The payment is bound to this gift and may still settle, so the buyer replays the same header
// after the pause and the request carries on where this one stopped.
const retryLater = (error: "settlement_pending" | "store_unavailable", status: number): WrapResponse => ({
  status,
  headers: { "Retry-After": String(WRAP_RETRY_AFTER_SECONDS) },
  body: { ok: false, error, retryAfterSeconds: WRAP_RETRY_AFTER_SECONDS },
});

// Only a value this request wrote is removed, so a release never frees another request's mark.
async function releaseIfOurs(store: KvStore, k: StoreKey, value: string): Promise<void> {
  try {
    if ((await store.get(k)) === value) await store.del(k);
  } catch {
    // Both marks carry a TTL, so a failed release only delays a retry.
  }
}

export type WrapDeps = {
  api: Web3Api;
  client: PublicClient;
  vault: Address;
  store: KvStore;
  origin: string;
  payTo: Address;
  priceUsd: string;
  /** How long one request polls a settlement before answering 202. DEFAULT_SETTLE_BUDGET_MS by default. */
  settleBudgetMs?: number;
  /** Milliseconds since the epoch. Date.now by default. */
  now?: () => number;
  /** Waits between settle polls. setTimeout by default. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The /api/wrap/:giftId handler, framework free. `giftIdText` is the path segment and
 * `paymentHeader` the raw PAYMENT-SIGNATURE header, or null. Answers with the first that applies:
 * 1. the id through parseGiftId (400 bad_gift_id), the gift from chain: never created (404
 *    gift_not_found) or not Open (409 gift_not_open);
 * 2. a settlement record already under keys.wrapped: 200 {ok, wrapped, txHash}, nothing charged;
 *    another wrap still in flight and no payment to resume: 409 wrap_in_progress;
 * 3. no header: 409 gift_expiring when the gift's expiry is less than 10 minutes after the latest
 *    block, else 402 with the x402 v2 PaymentRequired object {x402Version: 2, resource, accepts}
 *    as the body and, base64 encoded, as the PAYMENT-REQUIRED header. The requirements come only
 *    from config, /supported and the parsed id (C24);
 * 4. the header decoded once (8 KB cap) and parsed once; its accepted requirement must equal one
 *    built here and its signed authorization must pay exactly that amount of that asset to the
 *    payee, or 402 again with an error code;
 * 5. its nonce bound under keys.paymentAuth(payTo, payer, nonce) for 30 days to this vault, this
 *    gift and a hash of this exact payment (C42). A nonce bound to another vault, another gift or
 *    another payment is refused (402 payment_reused); another payer's equal nonce is another mark.
 *    The same payment for the same gift on the same vault is a replay and resumes at step 6's
 *    settle, skipping verify (b402 documents settle as idempotent). A new payment is refused with
 *    409 gift_expiring as in step 3. The gift is held so a second payment cannot run beside this one;
 * 6. a new payment goes to b402 verify: not valid gives 402 payment_invalid with both marks
 *    released. Then b402 settle, polled every 4 seconds within `settleBudgetMs` (25 s by default).
 *    Only success with a transaction hash, on eip155:56, for this amount, can mark the gift (C24),
 *    and only once the chain's own receipt for that hash succeeded and holds an ERC-20 Transfer of
 *    exactly this amount of this asset to the payee (C42) that no other gift has used: each such
 *    Transfer is bound under keys.settlementUsed(payTo, hash, position) to one gift, for good, so a
 *    facilitator answering an old hash marks nothing and a batched receipt marks one gift per
 *    Transfer (C44). No receipt yet gives the 202 below; any other receipt, or one whose Transfers
 *    all belong to other gifts, gives 502 settlement_unexpected and a node failure 502
 *    chain_unavailable, both marking nothing and keeping gift and payment held for a replay. A
 *    settlement that never broadcast gives 402 payment_failed. One still pending when the budget
 *    ends gives 202 {ok: false, error: "settlement_pending", retryAfterSeconds: 5} with a
 *    Retry-After header and marks nothing; replaying the same payment resumes it. A store failure
 *    while binding the Transfer or marking a settled payment gives 503 store_unavailable with the
 *    same retry fields, and a replay marks it;
 * 7. 200 {ok: true, wrapped: true, txHash} with the x402 v2 PAYMENT-RESPONSE header.
 * The node must report chain 56 before anything is read from it (C45; else 502 chain_unavailable).
 * Every b402 call goes through `api`, the fixed-path Web3 API client (C20). Never throws, and no
 * b402, chain or store text reaches a response (C19).
 */
export async function handleWrap(deps: WrapDeps, giftIdText: string, paymentHeader: string | null): Promise<WrapResponse> {
  try {
    return await wrap(deps, giftIdText, paymentHeader);
  } catch {
    // Every step below answers its own failures; reaching here means a dependency broke its own
    // contract before the mark, so nothing is marked.
    return fail("server_misconfigured");
  }
}

async function wrap(deps: WrapDeps, giftIdText: string, paymentHeader: string | null): Promise<WrapResponse> {
  let giftId: bigint;
  try {
    giftId = parseGiftId(giftIdText);
  } catch {
    return fail("bad_gift_id");
  }
  let vault: Address;
  let payTo: Address;
  let origin: string;
  let priceUsd: string;
  const budgetMs = deps.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS;
  try {
    vault = getAddress(deps.vault);
    payTo = canonicalPayTo(deps.payTo);
    origin = canonicalOrigin(deps.origin);
    priceUsd = checkWrapPriceUsd(deps.priceUsd);
  } catch {
    return fail("server_misconfigured");
  }
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > MAX_SETTLE_BUDGET_MS) return fail("server_misconfigured");
  const clock: Clock = {
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  let expiry: bigint;
  try {
    // WHY (C45): a node on another chain could hand back a gift record or a settlement receipt
    // that means nothing here, so nothing is read from it until it has said it serves chain 56.
    await assertChain(deps.client);
    const gift = await readGift(deps.client, vault, giftId);
    if (gift.state === "None") return fail("gift_not_found");
    if (gift.state !== "Open") return fail("gift_not_open");
    expiry = gift.expiry;
  } catch {
    return fail("chain_unavailable");
  }

  const wrappedKey = keys.wrapped(vault, giftId);
  const answerFor = (state: WrapState): WrapResponse => {
    if (state.kind === "wrapped") return { status: 200, body: { ok: true, wrapped: true, txHash: state.record.txHash } };
    if (state.kind === "corrupt") return fail("store_unavailable");
    // A key that emptied in between (a lock that just ran out) is still in progress, never free.
    return fail("wrap_in_progress");
  };
  let current: WrapState;
  try {
    current = readWrapState(await deps.store.get(wrappedKey));
  } catch {
    return fail("store_unavailable");
  }
  if (current.kind === "wrapped" || current.kind === "corrupt") return answerFor(current);
  if (current.kind === "locked" && paymentHeader === null) return answerFor(current);

  let expiring: boolean;
  try {
    expiring = expiry - (await deps.client.getBlock({ blockTag: "latest" })).timestamp < MIN_SECONDS_LEFT;
  } catch {
    return fail("chain_unavailable");
  }

  let requirements: PaymentRequirementsV2[];
  try {
    requirements = await buildPaymentRequirements({ api: deps.api, origin, payTo, priceUsd, now: clock.now }, giftId);
  } catch {
    return fail("facilitator_unavailable");
  }
  if (requirements.length === 0) return fail("facilitator_unavailable");
  const resource = wrapResource(origin, giftId);
  const paymentRequired = (error?: WrapErrorCode): WrapResponse => {
    const body = { x402Version: 2, ...(error === undefined ? {} : { error }), resource, accepts: requirements };
    return { status: 402, headers: { [PAYMENT_REQUIRED_HEADER]: toBase64(JSON.stringify(body)) }, body };
  };

  if (paymentHeader === null) return expiring ? fail("gift_expiring") : paymentRequired();
  const payment = decodePayment(paymentHeader);
  if (payment === null) return paymentRequired("payment_malformed");
  const matched = matchPayment(payment, requirements, resource.url, BigInt(Math.floor(clock.now() / 1000)));
  if (matched === null) return paymentRequired("payment_mismatch");
  const { requirement } = matched;
  const paymentHash = await sha256Hex(JSON.stringify(payment));

  const nonceKey = keys.paymentAuth(payTo, matched.payer, matched.nonceHex);
  const binding = JSON.stringify({ vault, giftId: giftId.toString(), payment: paymentHash, mark: globalThis.crypto.randomUUID() });
  let resuming: boolean;
  try {
    resuming = !(await deps.store.setNx(nonceKey, binding, PAYMENT_NONCE_TTL_SECONDS));
    if (resuming) {
      const bound = bindingSchema.safeParse(parseStored((await deps.store.get(nonceKey)) ?? ""));
      // Both vault values are getAddress output (standard 2), so plain equality is the comparison.
      if (!bound.success || bound.data.vault !== vault || bound.data.giftId !== giftId.toString() || bound.data.payment !== paymentHash) {
        return paymentRequired("payment_reused");
      }
    }
  } catch {
    await releaseIfOurs(deps.store, nonceKey, binding);
    return fail("store_unavailable");
  }
  // A replay of a payment already bound here goes on even near expiry: its money may have moved,
  // and only a new payment is turned away.
  if (!resuming && expiring) {
    await releaseIfOurs(deps.store, nonceKey, binding);
    return fail("gift_expiring");
  }

  // WHY: two different payments for one gift running side by side would both settle. The gift is
  // held under its own wrapped key, naming this payment, until it settles, fails before broadcast,
  // or the lock runs out; isWrapped never reads a lock as wrapped.
  const lockValue = JSON.stringify({ lock: globalThis.crypto.randomUUID(), payment: matched.nonceHex });
  let lockMark = lockValue;
  try {
    if (!(await deps.store.setNx(wrappedKey, lockValue, WRAP_LOCK_TTL_SECONDS))) {
      const held = readWrapState(await deps.store.get(wrappedKey));
      if (resuming && held.kind === "locked" && held.payment === matched.nonceHex) {
        lockMark = held.raw;
      } else {
        if (!resuming) await releaseIfOurs(deps.store, nonceKey, binding);
        return answerFor(held);
      }
    }
  } catch {
    await releaseIfOurs(deps.store, wrappedKey, lockValue);
    if (!resuming) await releaseIfOurs(deps.store, nonceKey, binding);
    return fail("store_unavailable");
  }

  const envelope = { body: { x402Version: 2, paymentPayload: payment, paymentRequirements: requirement } };
  if (!resuming) {
    let isValid: unknown;
    try {
      isValid = ((await deps.api.post("/api/v2/b402/verify", envelope)) as { isValid?: unknown } | null)?.isValid;
    } catch {
      isValid = undefined;
    }
    if (isValid !== true) {
      await releaseIfOurs(deps.store, wrappedKey, lockMark);
      await releaseIfOurs(deps.store, nonceKey, binding);
      return isValid === false ? paymentRequired("payment_invalid") : fail("facilitator_unavailable");
    }
  }

  const outcome = await settleWithinBudget(deps.api, envelope, requirement, clock, budgetMs);
  if (outcome.kind === "failed") {
    // Nothing was broadcast, so the gift is free for a fresh payment. This payment stays bound:
    // b402 answers a repeat of it from its cache.
    await releaseIfOurs(deps.store, wrappedKey, lockMark);
    return paymentRequired("payment_failed");
  }
  if (outcome.kind === "pending") return retryLater("settlement_pending", STATUS.settlement_pending);
  if (outcome.kind === "unexpected") return fail("settlement_unexpected");

  // WHY (C42): b402 saying a payment settled is not proof that money reached Ram's wallet. The
  // receipt is read from the chain here, and only a Transfer of exactly the price marks the gift.
  // Every answer below that marks nothing keeps the gift held and the payment bound, so a replay
  // of the same header resumes here.
  let onChain: OnChain;
  try {
    onChain = await settlementOnChain(deps.client, outcome.txHash, requirement, matched.payer);
  } catch {
    return fail("chain_unavailable");
  }
  if (onChain.kind === "pending") return retryLater("settlement_pending", STATUS.settlement_pending);
  if (onChain.kind === "unexpected") return fail("settlement_unexpected");

  // WHY (C44): the receipt check above would pass again for any later gift handed the same hash,
  // and b402 is the only party that names the hash. Each exact Transfer in the receipt is bound to
  // the first gift that claims it, for good; this gift takes the first free one, or the one already
  // bound to it on a replay, and a receipt with none left marks nothing.
  const settlementBinding = JSON.stringify({ vault, giftId: giftId.toString() });
  let bound = false;
  try {
    for (const position of onChain.positions) {
      const usedKey = keys.settlementUsed(payTo, outcome.txHash, position);
      if (await deps.store.setNx(usedKey, settlementBinding, SETTLEMENT_USED_TTL_SECONDS)) {
        bound = true;
        break;
      }
      const holder = settlementBindingSchema.safeParse(parseStored((await deps.store.get(usedKey)) ?? ""));
      if (holder.success && holder.data.vault === vault && holder.data.giftId === giftId.toString()) {
        bound = true;
        break;
      }
    }
  } catch {
    // The payment has settled; the mark it paid for must not be lost to a short store outage.
    return retryLater("store_unavailable", 503);
  }
  if (!bound) return fail("settlement_unexpected");

  const record: WrapRecord = {
    txHash: outcome.txHash,
    asset: requirement.asset,
    amount: requirement.amount,
    settledAt: new Date(clock.now()).toISOString(),
  };
  let marked = false;
  for (let attempt = 0; attempt < MARK_WRITE_ATTEMPTS && !marked; attempt += 1) {
    try {
      await deps.store.set(wrappedKey, JSON.stringify(record));
      marked = true;
    } catch {
      // The payment has settled; a short store outage must not lose the mark it paid for.
    }
  }
  if (!marked) return retryLater("store_unavailable", 503);
  const receipt = { success: true, transaction: outcome.txHash, network: WRAP_NETWORK, payer: matched.payer };
  return {
    status: 200,
    headers: { [PAYMENT_RESPONSE_HEADER]: toBase64(JSON.stringify(receipt)) },
    body: { ok: true, wrapped: true, txHash: outcome.txHash },
  };
}
