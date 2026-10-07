import { getAddress, type Address } from "viem";

/** True only when `a` parses as an address equal to `b` after getAddress on both sides. Never throws. */
export function sameAddress(a: unknown, b: Address): boolean {
  try {
    return typeof a === "string" && getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Upstream text made safe for a terminal: control characters (ANSI escapes included) and
 * direction overrides could repaint or reorder what the sender reads, so they are removed, and the
 * length is capped.
 */
export function shown(text: unknown, max = 80): string {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "")
    .slice(0, max);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
