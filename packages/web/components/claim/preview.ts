import type { Address, Hex } from "viem";
import type { GiftView } from "@moi/core/src/client/claim.js";

/**
 * Development only. ClaimFlow reads this when the address carries ?preview=<name>, so each screen of
 * the claim page can be looked at without a real open gift or a sign-in. Every call site is behind
 * a NODE_ENV check, so a production build holds none of this. Everything here is made up.
 */
const NAMES = ["ready", "signedin", "opening", "opened", "claimed", "refunded", "expired", "paused", "error", "halfopen", "invalid", "loading"] as const;

export type PreviewScenario = {
  gift: GiftView;
  note: string | null;
  invalid: boolean;
  loading: boolean;
  expired: boolean;
  loadFailed: boolean;
  claim: "idle" | "opening" | "opened" | "failed-after";
  fakeSignedIn: boolean;
  email: string;
  address: Address;
  txHash: Hex;
};

const MADE_UP_GIFT: GiftView = {
  giftId: 7n,
  state: "Open",
  token: "0x0000000000000000000000000000000000000b57",
  symbol: "NVDAB",
  name: "NVIDIA Corp",
  decimals: 18,
  amountRaw: 4_200_000_000_000_000n,
  shares: "0.0042",
  // 15 Oct 2026, 00:00 UTC.
  expiry: 1_792_022_400n,
  senderCompliant: true,
};

export function previewScenario(search: string): PreviewScenario | null {
  const name = new URLSearchParams(search).get("preview");
  if (name === null || !(NAMES as readonly string[]).includes(name)) return null;
  const state = name === "claimed" ? "Claimed" : name === "refunded" ? "Refunded" : "Open";
  return {
    gift: { ...MADE_UP_GIFT, state, senderCompliant: name !== "paused" },
    note: "Happy birthday, Meena.\nYour first stock. Spend it slowly.",
    invalid: name === "invalid",
    loading: name === "loading",
    expired: name === "expired",
    loadFailed: name === "error",
    claim: name === "opening" ? "opening" : name === "opened" ? "opened" : name === "halfopen" ? "failed-after" : "idle",
    fakeSignedIn: name === "signedin",
    email: "meena@example.com",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    txHash: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };
}
