import { formatUnits } from "viem";

/** "0x1234...abcd": 0x, the first four and the last four hex digits of an address or a transaction hash. */
export function shortHex(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

/** A token amount cut down (never rounded up) to `places` decimals, so a balance is never overstated. */
export function truncateUnits(value: bigint, decimals: number, places: number): string {
  const text = formatUnits(value, decimals);
  const [whole = "0", fraction = ""] = text.split(".");
  return places === 0 ? whole : `${whole}.${fraction.padEnd(places, "0").slice(0, places)}`;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The longest start of `text` that fits in `maxBytes` of UTF-8, never cutting a character in half. */
export function clipToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * Keeps what a person types into the "Other" amount box if it is still a plain dollar amount with at
 * most two decimals and no more than `max`. Returns null when the new text should be refused.
 */
export function acceptAmountText(text: string, max: number): string | null {
  if (text === "") return "";
  if (!/^\d{0,3}(\.\d{0,2})?$/.test(text)) return null;
  if (text === ".") return "0.";
  const value = Number(text);
  if (!Number.isFinite(value) || value > max) return null;
  return text;
}

/** The amount as the plain decimal string core's parseAmount wants: no trailing dot, no leading zeros. */
export function cleanAmount(text: string): string {
  const trimmed = text.endsWith(".") ? text.slice(0, -1) : text;
  const [whole = "0", fraction] = trimmed.split(".");
  const wholeClean = whole.replace(/^0+(?=\d)/, "") || "0";
  return fraction === undefined || fraction === "" ? wholeClean : `${wholeClean}.${fraction}`;
}

export function usd(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "OPENS 14:30", or "OPENS MON 14:30" when the market opens on another day. Seconds and milliseconds are both read. */
export function opensText(nextOpenTime: number | null, now: Date): string {
  if (nextOpenTime === null) return "CLOSED";
  const opens = new Date(nextOpenTime < 100_000_000_000 ? nextOpenTime * 1000 : nextOpenTime);
  if (Number.isNaN(opens.getTime())) return "CLOSED";
  const time = opens.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = opens.toDateString() === now.toDateString();
  const weekday = opens.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
  return today ? `OPENS ${time}` : `OPENS ${weekday} ${time}`;
}
