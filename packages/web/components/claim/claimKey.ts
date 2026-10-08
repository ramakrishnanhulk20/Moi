import type { Hex } from "viem";
import { readLinkFromLocation } from "@moi/core/src/client/claim.js";

const STORAGE_PREFIX = "moi:claim:";

export type ClaimKeyResult = { key: Hex | null; storageBlocked: boolean };

// The answer for each gift id, kept for the life of the page. React Strict Mode runs the boot twice in
// development, and by the second run the address no longer holds the key, so the first answer is reused.
// It is also the only copy of the key when the browser refuses storage.
const answers = new Map<string, ClaimKeyResult>();

/**
 * Takes the claim key out of the address bar and returns it (C12). Runs before Privy mounts: Privy
 * posts the page address to its own server when Google sign-in starts, and Google is a full-page
 * round trip, so the key must already be off the address and kept somewhere that survives the trip.
 * That place is sessionStorage under "moi:claim:<id>", which only this tab can read. When the address
 * has no key, the stored copy is read back through the same link parser. When storage throws, the
 * key stays in memory only and `storageBlocked` is true, so the page can say a Google round trip
 * would lose it. A fragment that is not a whole key is removed from the address too, because a
 * damaged copy of the key is still the key.
 */
export function takeClaimKey(id: string): ClaimKeyResult {
  const known = answers.get(id);
  if (known !== undefined) return known;

  let key: Hex | null = null;
  let storageBlocked = false;
  const link = readLinkFromLocation(window.location.href);
  if (link !== null && link.giftId === BigInt(id)) {
    key = link.claimKey;
    try {
      window.sessionStorage.setItem(STORAGE_PREFIX + id, link.claimKey);
    } catch {
      storageBlocked = true;
    }
  }
  if (window.location.hash !== "") window.history.replaceState(null, "", `/g/${id}`);

  if (key === null) {
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(STORAGE_PREFIX + id);
    } catch {
      storageBlocked = true;
    }
    if (stored !== null) key = readLinkFromLocation(`${window.location.origin}/g/${id}#${stored}`)?.claimKey ?? null;
  }

  const result = { key, storageBlocked };
  answers.set(id, result);
  return result;
}

/** Erases the key from this tab's storage and memory. Called once a claim is confirmed on chain. */
export function forgetClaimKey(id: string): void {
  answers.set(id, { key: null, storageBlocked: answers.get(id)?.storageBlocked ?? false });
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + id);
  } catch {
    // Storage that cannot be read has nothing to erase.
  }
}
