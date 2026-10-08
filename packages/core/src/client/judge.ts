import { getAddress, recoverMessageAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { parseGiftId } from "../gift.js";
import { judgeWalletMessage } from "../judge-message.js";
import type { JudgeClaimErrorCode } from "../judge.js";
import { ClaimFlowError, confirmClaimed } from "./claim.js";
import { callMoi, errorCodeOf, moiErrorText, type MoiApi, type MoiReply } from "./send.js";

// The relayer simulates and broadcasts before the server answers.
const JUDGE_TIMEOUT_MS = 60_000;
// The server's own caps (judge.ts bodySchema): a longer value is refused there anyway.
const MAX_ACCESS_TOKEN_CHARS = 4_096;
const MAX_JUDGE_CODE_CHARS = 32;
const SIGNATURE_TEXT = /^0x[0-9a-fA-F]{130}$/;
const JWT_TEXT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;
// The form privy.ts accepts for a user id, the `sub` of a Privy access token.
const PRIVY_USER_ID_TEXT = /^did:privy:[A-Za-z0-9]{1,128}$/;

const SIGN_IN_AGAIN = "Your sign-in could not be read. Sign out, sign in again and retry.";

const JUDGE_TEXT = {
  bad_judge_code: "That judge code is not right. It is in the submission's instructions for judges.",
  rate_limited: "Too many tries from your network. Wait a minute and try again.",
  bad_request: "Moi could not read the request. Reload the page and try again.",
  bad_token: SIGN_IN_AGAIN,
  bad_recipient: "That wallet cannot receive the gift. Use the wallet Moi set up for you when you signed in.",
  bad_wallet_proof: "Your wallet's signature could not be read. Try again.",
  proof_expired: "Your device's clock looks wrong, so the wallet proof was refused. Set the clock to automatic and try again.",
  no_declaration: "Confirm that you are not a US person and not in a restricted place, then claim.",
  restricted_place: "Moi gifts cannot be claimed from where you are connecting.",
  unknown_place: "Moi could not tell where you are connecting from, so it cannot release the gift. Try again on another network.",
  token_expired: "Your sign-in has expired. Sign in again and retry.",
  wallet_not_verified: "The signature did not come from the wallet you named. Use your signed-in wallet and try again.",
  unknown_network: "Moi could not identify your network, so it cannot hand out a judge gift. Try again on another network.",
  already_claimed: "You have already claimed a judge gift. Each judge gets one.",
  too_many_from_network: "A judge gift already went to someone on your network today. Try again tomorrow or from another network.",
  pool_empty: "All the judge gifts have been handed out. Ask the Moi team for another.",
  try_again: "Moi could not finish handing out the gift. Try again.",
  gift_expiring: "The next judge gift was about to expire. Try again.",
  claim_refused: "The vault refused the claim. Try again in a minute.",
  busy: "Moi is busy with another claim. Wait a few seconds and try again.",
  daily_cap: "Moi has paid for all the claims it can today. Try again tomorrow.",
  gas_price_high: "Network fees are unusually high right now. Try again in a few minutes.",
  auth_unavailable: "Moi could not reach the sign-in service. Try again in a minute.",
  store_unavailable: "Moi's server could not reach its records just now. Try again in a minute.",
  chain_unavailable: "Moi could not reach the blockchain just now. Try again in a minute.",
  relayer_unavailable: "Moi could not send the claim just now. Try again in a minute.",
  server_misconfigured: "Judge gifts are not set up correctly right now. Tell the Moi team.",
} as const satisfies Record<JudgeClaimErrorCode, string>;

const ROUTE_JUDGE_TEXT: Readonly<Record<string, string>> = {
  ...JUDGE_TEXT,
  judge_gifts_closed: "Judge gifts are closed right now. Tell the Moi team.",
};

/**
 * The Privy user id the server will read from `accessToken` (its `sub`), so the page signs the very
 * message the server rebuilds. Read without checking the token's signature: the server checks it,
 * and a token that lies about its `sub` only fails there. Null when it cannot be read.
 */
function privyUserId(accessToken: string): string | null {
  const payload = JWT_TEXT.exec(accessToken)?.[1];
  if (payload === undefined) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const sub = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { sub?: unknown } | null)?.sub;
    return typeof sub === "string" && PRIVY_USER_ID_TEXT.test(sub) ? sub : null;
  } catch {
    return null;
  }
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

