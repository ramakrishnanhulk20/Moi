import { erc20Abi, formatUnits, getAddress, isAddress, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { z } from "zod";
import { parseAmount } from "../amounts.js";
import { SLIPPAGE_BPS } from "../buy.js";
import { assertChain, CHAIN_ID, readTokenInfo, USDT } from "../chain.js";
import { checkApproveTx, EXPECTED_ROUTER } from "../checks.js";
import { buildApproveVaultTx, buildCreateGiftTx, defaultExpiry, MAX_GIFT_USD, readGiftIdFromReceipt, type UnsignedTx } from "../create.js";
import { giftVaultAbi } from "../generated/giftVaultAbi.js";
import { buildLink, MAX_NOTE_PLAINTEXT_BYTES, newClaimKey, parseClaimKey, parseGiftId, sealNote, signKeyProof } from "../gift.js";
import type { QuoteErrorCode } from "../quote.js";
import { readGift, readListedTokens } from "../vault.js";
import { canonicalOrigin, PAYMENT_SIGNATURE_HEADER, WRAP_ASSETS, type WrapErrorCode } from "../wrap.js";
import { buildPayment, decodePaymentRequired, PaymentRequestError, permit2ApprovalTx, pickRequirement, WRAP_FEE_CEILING_USD, type WalletSigner } from "./x402.js";

/** What every browser flow needs to reach Moi's own API: the page's fetch and Moi's origin. */
export type MoiApi = { fetch: typeof fetch; origin: string };

/** One answer from Moi's API. `body` is parsed JSON, or null when it is not JSON or is over 64 KB. */
export type MoiReply = { status: number; body: unknown; paymentRequired: string | null; retryAfter: string | null };

const MAX_REPLY_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * One request to Moi's own API at `${origin}${path}`. `origin` goes through wrap.ts canonicalOrigin
 * (https, or http://localhost, nothing after the host), and `path` must be an /api/ path the caller
 * built from parsed values only. No redirect is followed (C13), no cookie is sent and nothing is
 * cached. `json` becomes the body with Content-Type application/json. Throws when the request
 * cannot complete (network failure, timeout) or the origin or path is refused.
 */
export async function callMoi(
  deps: MoiApi,
  method: "GET" | "POST",
  path: string,
  opts: { json?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<MoiReply> {
  const origin = canonicalOrigin(deps.origin);
  if (typeof path !== "string" || !/^\/api\/[a-z]+(\/[0-9]{1,78})?$/.test(path)) throw new TypeError("Not a Moi API path.");
  const res = await deps.fetch(`${origin}${path}`, {
    method,
    headers: { ...(opts.json === undefined ? {} : { "Content-Type": "application/json" }), ...(opts.headers ?? {}) },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length <= MAX_REPLY_CHARS) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, paymentRequired: res.headers.get("payment-required"), retryAfter: res.headers.get("retry-after") };
}

/** The fixed error code Moi put in a reply body, or null. Never any other text from the reply. */
export function errorCodeOf(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && /^[a-z_]{1,48}$/.test(error) ? error : null;
}

// The dispatcher's own answers (http.ts), which any route can give before its handler runs.
const ROUTE_TEXT: Record<string, string> = {
  not_found: "Moi's server does not know that address. Reload the page and try again.",
  method_not_allowed: "This page sent a request Moi's server does not take. Reload the page and try again.",
  body_too_large: "That request was too large for Moi's server.",
  bad_json: "Moi's server could not read the request. Reload the page and try again.",
  rate_limited: "Too many requests from your network just now. Wait a minute and try again.",
  store_unavailable: "Moi's server could not reach its records just now. Try again in a minute.",
  internal: "Moi's server hit an error. Try again in a minute.",
};

/**
 * The sentence a page shows for a Moi error code: from `table` first, then the dispatcher's own
 * codes, then a fixed fallback. Never echoes the code or any server text it does not know.
 */
export function moiErrorText(code: string | null, table: Readonly<Record<string, string>>): string {
  if (code !== null && Object.hasOwn(table, code)) return table[code]!;
  if (code !== null && Object.hasOwn(ROUTE_TEXT, code)) return ROUTE_TEXT[code]!;
  return "Moi's server refused the request. Try again in a minute.";
}

const QUOTE_TEXT = {
  bad_request: "Moi could not read that gift request. Check the stock and the amount.",
  bad_stock: "That stock is not one Moi can gift.",
  bad_wallet: "Moi could not read your wallet address. Reconnect your wallet and try again.",
  bad_amount: "The amount must be a plain number of US dollars, such as 5 or 12.50.",
  amount_too_small: "A gift must be at least 1 US dollar.",
  amount_too_large: `A gift can be at most ${MAX_GIFT_USD} US dollars.`,
  restricted_place: "Moi gifts are not available where you are connecting from.",
  unknown_place: "Moi could not tell where you are connecting from, so it cannot quote a gift.",
  not_listed: "That stock is not one Moi can gift.",
  quote_refused: "Binance's price for this stock did not pass Moi's checks just now. Try again in a minute.",
  simulation_refused: "The trade did not pass its safety simulation, so nothing was bought. Try again in a minute.",
  upstream_unavailable: "Binance's trading service is not answering. Try again in a minute.",
  chain_unavailable: "Moi could not read the blockchain just now. Try again in a minute.",
} as const satisfies Record<QuoteErrorCode, string>;

const NOT_TAKEN = "Nothing was taken.";
const NO_DOUBLE = "Try wrapping again in a few minutes; you will not pay twice.";

const WRAP_TEXT = {
  bad_gift_id: "That gift number is not valid.",
  gift_not_found: "Moi cannot see this gift in the vault yet. Wait a minute and try wrapping again.",
  gift_not_open: "This gift has already been claimed or taken back, so it does not need wrapping.",
  gift_expiring: "This gift expires in under 10 minutes, so Moi will not take a wrapping fee for it.",
  wrap_in_progress: `A wrapping payment for this gift is still being settled. ${NO_DOUBLE}`,
  payment_malformed: `Moi could not read the payment this page signed. ${NOT_TAKEN} Try wrapping again.`,
  payment_mismatch: `The signed payment did not match Moi's request. ${NOT_TAKEN} Try wrapping again.`,
  payment_reused: `That payment was already used for another gift. ${NOT_TAKEN} Try wrapping again.`,
  payment_invalid: `Binance's payment service did not accept the payment. ${NOT_TAKEN} Check your balance and try wrapping again.`,
  payment_failed: `The payment could not be sent on chain. ${NOT_TAKEN} Try wrapping again.`,
  settlement_pending: `Binance is still settling the wrapping fee. ${NO_DOUBLE}`,
  settlement_unexpected: "The fee's settlement could not be matched on chain, so the gift is not marked wrapped. Contact Moi before paying again.",
  facilitator_unavailable: `Binance's payment service is not answering. ${NOT_TAKEN} Try again in a few minutes.`,
  store_unavailable: `Moi's server could not finish recording the wrap. ${NO_DOUBLE}`,
  chain_unavailable: `Moi could not read the blockchain to finish the wrap. ${NO_DOUBLE}`,
  server_misconfigured: "Moi's server is not set up to take wrapping fees right now. Try again later.",
} as const satisfies Record<WrapErrorCode, string>;

export type SendGiftErrorCode =
  | "bad_input"
  | "not_listed"
  | "chain_unavailable"
  | "server_unreachable"
  | "quote_refused"
  | "declined"
  | "wallet_failed"
  | "tx_unconfirmed"
  | "tx_failed"
  | "tx_mismatch"
  | "swap_short"
  | "gift_mismatch"
  | "wrap_unpayable"
  | "wrap_refused"
  | "wrap_pending"
  | "gift_not_found"
  | "unexpected";

/**
 * Every way sending or wrapping a gift stops. `message` says why in plain English, `stillHeld`
 * says what the sender holds at that moment, and `giftId` is set once the gift exists. Neither
 * text ever holds the claim key or the link (C12): the link was already handed over in the
 * link-ready step.
 */
export class SendGiftError extends Error {
  readonly code: SendGiftErrorCode;
  readonly stillHeld: string;
  readonly giftId: bigint | null;
  constructor(code: SendGiftErrorCode, message: string, stillHeld: string, giftId: bigint | null) {
    super(message);
    this.name = "SendGiftError";
    this.code = code;
    this.stillHeld = stillHeld;
    this.giftId = giftId;
  }
}

/** A wrapping fee as the page shows it: the asset's symbol and the amount in whole units. */
export type WrapFee = { symbol: string; amount: string };

/** The steps of wrapGift, in order. "wrap" with stage "pay" comes right before the wallet is asked to sign the fee. */
export type WrapStep = { kind: "wrap"; stage: "pay" | "settling"; fee: WrapFee } | { kind: "approve-permit2"; tx: UnsignedTx };

/**
 * A gift's claim key between its making and its link, in a form a page can keep in local storage
 * as JSON: the sender's address, the claim key, the sealed note, the chain time (Unix seconds)
 * the createGift call was built at, and landsBefore: the last chain time that createGift can still
 * be mined (the vault refuses it once less than its 1 hour MIN_LIFETIME is left before expiry).
 * Holding it is holding the gift: it is never sent anywhere.
 */
export type PendingGift = { senderAddress: Address; claimKey: Hex; sealedNote: Hex; createdAt: number; landsBefore: number };

// The vault's own MIN_LIFETIME: createGift reverts when expiry < block.timestamp + 1 hour.
const VAULT_MIN_LIFETIME_S = 3_600;

/**
 * The steps of sendGift, in order. A step that carries `tx` is yielded right before the wallet is
 * asked to send exactly that transaction. key-pending and link-ready carry the claim key: the
 * caller must store each locally before asking for the next step, and must never log or send it.
 * Once link-ready is stored, the pending record may be deleted.
 */
export type SendStep =
  | { kind: "quote" }
  | { kind: "approve-usdt"; tx: UnsignedTx }
  | { kind: "swap"; tx: UnsignedTx }
  | { kind: "approve-vault"; tx: UnsignedTx }
  | { kind: "key-pending"; pending: PendingGift }
  | { kind: "create"; tx: UnsignedTx }
  | { kind: "link-ready"; giftId: bigint; link: string }
  | WrapStep
  | { kind: "done"; giftId: bigint; link: string; wrapTxHash: Hex };

export type WrapGiftDeps = MoiApi & {
  signer: WalletSigner;
  publicClient: PublicClient;
  /** Ram's payout wallet, pinned in the page's own config: the only payee a fee may go to (C24, C27). */
  payTo: Address;
  /** Milliseconds since the epoch. Times only the settlement wait; payment windows use block time. */
  now: () => number;
  /** Waits between settlement checks. setTimeout by default. */
  sleep?: (ms: number) => Promise<void>;
};

export type SendGiftDeps = WrapGiftDeps & { vault: Address };

export type SendGiftInput = { stock: Address; usdAmount: string; note: string; expiryDays?: number };

// The server quotes, builds and simulates upstream before it answers.
const QUOTE_TIMEOUT_MS = 45_000;
// One wrap request may wait 25 s on settlement and 25 s more on b402 (C49).
const WRAP_TIMEOUT_MS = 60_000;
const RECEIPT_TIMEOUT_MS = 180_000;
// While b402 settles, the server answers 202 and the identical request resumes it. The wait it
// asks for is held to 2 to 15 s, and the whole wait to 3 minutes, as the sender agent does.
const SETTLE_WAIT_MS = 180_000;
const MIN_RETRY_S = 2;
const MAX_RETRY_S = 15;
const DEFAULT_RETRY_S = 5;
const MAX_EXPIRY_DAYS = 90;
const DAY_SECONDS = 86_400n;
const BALANCE_READS = 3;
const TX_HASH_TEXT = /^0x[0-9a-fA-F]{64}$/;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Stop = (code: SendGiftErrorCode, message: string) => SendGiftError;
type FlowState = { held: string; giftId: bigint | null; claimKey: Hex | null };

function usableAddress(value: unknown): Address {
  const address = getAddress(value as string);
  if (address === zeroAddress) throw new TypeError("zero address");
  return address;
}

// Token symbols come from the token contract, so they are cut to plain short text before a sentence holds them.
function shown(symbol: string): string {
  return symbol.replace(/[^\x20-\x7e]/g, "").slice(0, 16);
}

function isUserRejection(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < 8 && typeof node === "object" && node !== null; depth += 1) {
    const { code, name } = node as { code?: unknown; name?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

// C12: whatever went wrong, an error that carries the claim key in any form is replaced, and
// anything that is not already a typed refusal becomes one with what the sender holds.
function typedError(err: unknown, state: FlowState): SendGiftError {
  const bare = state.claimKey?.slice(2).toLowerCase() ?? null;
  const unexpected = new SendGiftError("unexpected", "Something unexpected went wrong, so Moi stopped here.", state.held, state.giftId);
  if (!(err instanceof SendGiftError)) return unexpected;
  if (bare !== null && `${err.message}\n${err.stillHeld}\n${err.stack ?? ""}`.toLowerCase().includes(bare)) return unexpected;
  return err;
}

/**
 * Sends `tx` from the connected wallet and returns its receipt once mined and successful, and only
 * when the chain's own copy of the transaction carries exactly `tx.data`, from `wallet`, to
 * `tx.to`, with no value, on chain 56 (C48): a receipt alone proves nothing about the calldata a
 * wallet signed.
 */
async function sendChecked(deps: { signer: WalletSigner; publicClient: PublicClient }, tx: UnsignedTx, wallet: Address, stop: Stop): Promise<TransactionReceipt> {
  let sent: unknown;
  try {
    sent = await deps.signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n, chainId: CHAIN_ID });
  } catch (err) {
    throw isUserRejection(err)
      ? stop("declined", "You declined in your wallet, so Moi stopped here.")
      : stop("wallet_failed", "Your wallet could not send the transaction, so Moi stopped here.");
  }
  if (typeof sent !== "string" || !TX_HASH_TEXT.test(sent)) throw stop("wallet_failed", "Your wallet did not return a transaction hash, so Moi stopped here.");
  const hash = sent.toLowerCase() as Hex;
  let receipt: TransactionReceipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  } catch {
    throw stop("tx_unconfirmed", `Transaction ${hash} was sent but is not confirmed after 3 minutes. Look it up on bscscan.com before trying again.`);
  }
  if (receipt.status !== "success") throw stop("tx_failed", `Transaction ${hash} failed on chain, so Moi stopped here.`);
  let mined: Awaited<ReturnType<PublicClient["getTransaction"]>>;
  try {
    mined = await deps.publicClient.getTransaction({ hash });
  } catch {
    throw stop("chain_unavailable", `Moi could not read transaction ${hash} back from the chain, so it stopped here.`);
  }
  const same =
    typeof mined.input === "string" &&
    mined.input.toLowerCase() === tx.data.toLowerCase() &&
    isAddress(mined.from) &&
    getAddress(mined.from) === wallet &&
    typeof mined.to === "string" &&
    getAddress(mined.to) === getAddress(tx.to) &&
    mined.value === 0n &&
    (mined.chainId === undefined || mined.chainId === CHAIN_ID);
  if (!same) throw stop("tx_mismatch", `Transaction ${hash} is not the one Moi asked your wallet to send, so Moi stopped here. Check your wallet.`);
  return receipt;
}

const addressText = z.custom<Address>((v) => typeof v === "string" && isAddress(v));
const uintText = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
// A swap's calldata is a few KB; a far longer one is not a swap Moi built.
const calldataText = z.custom<Hex>((v) => typeof v === "string" && v.length <= 32_768 && /^0x([0-9a-fA-F]{2})+$/.test(v));
const handedTxSchema = z.strictObject({ to: addressText, data: calldataText, value: z.literal("0") });
const quoteReplySchema = z.discriminatedUnion("step", [
  z.strictObject({ ok: z.literal(true), step: z.literal("approve"), approveTx: handedTxSchema }),
  z.strictObject({
    ok: z.literal(true),
    step: z.literal("swap"),
    stock: addressText,
    usdAmount: z.string().max(40),
    swapTx: handedTxSchema,
    vaultApproveTx: handedTxSchema,
    expectedOut: uintText,
    minOut: uintText,
    priceUsd: z.string().max(80),
  }),
]);
type QuoteReply = z.infer<typeof quoteReplySchema>;

async function requestQuote(deps: SendGiftDeps, body: { stock: Address; usdAmount: string; wallet: Address }, stop: Stop): Promise<QuoteReply> {
  let reply: MoiReply;
  try {
    reply = await callMoi(deps, "POST", "/api/quote", { json: body, timeoutMs: QUOTE_TIMEOUT_MS });
  } catch {
    throw stop("server_unreachable", "Moi's server could not be reached for a price. Try again in a minute.");
  }
  if (reply.status !== 200) throw stop("quote_refused", moiErrorText(errorCodeOf(reply.body), QUOTE_TEXT));
  const parsed = quoteReplySchema.safeParse(reply.body);
  if (!parsed.success) throw stop("quote_refused", "Moi's price quote came back in a shape this page does not expect, so nothing was bought.");
  return parsed.data;
}

async function balanceAt(client: PublicClient, token: Address, owner: Address, blockNumber?: bigint): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], ...(blockNumber === undefined ? {} : { blockNumber }) });
}

