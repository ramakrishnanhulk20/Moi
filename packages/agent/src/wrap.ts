import { parseAmount } from "@moi/core/src/amounts.js";
import { parseGiftId } from "@moi/core/src/gift.js";
import { readGift } from "@moi/core/src/vault.js";
import { WRAP_ASSETS, type WrapAsset } from "@moi/core/src/wrap.js";
import { formatUnits, type Hex } from "viem";
import { z } from "zod";
import { sameAddress, sleep } from "./checks.js";
import { GiftCancelled, GiftError, WrapStillSettling } from "./errors.js";
import type { GiftDeps } from "./gift.js";
import { clearUnwrappedMarker } from "./linkfile.js";

/** What the wrap step needs: no link directory and never the claim key. */
export type WrapDeps = Pick<GiftDeps, "baw" | "client" | "pinned" | "fetchImpl" | "confirm" | "log">;

const CHAIN = "56";
const RECEIPT_TIMEOUT_MS = 120_000;
// The server settles through b402 before it answers, which Binance says can take about 20 s.
const SERVER_TIMEOUT_MS = 60_000;
const MAX_SERVER_BODY = 64 * 1024;
const MAX_REQUIRED_HEADER = 16 * 1024;
const ID_TEXT = /^[A-Za-z0-9_-]{1,128}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[A-Za-z0-9+/=_-]{1,16384}$/;

const acceptSchema = z
  .object({
    scheme: z.string().max(32),
    network: z.string().max(64),
    asset: z.string().max(64),
    amount: z.string().regex(/^\d{1,78}$/),
    payTo: z.string().max(64),
  })
  .loose();
const requiredSchema = z.object({ x402Version: z.literal(2), accepts: z.array(acceptSchema).min(1).max(16) }).loose();
const x402PreviewSchema = z
  .object({
    paymentId: z.string().regex(ID_TEXT),
    options: z
      .array(
        z
          .object({
            index: z.number().int().min(1).max(64),
            status: z.string().max(32),
            binanceChainId: z.union([z.string().max(16), z.number()]).optional(),
            tokenAddress: z.string().max(64).optional(),
            payTo: z.string().max(64).optional(),
            originalAccept: acceptSchema.optional(),
          })
          .loose(),
      )
      .max(64),
  })
  .loose();
const x402SignSchema = z
  .object({
    paymentHeaderName: z.string().regex(HEADER_NAME),
    paymentHeaderValue: z.string().regex(HEADER_VALUE),
    approveTxHash: z.string().regex(TX_HASH).nullable().optional(),
  })
  .loose();
const wrappedSchema = z.object({ wrapped: z.literal(true), txHash: z.string().optional() }).loose();

type ServerReply = { status: number; paymentRequired: string | null; retryAfter: string | null; body: unknown };

// While Binance's b402 settlement is pending the server answers 202; replaying the same request
// resumes it. The wait it asks for is held to 2 to 15 s, and the whole wait to 3 minutes.
const SETTLE_WAIT_MS = 180_000;
const MIN_RETRY_S = 2;
const MAX_RETRY_S = 15;
const DEFAULT_RETRY_S = 5;
const pendingSchema = z.object({ ok: z.literal(false), error: z.literal("settlement_pending"), retryAfterSeconds: z.number().optional() }).loose();

// redirect "error": a payment header must never follow a redirect to some other origin.
async function post(deps: WrapDeps, url: string, payment: [string, string] | null): Promise<ServerReply> {
  const res = await deps.fetchImpl(url, {
    method: "POST",
    headers: payment === null ? {} : { [payment[0]]: payment[1] },
    redirect: "error",
    signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length <= MAX_SERVER_BODY) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, paymentRequired: res.headers.get("payment-required"), retryAfter: res.headers.get("retry-after"), body };
}

const isWrapped = (reply: ServerReply) => reply.status === 200 && wrappedSchema.safeParse(reply.body).success;
const isSettling = (reply: ServerReply) => reply.status === 202 && pendingSchema.safeParse(reply.body).success;

function retryAfterMs(reply: ServerReply): number {
  const body = pendingSchema.safeParse(reply.body);
  const fromBody = body.success ? body.data.retryAfterSeconds : undefined;
  const fromHeader = reply.retryAfter !== null && /^\d{1,4}$/.test(reply.retryAfter) ? Number(reply.retryAfter) : undefined;
  const seconds = Number.isFinite(fromBody) ? (fromBody as number) : (fromHeader ?? DEFAULT_RETRY_S);
  return Math.min(MAX_RETRY_S, Math.max(MIN_RETRY_S, seconds)) * 1000;
}

/**
 * Sends one request, resending it once only after a network failure, then, while the server
 * answers 202 settlement_pending, waits and replays the identical request with the identical
 * header for up to 3 minutes. Returns the last reply, which is still a 202 when time ran out.
 */