const handedOutSchema = z.object({ ok: z.literal(true), giftId: z.string().max(78), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

/**
 * Claims one judge gift for a signed-in judge after an explicit tap (C16). Builds the wallet proof
 * with judge-message.ts judgeWalletMessage, the same function the server uses (standard 2): the
 * checksummed `recipient`, the Privy user id from the access token's `sub`, and issuedAt from
 * `now` (milliseconds) written YYYY-MM-DDTHH:MM:SSZ. `signMessage` is the recipient wallet's
 * personal_sign; its signature must recover to the recipient before anything is sent. Then POST
 * /api/judge with {accessToken, recipient, walletProof, issuedAt, judgeCode, declaration: true};
 * the server keeps every judge key (C26), so no key exists in the page. Returns claimed only once
 * the chain's receipt shows GiftClaimed(giftId, recipient) from the vault (claim.ts
 * confirmClaimed). Throws ClaimFlowError with a sentence for every server code; bad_judge_code is
 * "That judge code is not right. It is in the submission's instructions for judges."
 */
export async function claimJudgeGift(
  deps: MoiApi & { publicClient: PublicClient; vault: Address },
  input: {
    judgeCode: string;
    accessToken: string;
    recipient: Address;
    signMessage: (message: string) => Promise<Hex>;
    declaration: true;
    now: () => number;
  },
): Promise<{ claimed: true; giftId: bigint; txHash: Hex }> {
  if (input?.declaration !== true) throw new ClaimFlowError("bad_input", JUDGE_TEXT.no_declaration);
  if (typeof input.judgeCode !== "string" || input.judgeCode.trim() === "" || input.judgeCode.length > MAX_JUDGE_CODE_CHARS) {
    throw new ClaimFlowError("bad_input", JUDGE_TEXT.bad_judge_code);
  }
  const userId = typeof input.accessToken === "string" && input.accessToken.length <= MAX_ACCESS_TOKEN_CHARS ? privyUserId(input.accessToken) : null;
  if (userId === null) throw new ClaimFlowError("bad_input", SIGN_IN_AGAIN);
  let recipient: Address;
  let vault: Address;
  try {
    recipient = getAddress(input.recipient);
    vault = getAddress(deps.vault);
  } catch {
    throw new ClaimFlowError("bad_input", JUDGE_TEXT.bad_recipient);
  }
  if (recipient === zeroAddress || recipient === vault) throw new ClaimFlowError("bad_input", JUDGE_TEXT.bad_recipient);
  const nowMs = input.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new ClaimFlowError("bad_input", JUDGE_TEXT.proof_expired);
  const issuedAt = `${new Date(nowMs).toISOString().slice(0, 19)}Z`;
  let message: string;
  try {
    message = judgeWalletMessage({ recipient, userId, issuedAt });
  } catch {
    throw new ClaimFlowError("bad_input", JUDGE_TEXT.proof_expired);
  }

  let walletProof: unknown;
  try {
    walletProof = await input.signMessage(message);
  } catch (err) {
    throw isUserRejection(err)
      ? new ClaimFlowError("declined", "You declined in your wallet, so nothing was claimed.")
      : new ClaimFlowError("bad_input", JUDGE_TEXT.bad_wallet_proof);
  }
  // Standard 3: the wallet's answer is read like input, so a proof from another account fails here
  // with a clear sentence instead of at the server.
  let signer: Address | null = null;
  if (typeof walletProof === "string" && SIGNATURE_TEXT.test(walletProof)) {
    try {
      signer = getAddress(await recoverMessageAddress({ message, signature: walletProof as Hex }));
    } catch {
      signer = null;
    }
  }
  if (signer === null) throw new ClaimFlowError("bad_input", JUDGE_TEXT.bad_wallet_proof);
  if (signer !== recipient) throw new ClaimFlowError("bad_input", JUDGE_TEXT.wallet_not_verified);

  let reply: MoiReply;
  try {
    reply = await callMoi(deps, "POST", "/api/judge", {
      json: { accessToken: input.accessToken, recipient, walletProof, issuedAt, judgeCode: input.judgeCode, declaration: true },
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
  } catch {
    throw new ClaimFlowError("server_unreachable", "Moi's server could not be reached. Try again in a minute.");
  }
  if (reply.status !== 200) {
    const code = errorCodeOf(reply.body);
    throw new ClaimFlowError("refused", moiErrorText(code, ROUTE_JUDGE_TEXT), code);
  }
  const handedOut = handedOutSchema.safeParse(reply.body);
  let giftId: bigint;
  try {
    if (!handedOut.success) throw new Error("shape");
    giftId = parseGiftId(handedOut.data.giftId);
  } catch {
    throw new ClaimFlowError("unexpected", "Moi's server answered with something this page does not expect. Try again in a minute.");
  }
  const txHash = handedOut.data.txHash.toLowerCase() as Hex;
  await confirmClaimed(deps.publicClient, vault, txHash, giftId, recipient);
  return { claimed: true, giftId, txHash };
}