/**
 * Sends a gift from the connected wallet, one step at a time, yielding each SendStep before the
 * wallet is asked for it:
 * 1. checks the input, that the stock is on the vault's on-chain list (C22) and that the wallet
 *    holds the USDT; then "quote" (POST /api/quote);
 * 2. when the server answers step "approve": "approve-usdt" with that approval, accepted only if
 *    it is exactly approve(router, this amount) on USDT (C21); once mined, quote again;
 * 3. "swap" with the swap, accepted only for this stock and amount, to the pinned router, with no
 *    value, and a minimum exactly 1 percent under the expected amount (C21). What arrived is the
 *    wallet's on-chain stock balance difference, and must reach that minimum;
 * 4. "approve-vault" for exactly what arrived (create.ts buildApproveVaultTx), to the vault from
 *    deps, never from a reply (C21);
 * 5. a claim key from Web Crypto (C11), its key proof for this wallet and the sealed note; then
 *    "key-pending" with the record the page must store before going on (recoverPendingGift reads
 *    it back), then "create" (buildCreateGiftTx, expiry from the latest block time). The gift id comes from the
 *    receipt, and the vault's own record must show it Open, from this wallet, holding exactly what
 *    arrived of this stock under this claim key (C48) before any link exists;
 * 6. "link-ready" with the link, before any wrapping, so a failed wrap never loses it;
 * 7. wrapGift's steps; then "done".
 * Every transaction is checked against the chain's own copy before the flow moves on (C48). The
 * claim key goes into no request, error or step except link-ready (C12). Throws SendGiftError, and
 * only SendGiftError, saying why and what the sender still holds.
 */
