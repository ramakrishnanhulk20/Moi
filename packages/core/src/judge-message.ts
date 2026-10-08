import { getAddress } from "viem";

// Kept apart from judge.ts, which needs node:crypto, so the judge page can build the very message
// the server checks from this one file (standard 2) without pulling server code into the browser.

export const ISSUED_AT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// A Privy id is "did:privy:" and letters and digits. Printable characters without a space or line
// break are all a user id may hold here, so no id can add a line to the signed message.
export const USER_ID_TEXT = /^[\x21-\x7e]{1,256}$/;

// UTC to the second and a date that exists: the round trip through Date refuses 2026-02-30.
export function isIssuedAtText(value: string): boolean {
  if (!ISSUED_AT_TEXT.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === `${value.slice(0, 19)}.000Z`;
}

/**
 * The exact text a judge's wallet signs with personal_sign (EIP-191) to prove it is theirs, four
 * lines joined by "\n":
 *   Moi judge gift
 *   Wallet: <checksummed recipient>
 *   Privy user: <user id>
 *   Issued at: <YYYY-MM-DDTHH:MM:SSZ>
 * The page and the server both build it here, so the two sides can never differ (standard 2). The
 * user id binds the proof to one judge and the time limits its reuse. Throws on an address
 * getAddress refuses, a user id that is not 1 to 256 printable characters without spaces, or a
 * time in any other form, so no field can add a line of its own.
 */
export function judgeWalletMessage(args: { recipient: string; userId: string; issuedAt: string }): string {
  const recipient = getAddress(args.recipient);
  if (typeof args.userId !== "string" || !USER_ID_TEXT.test(args.userId)) throw new RangeError("The user id is not one the judge message can hold.");
  if (typeof args.issuedAt !== "string" || !isIssuedAtText(args.issuedAt)) throw new RangeError("issuedAt must be written YYYY-MM-DDTHH:MM:SSZ.");
  return `Moi judge gift\nWallet: ${recipient}\nPrivy user: ${args.userId}\nIssued at: ${args.issuedAt}`;
}
