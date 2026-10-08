import { parseAmount } from "@moi/core/src/amounts.js";
import { balanceOf, rawToShares, readTokenInfo } from "@moi/core/src/chain.js";
import {
  buildApproveVaultTx,
  buildCreateGiftTx,
  defaultExpiry,
  MAX_GIFT_USD,
  readGiftIdFromReceipt,
  type UnsignedTx,
} from "@moi/core/src/create.js";
import { buildLink, MAX_NOTE_PLAINTEXT_BYTES, newClaimKey, sealNote, signKeyProof } from "@moi/core/src/gift.js";
import { readGift, readListedTokens } from "@moi/core/src/vault.js";
import { formatUnits, getAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { z } from "zod";
import type { BawRunner } from "./baw.js";
import { sameAddress, shown, sleep } from "./checks.js";
import { GiftCancelled, GiftError, GiftNotWrapped } from "./errors.js";
import { rewritePrivate, saveNewLink, unwrappedMarker } from "./linkfile.js";
import { removePendingKey, savePendingKey } from "./pending.js";
import type { Pinned } from "./pinned.js";
import { preflight } from "./preflight.js";
import { wrapGift } from "./wrap.js";

export { GiftCancelled, GiftError, GiftNotWrapped, WrapStillSettling } from "./errors.js";

export type GiftDeps = {
  baw: BawRunner;
  client: PublicClient;
  pinned: Pinned;
  fetchImpl: typeof fetch;
  linkDir: string;
  confirm: (summary: string) => Promise<boolean>;
  log: (line: string) => void;
};

/**
 * `usd` buys that many US dollars of the stock first. `useHeld` instead gifts that many tokens of
 * the stock already in the wallet (a decimal in the token's own units). Exactly one is given.
 */
export type GiftInput = { ticker: string; usd?: string; useHeld?: string; note: string; days?: number };

export type GiftResult = { giftId: bigint; linkFile: string; txs: Hex[] };

const CHAIN = "56";
const MIN_GIFT_USD = "1";
// WHY a lower floor for held stock: the 1 dollar minimum exists because Binance will not sell less;
// stock already held has no such limit, and a 1 dollar buy arrives worth slightly less after fees.
const MIN_HELD_GIFT_USD = "0.5";
const MAX_DAYS = 90;
// The vault's list is owner-curated and short; a far longer one means something is wrong, and
// reading each symbol is one RPC call.
const MAX_LISTED_TOKENS = 100;
const POLL_MS = 3_000;
const SWAP_DEADLINE_MS = 180_000;
// A node behind by a block can still show the old balance right after Binance says FINISHED.
const BALANCE_READS = 5;
// The order list's bookTime is Binance's clock and the swap start is this machine's; a minute of
// slack keeps a skewed clock from hiding the order. An older identical order would also need the
// same pay amount and pair to be mistaken for this one, and even then only the log is affected.
const CLOCK_SKEW_MS = 60_000;
const RECENT_ORDERS = "20";
const SERVER_TIMEOUT_MS = 15_000;
const MAX_STOCKS_BODY = 256 * 1024;
const PRICE_TEXT = /^\d{1,40}(\.\d{1,40})?$/;
const RECEIPT_TIMEOUT_MS = 120_000;
const SIMULATION_OK = "000000000";

const TICKER_TEXT = /^[A-Za-z][A-Za-z0-9.]{0,11}$/;
const ID_TEXT = /^[A-Za-z0-9_-]{1,128}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_TEXT = /^\d{1,40}(\.\d{1,40})?$/;

const lower = (a: Address) => a.toLowerCase();

// baw 1.10.0 prints no minimum for market quotes; minReceive is read if a later version adds one.
const quoteSchema = z.object({ toCoinAmount: z.string().regex(DECIMAL_TEXT), minReceive: z.string().regex(DECIMAL_TEXT).optional() }).loose();
// When the quote gives no minimum, the floor is the quoted amount less 1 percent.
const QUOTE_FLOOR_PERCENT = 99n;

/** A decimal string in `decimals` base units, digits past `decimals` dropped (rounds down). */
function decimalUnits(text: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0");
}
const swapSchema = z.object({ orderId: z.union([z.string(), z.number().int().nonnegative()]) }).loose();
// Fields as the 1.10.0 bundle prints a market order; bookTime is when Binance booked it.
const orderSchema = z
  .object({
    orderId: z.union([z.string(), z.number()]),
    status: z.string().max(32),
    txHash: z.string().nullable().optional(),
    fromToken: z.string().max(64).optional(),
    toToken: z.string().max(64).optional(),
    fromTokenQty: z.string().max(90).optional(),
    bookTime: z.string().max(64).nullable().optional(),
  })
  .loose();
type Order = z.infer<typeof orderSchema>;
const orderListSchema = z.object({ list: z.array(orderSchema).max(100) }).loose();
const stocksSchema = z
  .object({ stocks: z.array(z.object({ address: z.string().max(64), priceUsd: z.string().max(64).nullable() }).loose()).max(100) })
  .loose();
const riskSchema = z.object({ title: z.string().max(500), description: z.string().max(2_000).optional() }).loose();
const previewSchema = z
  .object({
    requestId: z.string().regex(ID_TEXT),
    simulationResult: z.object({ simulationCode: z.string().max(32).nullable().optional() }).loose().nullable().optional(),
    risks: z.object({ riskDetails: z.array(riskSchema).max(50).optional() }).loose().nullable().optional(),
    requireConfirmation: z.boolean().optional(),
  })
  .loose();
const executeSchema = z.object({ status: z.string().max(32), txHash: z.string().regex(TX_HASH).nullable() }).loose();

type Stock = { address: Address; symbol: string; decimals: number; uiMultiplier: bigint | null };

/**
 * C22: the stock comes only from the vault's on-chain list, matched on each token's own symbol()
 * read from chain. "NVDA" matches the symbol NVDA or NVDAB. No match, or more than one, refuses.
 */
async function resolveStock(client: PublicClient, vault: Address, ticker: string): Promise<Stock> {
  const wanted = ticker.toUpperCase();
  const listed = await readListedTokens(client, vault);
  if (listed.length > MAX_LISTED_TOKENS) throw new GiftError("The vault lists more tokens than Moi will read, so Moi stopped.");
  const tokens = await Promise.all(listed.map(async (address) => ({ address, ...(await readTokenInfo(address, client)) })));
  const matches = tokens.filter((t) => {
    const symbol = t.symbol.toUpperCase();
    return symbol === wanted || symbol === `${wanted}B`;
  });
  if (matches.length === 0) throw new GiftError(`${wanted} is not a stock Moi can gift. Only stocks listed in the Moi vault can be gifted.`);
  if (matches.length > 1) throw new GiftError(`${wanted} matches more than one stock in the Moi vault, so Moi will not guess. Use the full symbol.`);
  const [stock] = matches as [(typeof matches)[number]];
  return { address: stock.address, symbol: shown(stock.symbol, 16), decimals: stock.decimals, uiMultiplier: stock.uiMultiplier };
}

/** The transaction was mined and reverted, so it changed nothing. */
class TxFailed extends GiftError {}

/** Binance's contract-call answered PENDING_CONFIRMATION: the Binance App holds the transaction. */
class HeldInApp extends GiftError {}

type CallTexts = {
  question: string;
  /** Said when the sender answers no, or anything fails, before the transaction is sent. */
  stopped: string;
  /** Said when the Binance App holds the transaction for the sender's approval. */
  waiting: () => string;
  /** Runs after the sender says yes and before the transaction can exist. */
  beforeExecute?: () => Promise<void>;
};

/**
 * Previews `tx` through Binance's contract-call, shows the result, asks, executes and waits for a
 * successful receipt from the sender's wallet to `tx.to` whose mined calldata is exactly `tx.data`
 * (C48). The calldata is always built in this process by create.ts; nothing from a server reaches
 * here (C27). Throws HeldInApp with `texts.waiting()` when the Binance App holds the transaction,
 * and sends nothing after that.
 */
async function contractCall(
  deps: GiftDeps,
  wallet: Address,
  tx: UnsignedTx,
  texts: CallTexts,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const { question, stopped } = texts;
  const reply = previewSchema.safeParse(
    await deps.baw(["contract-call", "preview", "--binanceChainId", CHAIN, "--from", lower(wallet), "--to", lower(tx.to), "--inputData", tx.data.toLowerCase()]),
  );
  if (!reply.success) throw new GiftError(`Binance's preview came back in a shape Moi does not recognise, so nothing was signed. ${stopped}`);
  const preview = reply.data;
  const code = preview.simulationResult?.simulationCode;
  if (code !== undefined && code !== null && code !== "" && code !== SIMULATION_OK) {
    throw new GiftError(`Binance's simulation says this transaction would fail (code ${shown(code, 16)}), so nothing was signed. ${stopped}`);
  }
  deps.log(`Binance previewed it: the simulation passed${preview.requireConfirmation === true ? ", and the Binance App will ask you to approve it" : ""}.`);
  for (const risk of preview.risks?.riskDetails ?? []) {
    deps.log(`Binance flags a risk: ${shown(risk.title)}${risk.description === undefined ? "" : `: ${shown(risk.description, 300)}`}`);
  }
  if (!(await deps.confirm(question))) throw new GiftCancelled(stopped);
  await texts.beforeExecute?.();

  const executed = executeSchema.safeParse(await deps.baw(["contract-call", "execute", "--requestId", preview.requestId]));
  if (!executed.success) throw new GiftError(`Binance's reply to sending the transaction was unreadable. Check your wallet in the Binance App. ${stopped}`);
  if (executed.data.status === "PENDING_CONFIRMATION") throw new HeldInApp(texts.waiting());
  if (executed.data.status !== "BROADCASTED" || executed.data.txHash === null) {
    throw new GiftError(`Binance reported the transaction as ${shown(executed.data.status, 32)}, not sent, so Moi stopped here. ${stopped}`);
  }
  const hash = executed.data.txHash.toLowerCase() as Hex;
  const receipt = await deps.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new TxFailed(`Transaction ${hash} failed on chain. ${stopped}`);
  // WHY (C48): the wallet is Binance's, not this process's, so the only proof that it signed what
  // was previewed is the chain's own copy of the transaction: same sender, same target, and the
  // very bytes create.ts built. A receipt alone says nothing about the calldata.
  const mined = await deps.client.getTransaction({ hash });
  const sameCall = typeof mined.input === "string" && mined.input.toLowerCase() === tx.data.toLowerCase();
  if (!sameCall || !sameAddress(receipt.from, wallet) || receipt.to === null || !sameAddress(receipt.to, getAddress(tx.to))) {
    throw new GiftError(`Transaction ${hash} is not the one Moi asked Binance to send, so Moi stopped. ${stopped}`);
  }
  return { hash, receipt };
}

// C12: whatever went wrong, an error that carries the claim key in any form is replaced.
function withoutKey(err: unknown, claimKey: Hex): unknown {
  const bare = claimKey.slice(2).toLowerCase();
  let node: unknown = err;
  for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
    const text = node instanceof Error ? `${node.message}\n${node.stack ?? ""}` : String(node);
    if (text.toLowerCase().includes(bare)) {
      return new GiftError("Something failed after the gift key was made. The key was not shown anywhere.");
    }
    node = node instanceof Error ? node.cause : undefined;
  }
  return err;
}