export async function* sendGift(deps: SendGiftDeps, input: SendGiftInput): AsyncGenerator<SendStep, void, void> {
  const state: FlowState = { held: "Nothing was spent.", giftId: null, claimKey: null };
  try {
    yield* send(deps, input, state);
  } catch (err) {
    throw typedError(err, state);
  }
}

async function* send(deps: SendGiftDeps, input: SendGiftInput, state: FlowState): AsyncGenerator<SendStep, void, void> {
  const stop: Stop = (code, message) => new SendGiftError(code, message, state.held, state.giftId);
  const client = deps.publicClient;
  let vault: Address;
  let wallet: Address;
  let stock: Address;
  try {
    canonicalOrigin(deps.origin);
    vault = usableAddress(deps.vault);
    usableAddress(deps.payTo);
    wallet = usableAddress(deps.signer?.address);
    stock = usableAddress(input?.stock);
  } catch {
    throw stop("bad_input", "This page is missing its Moi settings or a connected wallet, so nothing was sent.");
  }
  if (typeof input.note !== "string" || new TextEncoder().encode(input.note).length > MAX_NOTE_PLAINTEXT_BYTES) {
    throw stop("bad_input", `The note is too long. Keep it under ${MAX_NOTE_PLAINTEXT_BYTES} bytes.`);
  }
  const days = input.expiryDays;
  if (days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS)) {
    throw stop("bad_input", `A gift must last a whole number of days from 1 to ${MAX_EXPIRY_DAYS}.`);
  }

  let usdtDecimals: number;
  let symbol: string;
  let stockDecimals: number;
  let usdtAmount: bigint;
  try {
    await assertChain(client);
    const [listed, usdt, info] = await Promise.all([readListedTokens(client, vault), readTokenInfo(USDT, client), readTokenInfo(stock, client)]);
    if (!listed.includes(stock)) throw stop("not_listed", "That stock is not one Moi can gift.");
    usdtDecimals = usdt.decimals;
    symbol = shown(info.symbol);
    stockDecimals = info.decimals;
    try {
      usdtAmount = parseAmount(input.usdAmount, usdtDecimals);
    } catch {
      throw stop("bad_input", "The amount must be a plain number of US dollars, such as 5 or 12.50.");
    }
    if (usdtAmount > parseAmount(MAX_GIFT_USD, usdtDecimals)) throw stop("bad_input", `A gift can be at most ${MAX_GIFT_USD} US dollars.`);
    const usdtHeld = await balanceAt(client, getAddress(USDT), wallet);
    if (usdtHeld < usdtAmount) {
      throw stop("bad_input", `Your wallet holds ${formatUnits(usdtHeld, usdtDecimals)} USDT, less than the ${input.usdAmount} USDT for this gift.`);
    }
  } catch (err) {
    if (err instanceof SendGiftError) throw err;
    throw stop("chain_unavailable", "Moi could not read the blockchain just now. Try again in a minute.");
  }
  const usd = `${input.usdAmount} USDT`;
  const quoteBody = { stock, usdAmount: input.usdAmount, wallet };

  yield { kind: "quote" };
  let quote = await requestQuote(deps, quoteBody, stop);
  if (quote.step === "approve") {
    if (!checkApproveTx(quote.approveTx, { token: USDT, spender: EXPECTED_ROUTER, amount: usdtAmount }).ok) {
      throw stop("quote_refused", "Moi's USDT approval did not match this gift exactly, so nothing was signed.");
    }
    const approveTx: UnsignedTx = { to: getAddress(quote.approveTx.to), data: quote.approveTx.data, value: 0n };
    yield { kind: "approve-usdt", tx: approveTx };
    await sendChecked(deps, approveTx, wallet, stop);
    state.held = `Your ${usd} is still in your wallet. The trading router may spend exactly that amount of it.`;
    quote = await requestQuote(deps, quoteBody, stop);
    if (quote.step !== "swap") throw stop("quote_refused", "The USDT approval is mined but Moi's quote still asks for one, so nothing was bought.");
  }

  const expectedOut = BigInt(quote.expectedOut);
  const minOut = BigInt(quote.minOut);
  const fairSwap =
    getAddress(quote.stock) === stock &&
    quote.usdAmount === input.usdAmount &&
    getAddress(quote.swapTx.to) === EXPECTED_ROUTER &&
    expectedOut > 0n &&
    minOut > 0n &&
    minOut === (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (!fairSwap) throw stop("quote_refused", "Moi's trade did not match this gift's stock, amount and price protection, so nothing was bought.");
  const swapTx: UnsignedTx = { to: EXPECTED_ROUTER, data: quote.swapTx.data, value: 0n };

  let before: bigint;
  try {
    before = await balanceAt(client, stock, wallet);
  } catch {
    throw stop("chain_unavailable", "Moi could not read your stock balance before buying, so nothing was bought.");
  }
  yield { kind: "swap", tx: swapTx };
  const swapReceipt = await sendChecked(deps, swapTx, wallet, stop);
  state.held = `The ${symbol} you bought is in your wallet ${wallet}. No gift was made.`;
  let after: bigint | null = null;
  for (let attempt = 0; attempt < BALANCE_READS && after === null; attempt += 1) {
    try {
      // Read at the swap's own block, so a node a block behind cannot make the purchase look empty.
      after = await balanceAt(client, stock, wallet, swapReceipt.blockNumber);
    } catch {
      if (attempt + 1 < BALANCE_READS) await (deps.sleep ?? defaultSleep)(1_000);
    }
  }
  if (after === null) throw stop("chain_unavailable", "Moi could not read how much stock arrived, so it stopped before locking anything.");
  const received = after - before;
  const amountText = `${formatUnits(received > 0n ? received : 0n, stockDecimals)} ${symbol}`;
  if (received < minOut) {
    throw stop("swap_short", `The trade delivered ${amountText}, below its minimum of ${formatUnits(minOut, stockDecimals)} ${symbol}, so Moi stopped before locking anything.`);
  }
  state.held = `The ${amountText} you bought is in your wallet ${wallet}. No gift was made.`;

  const approveVaultTx = buildApproveVaultTx({ token: stock, amount: received, vault });
  yield { kind: "approve-vault", tx: approveVaultTx };
  await sendChecked(deps, approveVaultTx, wallet, stop);
  state.held = `The ${amountText} you bought is in your wallet ${wallet}. The Moi vault may take exactly that amount, and no gift was made.`;

  const key = newClaimKey();
  state.claimKey = key.privateKey;
  const keyProof = await signKeyProof(key.privateKey, vault, CHAIN_ID, wallet);
  const sealedNote = await sealNote(key.privateKey, input.note);
  let nowSeconds: bigint;
  try {
    nowSeconds = (await client.getBlock({ blockTag: "latest" })).timestamp;
  } catch {
    throw stop("chain_unavailable", "Moi could not read the time from the chain, so it stopped before locking anything.");
  }
  const expiry = days === undefined ? defaultExpiry(nowSeconds) : nowSeconds + BigInt(days) * DAY_SECONDS;
  const createTx = buildCreateGiftTx({ vault, token: stock, amount: received, claimKeyAddress: key.address, expiry, sealedNote, keyProof, nowSeconds });
  // WHY: once createGift is in flight the key is the only way to the gift, and a closed tab would
  // lose it. The page stores this record first; recoverPendingGift turns it back into the link.
  const pending: PendingGift = { senderAddress: wallet, claimKey: key.privateKey, sealedNote, createdAt: Number(nowSeconds), landsBefore: Number(expiry) - VAULT_MIN_LIFETIME_S };
  yield { kind: "key-pending", pending };
  state.held = `${state.held} Keep the saved gift key until this finishes: if the gift is made, it is the only way to reach it.`;
  yield { kind: "create", tx: createTx };
  const createReceipt = await sendChecked(deps, createTx, wallet, stop);
  const until = new Date(Number(expiry) * 1000).toISOString().slice(0, 10);
  state.held = `Your ${amountText} is locked in the Moi vault as a gift. As its sender you can take it back after it expires on ${until}.`;
  let giftId: bigint;
  try {
    giftId = readGiftIdFromReceipt(createReceipt, vault);
  } catch {
    throw stop("gift_mismatch", "The gift was made, but Moi could not read its number from the receipt, so it made no link.");
  }
  state.giftId = giftId;
  state.held = `Gift ${giftId} holds your ${amountText} in the Moi vault. As its sender you can take it back after it expires on ${until}.`;

  // WHY (C48): the link is only worth sending if the vault really holds this stock under this key,
  // so the vault's own record is read back before any link exists.
  let stored: Awaited<ReturnType<typeof readGift>>;
  try {
    stored = await readGift(client, vault, giftId);
  } catch {
    throw stop("chain_unavailable", `Gift ${giftId} was made, but Moi could not read it back from the vault, so it made no link.`);
  }
  const asAsked = stored.state === "Open" && stored.claimKey === key.address && stored.token === stock && stored.sender === wallet && stored.amount === received;
  if (!asAsked) throw stop("gift_mismatch", `Gift ${giftId} was made, but the vault's record of it is not the gift Moi asked for, so Moi made no link.`);

  const link = buildLink(canonicalOrigin(deps.origin), giftId, key.privateKey);
  yield { kind: "link-ready", giftId, link };
  state.held = `Gift ${giftId} holds your ${amountText}, and its link is ready. It is not wrapped yet, so it cannot be claimed until wrapping finishes.`;
  const wrapTxHash = yield* wrapSteps(deps, giftId, state);
  yield { kind: "done", giftId, link, wrapTxHash };
}

