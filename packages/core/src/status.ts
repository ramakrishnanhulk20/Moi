import { formatUnits, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { readTokenInfo, UI_MULTIPLIER_ONE } from "./chain.js";
import { parseGiftId } from "./gift.js";
import { clipText } from "./stocks.js";
import { readGift, readSenderIsCompliant, type GiftState } from "./vault.js";

export type GiftStatusErrorCode = "bad_gift_id" | "not_found" | "chain_unavailable";

/** Every bigint is a decimal string. No sender address: Moi does not put it on the claim page (N9). */
export type GiftStatus = {
  ok: true;
  giftId: string;
  state: Exclude<GiftState, "None">;
  token: Address;
  symbol: string;
  name: string;
  decimals: number;
  amountRaw: string;
  shares: string;
  expiry: string;
  claimKey: Address;
  sealedNote: Hex;
  senderCompliant: boolean;
};

export type GiftStatusResponse =
  | { status: 200; body: GiftStatus }
  | { status: 400 | 404 | 502; body: { ok: false; error: GiftStatusErrorCode } };

const nameAbi = parseAbi(["function name() view returns (string)"]);

/**
 * Whole shares held by `amountRaw` token units: amountRaw x uiMultiplier / 1e18 gives raw share
 * units, and the token's decimals turn those into shares. Exact: the product is an integer and
 * formatUnits only places the decimal point, so nothing is rounded and no float is used (C22).
 * A token without uiMultiplier counts as 1e18, one token per share.
 */
export function sharesText(amountRaw: bigint, uiMultiplier: bigint | null, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new RangeError("decimals must be a whole number from 0 to 77.");
  return formatUnits(amountRaw * (uiMultiplier ?? UI_MULTIPLIER_ONE), 18 + decimals);
}

/**
 * The /api/gift/<id> handler, framework free. The id goes through gift.ts parseGiftId, the same
 * parser as the claim page and every route (standard 2). Answers:
 * - 400 bad_gift_id for an id that does not parse;
 * - 404 not_found for an id the vault never created (state None);
 * - 200 with the gift, its token's symbol, name and decimals read from the token contract, the
 *   share figure from the token's own uiMultiplier at read time (C22), and the vault's own
 *   compliance answer for the original sender (C7);
 * - 502 chain_unavailable when the chain cannot be read, or returns a state this code does not know.
 * Symbol and name are cut to 64 characters of plain text (C14). The sealed note is returned as the
 * vault holds it; only a link holder can open it (C9). Never throws, and never returns chain text.
 */
export async function handleGiftStatus(deps: { client: PublicClient; vault: Address }, giftIdText: string): Promise<GiftStatusResponse> {
  let giftId: bigint;
  try {
    giftId = parseGiftId(giftIdText);
  } catch {
    return { status: 400, body: { ok: false, error: "bad_gift_id" } };
  }
  try {
    const gift = await readGift(deps.client, deps.vault, giftId);
    if (gift.state === "None") return { status: 404, body: { ok: false, error: "not_found" } };
    const [info, name, senderCompliant] = await Promise.all([
      readTokenInfo(gift.token, deps.client),
      deps.client.readContract({ address: gift.token, abi: nameAbi, functionName: "name" }),
      readSenderIsCompliant(deps.client, deps.vault, giftId),
    ]);
    return {
      status: 200,
      body: {
        ok: true,
        giftId: giftId.toString(),
        state: gift.state,
        token: gift.token,
        symbol: clipText(info.symbol) ?? "",
        name: clipText(name) ?? "",
        decimals: info.decimals,
        amountRaw: gift.amount.toString(),
        shares: sharesText(gift.amount, info.uiMultiplier, info.decimals),
        expiry: gift.expiry.toString(),
        claimKey: gift.claimKey,
        sealedNote: gift.sealedNote,
        senderCompliant: senderCompliant === true,
      },
    };
  } catch {
    return { status: 502, body: { ok: false, error: "chain_unavailable" } };
  }
}
