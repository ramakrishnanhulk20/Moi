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

export type GiftInput = { ticker: string; usd: string; note: string; days?: number };

export type GiftResult = { giftId: bigint; linkFile: string; txs: Hex[] };

const CHAIN = "56";
const MIN_GIFT_USD = "1";
const MAX_DAYS = 90;
// The vault's list is owner-curated and short; a far longer one means something is wrong, and
// reading each symbol is one RPC call.
const MAX_LISTED_TOKENS = 100;
const POLL_MS = 3_000;
const SWAP_DEADLINE_MS = 120_000;
// A node behind by a block can still show the old balance right after Binance says FINISHED.
const BALANCE_READS = 5;
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
const orderListSchema = z
  .object({
    list: z
      .array(z.object({ orderId: z.union([z.string(), z.number()]), status: z.string().max(32), txHash: z.string().nullable().optional() }).loose())
      .max(100),
  })
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

/**
 * Buys `input.usd` dollars of a listed stock with the sender's Binance Agentic Wallet, locks it in
 * the Moi vault as a gift, saves the gift link and pays the wrapping fee through b402.
 *
 * Order: the ticker is resolved against the vault's on-chain list (C22) and the amount parsed
 * before any baw call, then the wallet preflight must be ready, then quote, confirm, swap (with
 * the received amount taken from the on-chain balance difference), claim key from the platform
 * random source (C11), approve the vault for exactly that amount, createGift, save the link,
 * wrap. Every target, amount, token and payee is built here or checked against `deps.pinned`
 * (C27): calldata comes from create.ts, never from a server; the fee must match pinned.payTo,
 * chain 56, WRAP_ASSETS and the fee ceiling (C24).
 *
 * The link is saved to `${linkDir}/gift-<id>.txt` (mode 0600 where the OS supports it) as soon as
 * the gift id is known, under a first line "# not wrapped yet: run `npm run moi -- wrap <id>`",
 * which is removed once wrapping succeeds, so a failed or declined wrap never loses the key.
 * The claim key and the link never reach `log`, stdout or a thrown message (C12).
 * Throws GiftError with a plain-English reason; GiftCancelled when `confirm` answers no before
 * the gift exists; GiftNotWrapped when the gift exists and its link is saved but it is not wrapped.
 */
export async function sendGift(deps: GiftDeps, input: GiftInput): Promise<GiftResult> {
  const { baw, client, pinned, log } = deps;

  if (typeof input.ticker !== "string" || !TICKER_TEXT.test(input.ticker)) {
    throw new GiftError("That is not a stock ticker. Use letters such as NVDA.");
  }
  if (typeof input.note !== "string" || new TextEncoder().encode(input.note).length > MAX_NOTE_PLAINTEXT_BYTES) {
    throw new GiftError(`The note is too long. Keep it under ${MAX_NOTE_PLAINTEXT_BYTES} bytes.`);
  }
  if (input.days !== undefined && (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > MAX_DAYS)) {
    throw new GiftError(`The gift must last a whole number of days from 1 to ${MAX_DAYS}.`);
  }

  const stock = await resolveStock(client, pinned.vault, input.ticker);

  const usdtDecimals = (await readTokenInfo(pinned.usdt, client)).decimals;
  let amount: bigint;
  try {
    amount = parseAmount(input.usd, usdtDecimals);
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

  const before = await balanceOf(stock.address, wallet, client);
  const swap = swapSchema.safeParse(await baw(["market-order", "swap", ...tradeFlags]));
  const orderId = swap.success ? String(swap.data.orderId) : "";
  if (!ID_TEXT.test(orderId)) {
    throw new GiftError("Binance accepted the purchase but its reply had no readable order number. Check your wallet in the Binance App; Moi locked nothing.");
  }
  log("Binance is buying the stock. Waiting for it to finish.");
  const deadline = Date.now() + SWAP_DEADLINE_MS;
  let swapTx: Hex | null = null;
  for (;;) {
    let status: string | undefined;
    try {
      const page = orderListSchema.safeParse(await baw(["market-order", "list", "--orderId", orderId]));
      const order = page.success ? page.data.list.find((o) => String(o.orderId) === orderId) : undefined;
      status = order?.status;
      if (typeof order?.txHash === "string" && TX_HASH.test(order.txHash)) swapTx = order.txHash.toLowerCase() as Hex;
    } catch {
      // A failed status read is not an answer; keep asking until the deadline.
      status = undefined;
    }
    if (status === "FINISHED") break;
    if (status === "FAILED") throw new GiftError("Binance reports the purchase failed. Nothing was locked.");
    if (Date.now() + POLL_MS > deadline) {
      throw new GiftError("The purchase was still processing after 2 minutes, so Moi stopped before locking anything. Check your wallet in the Binance App.");
    }
    await sleep(POLL_MS);
  }
  // The order id has been unreliable for other builders, so the amount is what arrived on chain.
  let received = 0n;
  for (let read = 1; ; read += 1) {
    received = (await balanceOf(stock.address, wallet, client)) - before;
    if (received > 0n || read >= BALANCE_READS) break;
    await sleep(POLL_MS);
  }
  if (received <= 0n) {
    throw new GiftError(`Binance says the purchase finished, but no ${stock.symbol} arrived in your wallet on chain. Moi stopped before locking anything.`);
  }
  const bought = `${formatUnits(received, stock.decimals)} ${stock.symbol}`;
  // baw prints a bStock quote in shares (token amount times the token's multiplier, read from the
  // 1.10.0 bundle), so the on-chain amount is turned into shares with the token's own on-chain
  // multiplier before the two are compared.
  const quoted = decimalUnits(quote.data.toCoinAmount, stock.decimals);
  const floor = quote.data.minReceive === undefined ? (quoted * QUOTE_FLOOR_PERCENT) / 100n : decimalUnits(quote.data.minReceive, stock.decimals);
  const receivedShares = rawToShares(received, stock.uiMultiplier);
  if (receivedShares < floor) {
    throw new GiftError(
      `Binance delivered less than it quoted: ${formatUnits(receivedShares, stock.decimals)} ${stock.symbol} in shares arrived, ` +
        `below the minimum of ${formatUnits(floor, stock.decimals)} from its quote of ${quote.data.toCoinAmount}. ` +
        `The ${bought} is in your wallet ${wallet}. Moi stopped before approving the vault, so nothing was locked.`,
    );
  }
  log(`Bought ${bought}.`);

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