// The vault numbers gifts from 1 in order, so the newest 1,000 are a contiguous range, read in
// multicall batches of 100: ten calls at most instead of a thousand.
const RECOVERY_SCAN = 1_000n;
const RECOVERY_BATCH = 100n;
const KEEP_KEY = "Keep the saved gift key: it is the only way to reach this gift.";

/**
 * Turns a PendingGift a page kept from a send that stopped (a closed tab, a lost connection) back
 * into its gift. Reads claimKeyUsed for the key's address on the vault, from a node that reports
 * chain 56. When the key was never used, returns null: no gift was made with it yet. A signed
 * createGift can still be mined later, so the page deletes the record only when this returns null
 * and the latest block time is past pending.landsBefore. When it was used, scans the vault's
 * newest gifts (newest first, at most 1,000, by multicall) for the one stored under that claim key
 * from that sender and returns its id and link. Throws SendGiftError: bad_input for an unreadable record, chain_unavailable when the
 * vault cannot be read, and gift_not_found when the key is used but its gift is not among the
 * newest 1,000; in every error case the page must keep the record. The key goes into no request:
 * only its address is read (C12).
 */
export async function recoverPendingGift(
  deps: { publicClient: PublicClient; vault: Address; origin: string },
  pending: PendingGift,
): Promise<{ giftId: bigint; link: string } | null> {
  let key: Hex | null = null;
  try {
    let origin: string;
    let vault: Address;
    let sender: Address;
    let keyAddress: Address;
    try {
      origin = canonicalOrigin(deps.origin);
      vault = usableAddress(deps.vault);
      sender = usableAddress(pending?.senderAddress);
      key = parseClaimKey(pending?.claimKey);
      keyAddress = privateKeyToAccount(key).address;
    } catch {
      throw new SendGiftError("bad_input", "This saved gift key is not readable, so Moi cannot look for its gift.", KEEP_KEY, null);
    }
    const client = deps.publicClient;
    const unreadable = new SendGiftError("chain_unavailable", "Moi could not read the vault just now. Try again in a minute.", KEEP_KEY, null);
    let used: boolean;
    let next: bigint;
    try {
      await assertChain(client);
      [used, next] = await Promise.all([
        client.readContract({ address: vault, abi: giftVaultAbi, functionName: "claimKeyUsed", args: [keyAddress] }),
        client.readContract({ address: vault, abi: giftVaultAbi, functionName: "nextGiftId" }),
      ]);
    } catch {
      throw unreadable;
    }
    if (used !== true) return null;
    const newest = next - 1n;
    const oldest = newest - RECOVERY_SCAN + 1n > 1n ? newest - RECOVERY_SCAN + 1n : 1n;
    for (let high = newest; high >= oldest; high -= RECOVERY_BATCH) {
      const ids: bigint[] = [];
      for (let id = high; id >= oldest && id > high - RECOVERY_BATCH; id -= 1n) ids.push(id);
      let gifts: readonly { claimKey: string; sender: string }[];
      try {
        gifts = await client.multicall({
          contracts: ids.map((id) => ({ address: vault, abi: giftVaultAbi, functionName: "getGift", args: [id] }) as const),
          allowFailure: false,
          multicallAddress: bsc.contracts.multicall3.address,
        });
      } catch {
        throw unreadable;
      }
      const index = gifts.findIndex((g) => isAddress(g.claimKey) && getAddress(g.claimKey) === keyAddress && isAddress(g.sender) && getAddress(g.sender) === sender);
      if (index >= 0) {
        const giftId = ids[index]!;
        return { giftId, link: buildLink(origin, giftId, key) };
      }
    }
    throw new SendGiftError("gift_not_found", `This key made a gift, but it is not among the vault's newest ${RECOVERY_SCAN} gifts, so Moi made no link.`, KEEP_KEY, null);
  } catch (err) {
    throw typedError(err, { held: KEEP_KEY, giftId: null, claimKey: key });
  }
}