async function send(deps: WrapDeps, url: string, payment: [string, string] | null, unreachable: string): Promise<ServerReply> {
  const once = async () => {
    try {
      return await post(deps, url, payment);
    } catch {
      deps.log("The wrap request did not get through. Trying once more with the same request.");
      try {
        return await post(deps, url, payment);
      } catch {
        throw new GiftError(unreachable);
      }
    }
  };
  let reply = await once();
  if (!isSettling(reply)) return reply;
  deps.log("Binance is still settling the wrapping fee. Moi will keep checking for up to 3 minutes.");
  const deadline = Date.now() + SETTLE_WAIT_MS;
  while (isSettling(reply)) {
    const wait = retryAfterMs(reply);
    if (Date.now() + wait > deadline) break;
    await sleep(wait);
    reply = await once();
  }
  return reply;
}

function wrappedTx(reply: ServerReply): Hex | null {
  const body = wrappedSchema.safeParse(reply.body);
  const tx = body.success ? body.data.txHash : undefined;
  return typeof tx === "string" && TX_HASH.test(tx) ? (tx.toLowerCase() as Hex) : null;
}

type CheckedAccept = { asset: WrapAsset; amount: bigint; raw: z.infer<typeof acceptSchema> };

/**
 * C24 and C27: refuses the server's payment requirements unless every accepted entry pays Moi's
 * pinned payout wallet, on eip155:56, in an asset from core's WRAP_ASSETS, with the exact
 * scheme, for no more than the pinned ceiling in that asset's decimals. Returns the decoded
 * object re-encoded from what was checked, so baw is handed exactly the bytes that passed.
 */
