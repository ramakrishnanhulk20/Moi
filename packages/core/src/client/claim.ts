import { getAddress, isAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { assertChain, CHAIN_ID } from "../chain.js";
import type { ClaimErrorCode } from "../claim.js";
import { claimKeyMatches, LinkError, openNote, parseClaimKey, parseGiftId, parseLink, signClaim } from "../gift.js";
import { confirmClaim } from "../relayer.js";
import { callMoi, errorCodeOf, moiErrorText, type MoiApi, type MoiReply } from "./send.js";

export type ClaimFlowErrorCode =
  | "link_damaged"
  | "link_invalid"
  | "bad_input"
  | "declined"
  | "not_found"
  | "server_unreachable"
  | "refused"
  | "unconfirmed"
  | "not_claimed"
  | "chain_unavailable"
  | "unexpected";

/**
 * Every way loading or claiming a gift stops. `message` is a plain-English sentence that says what
 * to do next; `serverCode` is the fixed code Moi's server answered with, if any. Neither ever holds
 * the claim key (C12).
 */
export class ClaimFlowError extends Error {
  readonly code: ClaimFlowErrorCode;
  readonly serverCode: string | null;
  constructor(code: ClaimFlowErrorCode, message: string, serverCode: string | null = null) {
    super(message);
    this.name = "ClaimFlowError";
    this.code = code;
    this.serverCode = serverCode;
  }
}

/** A gift as the claim page shows it. Every figure is read from chain by Moi's server (C22). */
export type GiftView = {
  giftId: bigint;
  state: "Open" | "Claimed" | "Refunded";
  token: Address;
  symbol: string;
  name: string;
  decimals: number;
  amountRaw: bigint;
  shares: string;
  expiry: bigint;
  senderCompliant: boolean;
};

export type LoadedGift = { gift: GiftView; note: string | null; keyMatches: true } | { gift: null; note: null; keyMatches: false };

const GIFT_TIMEOUT_MS = 20_000;
// The relayer simulates, then broadcasts, before it answers.
const CLAIM_TIMEOUT_MS = 60_000;
const RECEIPT_TIMEOUT_MS = 120_000;
const TX_HASH_TEXT = /^0x[0-9a-fA-F]{64}$/;

const DAMAGED = "This gift link is damaged. Ask the sender to copy the whole link again.";
const UNREACHABLE = "Moi's server could not be reached. Your gift is safe; try again in a minute.";
const NOT_YOURS = "This gift was not claimed to your wallet. Someone else holding the link may have claimed it first.";

/**
 * Reads a gift link from the page address `href` (gift.ts parseLink: https, path /g/<id>, the
 * claim key in the fragment). Null for anything that is not a whole, well-formed gift link. The
 * caller must then take the fragment out of the address bar with history.replaceState, so the key
 * leaves the URL and lives only in this tab (C12).
 */
export function readLinkFromLocation(href: string): { giftId: bigint; claimKey: Hex } | null {
  try {
    const { giftId, claimKey } = parseLink(href);
    return { giftId, claimKey };
  } catch {
    return null;
  }
}

const addressText = z.custom<Address>((v) => typeof v === "string" && isAddress(v));
const uintText = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
// Server-clipped token text (status.ts): at most 64 characters, shown as plain text only (C14).
const plainText = z.string().max(64);
const giftStatusSchema = z.strictObject({
  ok: z.literal(true),
  giftId: uintText,
  state: z.enum(["Open", "Claimed", "Refunded"]),
  token: addressText,
  symbol: plainText,
  name: plainText,
  decimals: z.number().int().min(0).max(77),
  amountRaw: uintText,
  shares: z.string().max(160).regex(/^[0-9]+(\.[0-9]+)?$/),
  expiry: uintText,
  claimKey: addressText,
  sealedNote: z.string().max(2 + 2 * 512).regex(/^0x([0-9a-fA-F]{2})*$/),
  senderCompliant: z.boolean(),
});

function parsedLink(giftId: bigint, claimKey: Hex): { id: bigint; key: Hex } {
  try {
    return { id: parseGiftId(typeof giftId === "bigint" ? giftId.toString() : ""), key: parseClaimKey(claimKey) };
  } catch {
    throw new ClaimFlowError("link_damaged", DAMAGED);
  }
}

/**
 * Loads gift `giftId` for the claim page: GET /api/gift/:id, its answer checked field by field.
 * Shows contents only when `claimKey` produces the claim-key address the vault stores for that gift
 * (C15, gift.ts claimKeyMatches, one parser on both sides); otherwise returns {gift: null, note:
 * null, keyMatches: false} and the page says the link is not valid. With a matching key the sender's
 * note is opened: `note` is its text, "" for no note, or null when it cannot be opened. The note and
 * every token string must be rendered as plain text (C14). The key goes into no request (C12).
 * Throws ClaimFlowError: link_damaged, not_found, server_unreachable, chain_unavailable, refused or
 * unexpected.
 */
export async function loadGift(deps: MoiApi, giftId: bigint, claimKey: Hex): Promise<LoadedGift> {
  const { id, key } = parsedLink(giftId, claimKey);
  let reply: MoiReply;
  try {
    reply = await callMoi(deps, "GET", `/api/gift/${id}`, { timeoutMs: GIFT_TIMEOUT_MS });
  } catch {
    throw new ClaimFlowError("server_unreachable", UNREACHABLE);
  }
  if (reply.status !== 200) {
    const code = errorCodeOf(reply.body);
    if (code === "not_found") throw new ClaimFlowError("not_found", "This gift does not exist. Check that the whole link was copied.", code);
    if (code === "bad_gift_id") throw new ClaimFlowError("link_damaged", DAMAGED, code);
    if (code === "chain_unavailable") throw new ClaimFlowError("chain_unavailable", "Moi could not read the gift from the blockchain just now. Try again in a minute.", code);
    throw new ClaimFlowError("refused", moiErrorText(code, {}), code);
  }
  const parsed = giftStatusSchema.safeParse(reply.body);
  if (!parsed.success || parsed.data.giftId !== id.toString()) {
    throw new ClaimFlowError("unexpected", "Moi's server answered with something this page does not expect. Try again in a minute.");
  }
  const g = parsed.data;
  if (!claimKeyMatches(key, g.claimKey)) return { gift: null, note: null, keyMatches: false };
  let note: string | null;
  try {
    note = await openNote(key, g.sealedNote as Hex);
  } catch {
    note = null;
  }
  return {
    gift: {
      giftId: id,
      state: g.state,
      token: getAddress(g.token),
      symbol: g.symbol,
      name: g.name,
      decimals: g.decimals,
      amountRaw: BigInt(g.amountRaw),
      shares: g.shares,
      expiry: BigInt(g.expiry),
      senderCompliant: g.senderCompliant,
    },
    note,
    keyMatches: true,
  };
}

const CLAIM_TEXT = {
  bad_request: "Moi could not read the claim. Reload the page and try again.",
  bad_gift_id: DAMAGED,
  bad_recipient: "That wallet cannot receive the gift. Use the wallet Moi set up for you when you signed in.",
  bad_signature: "This link's key does not match the gift. Ask the sender to copy the whole link again.",
  no_declaration: "Confirm that you are not a US person and not in a restricted place, then claim.",
  restricted_place: "Moi gifts cannot be claimed from where you are connecting.",
  unknown_place: "Moi could not tell where you are connecting from, so it cannot release the gift. Try again on another network.",
  gift_not_open: "This gift has already been claimed, or its sender took it back.",
  gift_not_wrapped: "This gift is not ready yet: its sender has not finished wrapping it. Ask them to finish, then claim.",
  gift_expired: "This gift has expired, so it can no longer be claimed. Its sender can take it back.",
  gift_expiring: "This gift expires in under a minute, too soon to claim safely.",
  sender_blocked: "The stock's issuer is not letting this gift be released right now. Try again later; the link works until the gift expires.",
  claims_paused: "Claims are paused right now. Try again later; the link works until the gift expires.",
  claim_refused: "The vault refused this claim. Try again in a minute.",
  too_many_attempts: "The last claims of this gift failed on chain. Try again later.",
  busy: "Moi is already claiming this gift. Wait a few seconds and try again.",
  daily_cap: "Moi has paid for all the claims it can today. Try again tomorrow; the link works until the gift expires.",
  gas_price_high: "Network fees are unusually high right now. Try again in a few minutes.",
  relayer_unavailable: "Moi could not send the claim just now. Try again in a minute.",
  store_unavailable: "Moi's server could not reach its records just now. Try again in a minute.",
  chain_unavailable: "Moi could not reach the blockchain just now. Try again in a minute.",
} as const satisfies Record<ClaimErrorCode, string>;

const submittedSchema = z.object({ ok: z.literal(true), txHash: z.string().regex(TX_HASH_TEXT) });

/**
 * C16: waits for the receipt of `txHash` and returns only when it succeeded and holds a
 * GiftClaimed(giftId, recipient) log from `vault` (relayer.ts confirmClaim), read from a node that
 * reports chain 56. A returned hash alone never counts. Throws ClaimFlowError: unconfirmed when no
 * receipt arrives within 2 minutes, not_claimed when the receipt does not show this gift claimed to
 * this recipient, chain_unavailable when the node fails or is on another chain.
 */
export async function confirmClaimed(client: PublicClient, vault: Address, txHash: Hex, giftId: bigint, recipient: Address): Promise<void> {
  try {
    await assertChain(client);
  } catch {
    throw new ClaimFlowError("chain_unavailable", "Moi could not reach the blockchain to confirm the claim. Check again in a minute.");
  }
  try {
    await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  } catch {
    throw new ClaimFlowError("unconfirmed", `The claim was sent (transaction ${txHash}) but is not confirmed yet. Check again in a minute.`);
  }
  let claimed: boolean;
  try {
    claimed = await confirmClaim(client, vault, txHash, giftId, recipient);
  } catch {
    throw new ClaimFlowError("chain_unavailable", "Moi could not read the claim back from the blockchain. Check again in a minute.");
  }
  if (!claimed) throw new ClaimFlowError("not_claimed", NOT_YOURS);
}

/**
 * Claims gift `giftId` to `recipient` after the friend's explicit tap (C16): signs Claim(giftId,
 * recipient) with the link's key for this vault on chain 56 (gift.ts signClaim), sends only
 * {giftId, recipient, signature, declaration} to POST /api/claim, never the key (C12), and returns
 * claimed only once the chain's receipt shows GiftClaimed(giftId, recipient) from the vault
 * (confirmClaimed). `recipient` must be the friend's own externally owned wallet on chain 56; the
 * server refuses a contract. `declaration` must be true: the friend's statement that they are not
 * a US person and not in a restricted place (C30). Throws ClaimFlowError with a sentence that says
 * what to do next for every server code.
 */
export async function claimGift(
  deps: MoiApi & { publicClient: PublicClient; vault: Address },
  input: { giftId: bigint; claimKey: Hex; recipient: Address; declaration: true },
): Promise<{ claimed: true; txHash: Hex }> {
  if (input?.declaration !== true) throw new ClaimFlowError("bad_input", CLAIM_TEXT.no_declaration);
  const { id, key } = parsedLink(input.giftId, input.claimKey);
  let recipient: Address;
  let vault: Address;
  try {
    recipient = getAddress(input.recipient);
    vault = getAddress(deps.vault);
  } catch {
    throw new ClaimFlowError("bad_input", CLAIM_TEXT.bad_recipient);
  }
  if (recipient === zeroAddress || recipient === vault) throw new ClaimFlowError("bad_input", CLAIM_TEXT.bad_recipient);
  let signature: Hex;
  try {
    signature = await signClaim(key, vault, CHAIN_ID, id, recipient);
  } catch (err) {
    throw err instanceof LinkError && err.kind === "invalid"
      ? new ClaimFlowError("link_invalid", "This gift link is not valid. Ask the sender to copy the whole link again.")
      : new ClaimFlowError("link_damaged", DAMAGED);
  }

  let reply: MoiReply;
  try {
    reply = await callMoi(deps, "POST", "/api/claim", { json: { giftId: id.toString(), recipient, signature, declaration: true }, timeoutMs: CLAIM_TIMEOUT_MS });
  } catch {
    throw new ClaimFlowError("server_unreachable", UNREACHABLE);
  }
  if (reply.status !== 200) {
    const code = errorCodeOf(reply.body);
    throw new ClaimFlowError("refused", moiErrorText(code, CLAIM_TEXT), code);
  }
  const submitted = submittedSchema.safeParse(reply.body);
  if (!submitted.success) throw new ClaimFlowError("unexpected", "Moi's server answered with something this page does not expect. Try again in a minute.");
  const txHash = submitted.data.txHash.toLowerCase() as Hex;
  await confirmClaimed(deps.publicClient, vault, txHash, id, recipient);
  return { claimed: true, txHash };
}