const wrappedSchema = z.object({ ok: z.literal(true), wrapped: z.literal(true), txHash: z.string().regex(TX_HASH_TEXT) });
const RESUMABLE: ReadonlySet<string> = new Set(["202:settlement_pending", "503:store_unavailable", "502:chain_unavailable"]);

function wrappedHash(reply: MoiReply): Hex | null {
  if (reply.status !== 200) return null;
  const parsed = wrappedSchema.safeParse(reply.body);
  return parsed.success ? (parsed.data.txHash.toLowerCase() as Hex) : null;
}

// wrap.ts keeps the gift held and the payment bound on these answers, so the identical header
// resumes where the server stopped. No other answer is replayed.
function resumable(reply: MoiReply): boolean {
  return RESUMABLE.has(`${reply.status}:${errorCodeOf(reply.body) ?? ""}`);
}

function retryAfterMs(reply: MoiReply | null): number {
  const fromBody = (reply?.body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  const fromHeader = reply?.retryAfter !== null && reply?.retryAfter !== undefined && /^\d{1,4}$/.test(reply.retryAfter) ? Number(reply.retryAfter) : undefined;
  const seconds = typeof fromBody === "number" && Number.isFinite(fromBody) ? fromBody : (fromHeader ?? DEFAULT_RETRY_S);
  return Math.min(MAX_RETRY_S, Math.max(MIN_RETRY_S, seconds)) * 1000;
}

/**
 * Wraps gift `giftId` by paying its fee through x402 and b402, yielding each WrapStep; sendGift
 * runs it after link-ready, and a page can run it alone to retry a wrap that stopped. Asks POST
 * /api/wrap/:id first: a gift already wrapped returns its settlement hash and pays nothing. On a
 * 402 it decodes PAYMENT-REQUIRED, keeps the requirements whose asset the wallet holds enough of,
 * and pickRequirement chooses among them against deps.payTo and the 0.10 USD ceiling (C24, C27).
 * "wrap" (stage "pay") comes before the wallet signs. A Permit2 payment short of allowance first
 * gets "approve-permit2" for exactly the fee (C21), checked on chain like every transaction (C48).
 * The signed header goes out in PAYMENT-SIGNATURE. While the server answers 202
 * settlement_pending, 503 store_unavailable or 502 chain_unavailable, "wrap" (stage "settling")
 * is yielded once and the identical header is replayed after the wait it asks for (2 to 15 s), for
 * 3 minutes at most; a payment is never signed twice in one run. Returns the settlement hash from
 * the server's 200. Needs only the gift id, never the claim key. Throws SendGiftError.
 */
export async function* wrapGift(deps: WrapGiftDeps, giftId: bigint): AsyncGenerator<WrapStep, Hex, void> {
  let id: bigint | null = null;
  try {
    id = parseGiftId(typeof giftId === "bigint" ? giftId.toString() : "");
  } catch {
    // Reported below with the gift unknown.
  }
  const state: FlowState = {
    held: id === null ? "Nothing was paid." : `Gift ${id} is in the vault and its link still works. It is not wrapped yet, so it cannot be claimed until wrapping finishes.`,
    giftId: id,
    claimKey: null,
  };
  try {
    if (id === null) throw new SendGiftError("bad_input", "That gift number is not valid.", state.held, null);
    return yield* wrapSteps(deps, id, state);
  } catch (err) {
    throw typedError(err, state);
  }
}

async function* wrapSteps(deps: WrapGiftDeps, giftId: bigint, state: FlowState): AsyncGenerator<WrapStep, Hex, void> {
  const stop: Stop = (code, message) => new SendGiftError(code, message, state.held, state.giftId);
  let wallet: Address;
  let payTo: Address;
  try {
    canonicalOrigin(deps.origin);
    wallet = usableAddress(deps.signer?.address);
    payTo = usableAddress(deps.payTo);
  } catch {
    throw stop("bad_input", "This page is missing its Moi settings or a connected wallet, so nothing was paid.");
  }
  const sleep = deps.sleep ?? defaultSleep;
  const path = `/api/wrap/${giftId}`;
  const post = async (header: string | null): Promise<MoiReply | null> => {
    try {
      return await callMoi(deps, "POST", path, { headers: header === null ? {} : { [PAYMENT_SIGNATURE_HEADER]: header }, timeoutMs: WRAP_TIMEOUT_MS });
    } catch {
      return null;
    }
  };

  const first = (await post(null)) ?? (await post(null));
  if (first === null) throw stop("server_unreachable", "Moi's server could not be reached to wrap the gift. Nothing was paid. Try again in a minute.");
  const already = wrappedHash(first);
  if (already !== null) return already;
  if (first.status !== 402) throw stop(first.status === 409 && errorCodeOf(first.body) === "wrap_in_progress" ? "wrap_pending" : "wrap_refused", moiErrorText(errorCodeOf(first.body), WRAP_TEXT));

  let required: ReturnType<typeof decodePaymentRequired>;
  try {
    required = decodePaymentRequired(first.paymentRequired ?? "");
  } catch {
    throw stop("wrap_refused", "Moi's payment request could not be read, so nothing was paid.");
  }
  // The resource URL is only echoed back to the server, but it is still read like input: it must
  // name this gift's wrap route.
  const resourceUrl = required.resource?.url ?? `${canonicalOrigin(deps.origin)}${path}`;
  let resourcePath: string | null = null;
  try {
    resourcePath = new URL(resourceUrl).pathname;
  } catch {
    resourcePath = null;
  }
  if (resourcePath !== path) throw stop("wrap_refused", "Moi's payment request is for something other than this gift, so nothing was paid.");

  const opts = { payTo, maxUsd: WRAP_FEE_CEILING_USD, assets: WRAP_ASSETS, prefer: "eip3009-first" } as const;
  if (pickRequirement(required.accepts, opts) === null) {
    throw stop("wrap_refused", "Moi's payment request does not match the fee and payout wallet this page expects, so nothing was paid.");
  }
  let balances: bigint[];
  try {
    balances = await Promise.all(WRAP_ASSETS.map((a) => balanceAt(deps.publicClient, a.address, wallet)));
  } catch {
    throw stop("chain_unavailable", "Moi could not read your balances to pay the wrapping fee. Nothing was paid. Try again in a minute.");
  }
  // Only what the wallet can cover reaches pickRequirement, so a sender holding USDT alone is never
  // asked to sign a U payment that b402 would refuse.
  const affordable = required.accepts.filter((r) => {
    const index = WRAP_ASSETS.findIndex((a) => a.address === getAddress(r.asset));
    return index >= 0 && (balances[index] ?? 0n) >= BigInt(r.amount);
  });
  const choice = pickRequirement(affordable, opts);
  if (choice === null) {
    throw stop("wrap_unpayable", "The wrapping fee is paid in U, USD1, USDT or USDC on BNB Smart Chain, and this wallet holds too little of each. Add some and try wrapping again; nothing was paid.");
  }
  const asset = WRAP_ASSETS.find((a) => a.address === getAddress(choice.asset))!;
  const fee: WrapFee = { symbol: asset.symbol, amount: formatUnits(BigInt(choice.amount), asset.decimals) };

  const sign = async () => {
    try {
      return await buildPayment({ signer: deps.signer, publicClient: deps.publicClient }, choice, resourceUrl);
    } catch (err) {
      if (err instanceof PaymentRequestError) throw stop("wrap_refused", err.message);
      throw isUserRejection(err)
        ? stop("declined", "You declined the wrapping fee in your wallet, so nothing was paid.")
        : stop("wrap_refused", "The wrapping fee could not be signed, so nothing was paid.");
    }
  };
  yield { kind: "wrap", stage: "pay", fee };
  let built = await sign();
  if (built.needsPermit2Approval !== null) {
    const approval = permit2ApprovalTx(built.needsPermit2Approval);
    yield { kind: "approve-permit2", tx: approval };
    await sendChecked(deps, approval, wallet, stop);
    yield { kind: "wrap", stage: "pay", fee };
    built = await sign();
    if (built.needsPermit2Approval !== null) throw stop("wrap_refused", "The approval is mined but Permit2 still cannot move the fee, so nothing was paid.");
  }

  // The signed header lives only here, and this run never signs another.
  const header = built.headerValue;
  const deadline = deps.now() + SETTLE_WAIT_MS;
  let reply = await post(header);
  let announced = false;
  while (reply === null || resumable(reply)) {
    if (!announced) {
      yield { kind: "wrap", stage: "settling", fee };
      announced = true;
    }
    const wait = retryAfterMs(reply);
    if (deps.now() + wait > deadline) {
      throw stop("wrap_pending", `Binance is still settling the ${fee.amount} ${fee.symbol} wrapping fee after 3 minutes. ${NO_DOUBLE}`);
    }
    await sleep(wait);
    reply = await post(header);
  }
  const hash = wrappedHash(reply);
  if (hash !== null) return hash;
  throw stop("wrap_refused", moiErrorText(errorCodeOf(reply.body), WRAP_TEXT));
}