function checkRequirements(header: string | null, deps: WrapDeps): { encoded: string; accepts: CheckedAccept[] } {
  const { pinned } = deps;
  if (header === null || header.length > MAX_REQUIRED_HEADER || !BASE64_TEXT.test(header)) {
    throw new GiftError("The Moi server's payment request was missing or unreadable, so nothing was paid.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new GiftError("The Moi server's payment request was unreadable, so nothing was paid.");
  }
  const parsed = requiredSchema.safeParse(decoded);
  if (!parsed.success) throw new GiftError("The Moi server's payment request was not an x402 version 2 request, so nothing was paid.");

  const accepts: CheckedAccept[] = [];
  for (const accept of parsed.data.accepts) {
    if (accept.network !== "eip155:56") throw new GiftError("The payment request asks for payment on another network, so nothing was paid.");
    if (accept.scheme !== "exact") throw new GiftError("The payment request uses a payment scheme Moi does not use, so nothing was paid.");
    if (!sameAddress(accept.payTo, pinned.payTo)) {
      throw new GiftError("The payment request asks to pay someone other than Moi's payout wallet, so nothing was paid.");
    }
    const asset = WRAP_ASSETS.find((a) => sameAddress(accept.asset, a.address));
    if (asset === undefined) throw new GiftError("The payment request asks for a token Moi does not accept, so nothing was paid.");
    const amount = BigInt(accept.amount);
    if (amount <= 0n || amount > parseAmount(pinned.wrapFeeCeilingUsd, asset.decimals)) {
      throw new GiftError(`The payment request asks for more than the ${pinned.wrapFeeCeilingUsd} USD wrapping fee ceiling, so nothing was paid.`);
    }
    accepts.push({ asset, amount, raw: accept });
  }
  return { encoded: Buffer.from(JSON.stringify(decoded), "utf8").toString("base64"), accepts };
}

/**
 * The wrap step: asks the Moi server to wrap `giftId` and pays the b402 fee with baw's x402
 * payment. Prefers U or USD1 (eip3009, no approval) over USDT or USDC (Permit2). Signs at most
 * one payment per run. Resends a request once only after a network failure, and replays it
 * unchanged while the server answers 202 settlement_pending (see `send`). Needs only the gift id,
 * never the claim key. Returns the settlement transaction hash when the server gives one.
 * Throws WrapStillSettling when settlement is still pending after 3 minutes.
 */
export async function wrapGift(deps: WrapDeps, giftId: bigint): Promise<Hex | null> {
  const { pinned } = deps;
  const url = `${pinned.serverOrigin}/api/wrap/${giftId}`;
  const stillSettling = new WrapStillSettling(
    `The wrapping fee for gift ${giftId} was sent and is still settling at Binance. Run \`npm run moi -- wrap ${giftId}\` in a few minutes to finish it; that will not pay twice.`,
  );

  // A 202 here means an earlier payment for this gift is still settling: wait for it, never pay again.
  const first = await send(deps, url, null, "Moi could not reach its server to wrap the gift.");
  if (isWrapped(first)) return wrappedTx(first);
  if (isSettling(first)) throw stillSettling;
  if (first.status !== 402) throw new GiftError(`The Moi server could not start wrapping the gift (HTTP ${first.status}).`);

  const { encoded, accepts } = checkRequirements(first.paymentRequired, deps);
  const previewed = x402PreviewSchema.safeParse(await deps.baw(["x402-payment", "preview", "--paymentRequirements", encoded]));
  if (!previewed.success) throw new GiftError("Binance's payment preview came back in a shape Moi does not recognise, so nothing was paid.");

  // Each option is checked again here, as output of baw, against the requirements that passed.
  const usable = previewed.data.options.flatMap((option) => {
    const original = option.originalAccept;
    if (option.status !== "READY_TO_SIGN" || String(option.binanceChainId) !== CHAIN || !sameAddress(option.payTo, pinned.payTo)) return [];
    if (original === undefined) return [];
    const match = accepts.find(
      (a) =>
        sameAddress(option.tokenAddress, a.asset.address) &&
        sameAddress(original.asset, a.asset.address) &&
        sameAddress(original.payTo, pinned.payTo) &&
        original.network === "eip155:56" &&
        original.amount === a.raw.amount,
    );
    return match === undefined ? [] : [{ index: option.index, accept: match }];
  });
  const isSymbol = (...symbols: string[]) => (u: (typeof usable)[number]) => symbols.includes(u.accept.asset.symbol);
  const choice = usable.find(isSymbol("U", "USD1")) ?? usable.find(isSymbol("USDT", "USDC"));
  if (choice === undefined) {
    throw new GiftError("None of Binance's payment options is ready to sign. Check your U, USD1, USDT or USDC balance on BNB Smart Chain.");
  }

  const { asset, amount } = choice.accept;
  const fee = `${formatUnits(amount, asset.decimals)} ${asset.symbol} (${asset.address})`;
  if (!(await deps.confirm(`Pay the gift wrapping fee of ${fee} to Moi's payout wallet ${pinned.payTo}?`))) {
    throw new GiftCancelled("Stopped before paying the wrapping fee. Nothing was paid.");
  }
  const signed = x402SignSchema.safeParse(
    await deps.baw(["x402-payment", "sign", "--paymentId", previewed.data.paymentId, "--selectedIndex", String(choice.index)]),
  );
  if (!signed.success) throw new GiftError("Binance's signed payment came back in a shape Moi does not recognise, so it was not sent.");
  const approveTx = signed.data.approveTxHash;
  if (typeof approveTx === "string") {
    // Permit2 path: the one-time approval must be mined before the payment can settle.
    const receipt = await deps.client.waitForTransactionReceipt({ hash: approveTx as Hex, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new GiftError("The token approval for the wrapping fee failed on chain, so the payment was not sent.");
  }

  // The signed header lives only in memory and is the only one this run ever makes.
  const header: [string, string] = [signed.data.paymentHeaderName, signed.data.paymentHeaderValue];
  const paid = await send(
    deps,
    url,
    header,
    `Moi could not reach its server to finish wrapping, even after one retry. If the payment got there, \`npm run moi -- wrap ${giftId}\` finishes it without paying twice.`,
  );
  if (isWrapped(paid)) return wrappedTx(paid);
  if (isSettling(paid)) throw stillSettling;
  throw new GiftError(`The Moi server did not confirm the wrapping (HTTP ${paid.status}). The payment was not retried.`);
}

/**
 * `moi wrap <giftId>`: parses the id with core's one gift-id parser, requires the gift to be Open
 * in the vault, runs the same wrap step as `moi gift`, then removes the "not wrapped yet" line from
 * the saved link file in `deps.linkDir`, if there is one.
 */
export async function wrapSavedGift(
  deps: GiftDeps,
  giftIdText: string,
): Promise<{ giftId: bigint; linkFile: string | null; wrapTx: Hex | null }> {
  let giftId: bigint;
  try {
    giftId = parseGiftId(giftIdText);
  } catch {
    throw new GiftError("That is not a gift number. Use the number from the gift file name, such as 7.");
  }
  const gift = await readGift(deps.client, deps.pinned.vault, giftId);
  if (gift.state === "None") throw new GiftError(`There is no gift ${giftId} in the Moi vault.`);
  if (gift.state !== "Open") throw new GiftError(`Gift ${giftId} is already ${gift.state.toLowerCase()}, so there is nothing to wrap.`);

  deps.log(`Paying the wrapping fee for gift ${giftId} through b402.`);
  const wrapTx = await wrapGift(deps, giftId);
  const linkFile = await clearUnwrappedMarker(deps.linkDir, giftId);
  deps.log(
    linkFile === null
      ? `Gift ${giftId} is wrapped. Moi found no saved link marked "not wrapped yet" in ${deps.linkDir}.`
      : `Gift ${giftId} is wrapped. The link is saved in ${linkFile}. Send it to your friend.`,
  );
  return { giftId, linkFile, wrapTx };
}