type SwapWatch = {
  wallet: Address;
  stock: Stock;
  usdt: Address;
  pay: bigint;
  usdtDecimals: number;
  before: bigint;
  floor: bigint;
  orderId: string;
  startedMs: number;
};

const sameAmount = (text: string | undefined, decimals: number, amount: bigint) =>
  typeof text === "string" && DECIMAL_TEXT.test(text) && decimalUnits(text, decimals) === amount;

/**
 * The order for this swap: by the id the swap returned, and when the list does not know that id
 * (it has differed from the listed one for other builders and in Moi's first live run), the one
 * recent order for the same pair and pay amount booked after the swap started. Two candidates is
 * no answer. Never throws: a failed read is no answer either.
 */
async function lookupOrder(baw: BawRunner, watch: SwapWatch): Promise<Order | undefined> {
  try {
    const byId = orderListSchema.safeParse(await baw(["market-order", "list", "--orderId", watch.orderId]));
    const own = byId.success ? byId.data.list.find((o) => String(o.orderId) === watch.orderId) : undefined;
    if (own !== undefined) return own;
  } catch {
    // Fall through to the recent orders.
  }
  const since = watch.startedMs - CLOCK_SKEW_MS;
  try {
    const recent = orderListSchema.safeParse(
      await baw(["market-order", "list", "--binanceChainId", CHAIN, "--startTime", String(since), "--pageSize", RECENT_ORDERS]),
    );
    if (!recent.success) return undefined;
    const matches = recent.data.list.filter((o) => {
      const booked = typeof o.bookTime === "string" ? Date.parse(o.bookTime) : Number.NaN;
      return (
        sameAddress(o.fromToken, watch.usdt) &&
        sameAddress(o.toToken, watch.stock.address) &&
        sameAmount(o.fromTokenQty, watch.usdtDecimals, watch.pay) &&
        Number.isFinite(booked) &&
        booked >= since
      );
    });
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Waits for the swap and returns what arrived, decided by the chain, not by the order list
 * (Moi's first live run: the list never showed the returned id as FINISHED while the stock had
 * landed). Each round reads the order (lookupOrder) and the wallet's on-chain stock balance.
 * Done when the balance has grown by at least `floor` in shares. Refuses at once when the order is
 * FAILED and nothing arrived. When the order is FINISHED, a grown balance is final and a flat one
 * gets a few more reads in case the node is a block behind. After 3 minutes without either, stops.
 */
async function waitForSwap(deps: GiftDeps, watch: SwapWatch): Promise<{ received: bigint; swapTx: Hex | null }> {
  const { stock } = watch;
  const deadline = Date.now() + SWAP_DEADLINE_MS;
  let swapTx: Hex | null = null;
  let listedId: string | null = null;
  let flatAfterFinished = 0;
  let finished = false;
  let received = 0n;
  for (;;) {
    const order = await lookupOrder(deps.baw, watch);
    if (order !== undefined) {
      const id = String(order.orderId);
      if (listedId === null && ID_TEXT.test(id)) {
        listedId = id;
        deps.log(
          id === watch.orderId
            ? `Binance's order list shows the purchase as order ${id}.`
            : `Binance's order list shows the purchase as order ${id}, not order ${watch.orderId} as the purchase reply said.`,
        );
      }
      if (typeof order.txHash === "string" && TX_HASH.test(order.txHash)) swapTx = order.txHash.toLowerCase() as Hex;
    }
    try {
      received = (await balanceOf(stock.address, watch.wallet, deps.client)) - watch.before;
    } catch {
      // An RPC hiccup is not an answer; the previous reading stands until the next round.
    }
    if (received > 0n && rawToShares(received, stock.uiMultiplier) >= watch.floor) return { received, swapTx };
    if (order?.status === "FAILED" && received <= 0n) throw new GiftError("Binance reports the purchase failed, and no stock arrived. Nothing was locked.");
    if (order?.status === "FINISHED") {
      finished = true;
      if (received > 0n) break;
      flatAfterFinished += 1;
      if (flatAfterFinished >= BALANCE_READS) break;
    }
    if (Date.now() + POLL_MS > deadline) break;
    await sleep(POLL_MS);
  }
  if (received <= 0n && finished) {
    throw new GiftError(`Binance says the purchase finished, but no ${stock.symbol} arrived in your wallet on chain. Moi stopped before locking anything.`);
  }
  if (received <= 0n) {
    throw new GiftError("The purchase was still processing after 3 minutes, so Moi stopped before locking anything. Check your wallet in the Binance App.");
  }
  return { received, swapTx };
}

/**
 * The stock's US dollar price per whole token, as the Moi server's /api/stocks reports it (the
 * keyed RWA price the server holds; the agent holds no API key). It only bounds a --use-held gift
 * between the gift limits; it never picks an amount, a token or a payee. Fails closed.
 */
async function readPriceUsd(deps: GiftDeps, stock: Stock): Promise<bigint> {
  const unreadable = new GiftError("Moi could not read the stock's price from its server, so it cannot check the gift's dollar value. Nothing was sent.");
  let body: unknown;
  try {
    const res = await deps.fetchImpl(`${deps.pinned.serverOrigin}/api/stocks`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    const text = await res.text();
    if (res.status !== 200 || text.length > MAX_STOCKS_BODY) throw unreadable;
    body = JSON.parse(text);
  } catch {
    throw unreadable;
  }
  const parsed = stocksSchema.safeParse(body);
  const rows = parsed.success ? parsed.data.stocks.filter((s) => sameAddress(s.address, stock.address)) : [];
  const price = rows.length === 1 ? rows[0]?.priceUsd : null;
  if (typeof price !== "string" || !PRICE_TEXT.test(price) || !/[1-9]/.test(price)) throw unreadable;
  return decimalUnits(price, 18);
}

type Bought = { stock: Stock; wallet: Address; received: bigint; swapTx: Hex | null };

/**
 * Buys `input.usd` dollars of a listed stock with the sender's Binance Agentic Wallet, or takes
 * `input.useHeld` tokens of it the wallet already holds, then locks it in the Moi vault as a gift,
 * saves the gift link and pays the wrapping fee through b402.
 *
 * Order: the ticker is resolved against the vault's on-chain list (C22) and the amount parsed
 * before any baw call, then the wallet preflight must be ready. Buying: quote, confirm, swap, and
 * the received amount is the on-chain balance difference once it reaches the quote's floor
 * (waitForSwap). Holding: the amount must be above zero and at most the on-chain balance, and its
 * value at the server's RWA price between the gift limits; no quote or swap call is made. Then, for
 * both: claim key from the platform random source (C11), approve the vault for exactly that
 * amount, createGift, save the link, wrap. Every target, amount, token and payee is built here or
 * checked against `deps.pinned` (C27): calldata comes from create.ts, never from a server; the fee
 * must match pinned.payTo, chain 56, WRAP_ASSETS and the fee ceiling (C24).
 *
 * The link is saved to `${linkDir}/gift-<id>.txt` (mode 0600 where the OS supports it) as soon as
 * the gift id is known, under a first line "# not wrapped yet: run `npm run moi -- wrap <id>`",
 * which is removed once wrapping succeeds, so a failed or declined wrap never loses the key.
 * The claim key and the link never reach `log`, stdout or a thrown message (C12).
 * Throws GiftError with a plain-English reason; GiftCancelled when `confirm` answers no before
 * the gift exists; GiftNotWrapped when the gift exists and its link is saved but it is not wrapped.
 */
export async function sendGift(deps: GiftDeps, input: GiftInput): Promise<GiftResult> {
  if (typeof input.ticker !== "string" || !TICKER_TEXT.test(input.ticker)) {
    throw new GiftError("That is not a stock ticker. Use letters such as NVDA.");
  }
  if (typeof input.note !== "string" || new TextEncoder().encode(input.note).length > MAX_NOTE_PLAINTEXT_BYTES) {
    throw new GiftError(`The note is too long. Keep it under ${MAX_NOTE_PLAINTEXT_BYTES} bytes.`);
  }
  if (input.days !== undefined && (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > MAX_DAYS)) {
    throw new GiftError(`The gift must last a whole number of days from 1 to ${MAX_DAYS}.`);
  }
  if ((input.usd === undefined) === (input.useHeld === undefined)) {
    throw new GiftError("Give either a dollar amount to buy, or --use-held with an amount of stock you already hold, not both.");
  }

  const stock = await resolveStock(deps.client, deps.pinned.vault, input.ticker);
  const bought = input.useHeld === undefined ? await buy(deps, stock, input.usd ?? "") : await useHeld(deps, stock, input.useHeld);
  return lockAndWrap(deps, bought, input);
}

async function buy(deps: GiftDeps, stock: Stock, usd: string): Promise<Bought> {
  const { baw, client, pinned, log } = deps;
  const usdtDecimals = (await readTokenInfo(pinned.usdt, client)).decimals;
  let amount: bigint;
  try {
    amount = parseAmount(usd, usdtDecimals);
  } catch {
    throw new GiftError("The amount must be a plain number of US dollars, such as 5 or 12.50.");
  }
  if (amount < parseAmount(MIN_GIFT_USD, usdtDecimals) || amount > parseAmount(MAX_GIFT_USD, usdtDecimals)) {
    throw new GiftError(`A gift must be from ${MIN_GIFT_USD} to ${MAX_GIFT_USD} US dollars.`);
  }
  const qty = formatUnits(amount, usdtDecimals);

  log("Checking your Binance agent wallet.");
  const check = await preflight(baw, { giftUsd: qty });
  if (!check.ready || check.address === null) {
    throw new GiftError(["Your Binance agent wallet is not ready:", ...check.problems.map((p) => `- ${p}`)].join("\n"));
  }
  const wallet = check.address;

  const tradeFlags = ["--fromTokenQty", qty, "--fromToken", lower(pinned.usdt), "--toToken", lower(stock.address), "--binanceChainId", CHAIN];
  const quote = quoteSchema.safeParse(await baw(["market-order", "quote", ...tradeFlags]));
  if (!quote.success || !/[1-9]/.test(quote.data.toCoinAmount)) {
    throw new GiftError("Binance's quote came back in a shape Moi does not recognise, so nothing was bought.");
  }
  log(`Binance quotes about ${quote.data.toCoinAmount} ${stock.symbol} (${stock.address}) for ${qty} USDT (${pinned.usdt}).`);
  if (!(await deps.confirm(`Buy about ${quote.data.toCoinAmount} ${stock.symbol} for ${qty} USDT with your Binance agent wallet ${wallet}?`))) {
    throw new GiftCancelled("Stopped before buying. Nothing was spent.");
  }
  // baw prints a bStock quote in shares (token amount times the token's multiplier, read from the
  // 1.10.0 bundle), so the on-chain amount is turned into shares with the token's own on-chain
  // multiplier before the two are compared.
  const quoted = decimalUnits(quote.data.toCoinAmount, stock.decimals);
  const floor = quote.data.minReceive === undefined ? (quoted * QUOTE_FLOOR_PERCENT) / 100n : decimalUnits(quote.data.minReceive, stock.decimals);

  const before = await balanceOf(stock.address, wallet, client);
  const startedMs = Date.now();
  const swap = swapSchema.safeParse(await baw(["market-order", "swap", ...tradeFlags]));
  const orderId = swap.success ? String(swap.data.orderId) : "";
  if (!ID_TEXT.test(orderId)) {
    throw new GiftError("Binance accepted the purchase but its reply had no readable order number. Check your wallet in the Binance App; Moi locked nothing.");
  }
  log(`Binance took the purchase as order ${orderId}. Waiting for the stock to arrive in your wallet.`);
  const { received, swapTx } = await waitForSwap(deps, { wallet, stock, usdt: pinned.usdt, pay: amount, usdtDecimals, before, floor, orderId, startedMs });

  const receivedShares = rawToShares(received, stock.uiMultiplier);
  if (receivedShares < floor) {
    throw new GiftError(
      `Binance delivered less than it quoted: ${formatUnits(receivedShares, stock.decimals)} ${stock.symbol} in shares arrived, ` +
        `below the minimum of ${formatUnits(floor, stock.decimals)} from its quote of ${quote.data.toCoinAmount}. ` +
        `The ${formatUnits(received, stock.decimals)} ${stock.symbol} is in your wallet ${wallet}. Moi stopped before approving the vault, so nothing was locked.`,
    );
  }
  log(`Bought ${formatUnits(received, stock.decimals)} ${stock.symbol}.`);
  return { stock, wallet, received, swapTx };
}

async function useHeld(deps: GiftDeps, stock: Stock, heldText: string): Promise<Bought> {
  let held: bigint;
  try {
    held = parseAmount(heldText, stock.decimals);
  } catch {
    throw new GiftError(`--use-held must be a plain number of ${stock.symbol} tokens above zero, such as 0.0042.`);
  }
  // The value bound uses 18-decimal US dollar units throughout, so no float touches an amount.
  const valueUsd = (held * (await readPriceUsd(deps, stock))) / 10n ** BigInt(stock.decimals);
  if (valueUsd < parseAmount(MIN_HELD_GIFT_USD, 18) || valueUsd > parseAmount(MAX_GIFT_USD, 18)) {
    throw new GiftError(`${heldText} ${stock.symbol} is worth about ${formatUnits(valueUsd, 18).slice(0, 8)} US dollars; a gift must be from ${MIN_HELD_GIFT_USD} to ${MAX_GIFT_USD}.`);
  }

  deps.log("Checking your Binance agent wallet.");
  const check = await preflight(deps.baw, { giftUsd: formatUnits(valueUsd, 18), buying: false });
  if (!check.ready || check.address === null) {
    throw new GiftError(["Your Binance agent wallet is not ready:", ...check.problems.map((p) => `- ${p}`)].join("\n"));
  }
  const wallet = check.address;
  const balance = await balanceOf(stock.address, wallet, deps.client);
  if (held > balance) {
    throw new GiftError(`Your wallet ${wallet} holds ${formatUnits(balance, stock.decimals)} ${stock.symbol}, less than the ${heldText} to gift. Nothing was sent.`);
  }
  deps.log(`Gifting ${formatUnits(held, stock.decimals)} ${stock.symbol} you already hold; nothing will be bought.`);
  return { stock, wallet, received: held, swapTx: null };
}

async function lockAndWrap(deps: GiftDeps, from: Bought, input: GiftInput): Promise<GiftResult> {
  const { client, pinned, log } = deps;
  const { stock, wallet, received, swapTx } = from;
  const bought = `${formatUnits(received, stock.decimals)} ${stock.symbol}`;

  const key = newClaimKey();
  try {
    const keyProof = await signKeyProof(key.privateKey, pinned.vault, pinned.chainId, wallet);
    const sealedNote = await sealNote(key.privateKey, input.note);
    const startedAt = (await client.getBlock({ blockTag: "latest" })).timestamp;
    const expiry = input.days === undefined ? defaultExpiry(startedAt) : startedAt + BigInt(input.days) * 86_400n;

    const approveTx = buildApproveVaultTx({ token: stock.address, amount: received, vault: pinned.vault });
    const approved = await contractCall(deps, wallet, approveTx, {
      question: `Let the Moi vault ${pinned.vault} take exactly ${bought} for this gift?`,
      stopped: `Stopped before the approval. The ${bought} stays in your wallet.`,
      waiting: () =>
        `Approving the Moi vault is waiting for your OK in the Binance App, so Moi stopped here and sent nothing further. ` +
        `You hold the ${bought} in your wallet ${wallet}, and no gift was made.`,
    });

    const nowSeconds = (await client.getBlock({ blockTag: "latest" })).timestamp;
    const createTx = buildCreateGiftTx({
      vault: pinned.vault,
      token: stock.address,
      amount: received,
      claimKeyAddress: key.address,
      expiry,
      sealedNote,
      keyProof,
      nowSeconds,
    });
    // A holder object, because the file is set inside a callback that TypeScript cannot follow.
    const pending: { file: string | null } = { file: null };
    let created: { hash: Hex; receipt: TransactionReceipt };
    try {
      created = await contractCall(deps, wallet, createTx, {
        question: `Lock ${bought} in the Moi vault ${pinned.vault} as a gift until ${new Date(Number(expiry) * 1000).toISOString().slice(0, 10)}?`,
        stopped: `Stopped before locking the gift. The ${bought} stays in your wallet.`,
        waiting: () =>
          `Locking the gift is waiting for your OK in the Binance App, so Moi stopped here and sent nothing further. ` +
          `You hold the ${bought} in your wallet ${wallet} until you approve it there; then it moves into the vault as the gift. ` +
          `After you approve it, run \`npm run moi -- status\` to check the gift and save its link. The gift key is kept in ${pending.file} until then.`,
        beforeExecute: async () => {
          pending.file = await savePendingKey(deps.linkDir, key.privateKey, key.address);
        },
      });
    } catch (err) {
      // A reverted createGift made nothing, so its key is worthless; in every other case after
      // sending, the gift may still appear, so the key file stays.
      if (pending.file !== null && err instanceof TxFailed) await removePendingKey(pending.file);
      else if (pending.file !== null && !(err instanceof HeldInApp)) {
        throw new GiftError(
          `${err instanceof Error ? err.message : "Locking the gift did not finish."} The gift key is kept in ${pending.file}; ` +
            "run `npm run moi -- status` to check whether the gift was made.",
        );
      }
      throw err;
    }
    const giftId = readGiftIdFromReceipt(created.receipt, pinned.vault);
    // WHY (C48): the link is only worth sending if the vault really holds this stock under this
    // key. Read back from the vault, not from the receipt, before any link exists. The pending
    // key file stays, so nothing about the gift is lost while the sender looks into it.
    const stored = await readGift(client, pinned.vault, giftId);
    if (stored.state !== "Open" || getAddress(stored.claimKey) !== key.address || stored.token !== stock.address) {
      throw new GiftError(
        `Gift ${giftId} was made, but the vault's record of it is not the gift Moi asked for, so Moi saved no link. ` +
          `${pending.file === null ? "" : `The gift key is kept in ${pending.file}. `}As the sender, you can take the gift back after it expires.`,
      );
    }

    const link = buildLink(pinned.linkOrigin, giftId, key.privateKey);
    const linkFile = await saveNewLink(deps.linkDir, giftId, `${unwrappedMarker(giftId)}\n${link}\n`);
    if (pending.file !== null) await removePendingKey(pending.file);
    log(`Gift ${giftId} is locked in the vault. Paying the gift wrapping fee through b402.`);
    let wrapTx: Hex | null;
    try {
      wrapTx = await wrapGift(deps, giftId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "The wrapping failed.";
      throw new GiftNotWrapped(
        giftId,
        linkFile,
        err instanceof GiftCancelled,
        `Gift ${giftId} exists in the vault and its link is saved in ${linkFile}, but it is not wrapped yet, so Moi will not deliver it. ` +
          `Wrap it later with \`npm run moi -- wrap ${giftId}\`. ${reason}`,
      );
    }
    await rewritePrivate(linkFile, `${link}\n`);
    log(`Gift ${giftId} is ready. The link is saved in ${linkFile}. Send it to your friend.`);
    const txs = [swapTx, approved.hash, created.hash, wrapTx].filter((h): h is Hex => h !== null);
    return { giftId, linkFile, txs };
  } catch (err) {
    throw withoutKey(err, key.privateKey);
  }
}
