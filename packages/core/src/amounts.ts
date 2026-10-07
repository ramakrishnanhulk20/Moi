const DECIMAL_STRING = /^\d+(\.\d+)?$/;
// 2^256 is far above any real amount; a longer string is a mistake or an attack on BigInt.
const MAX_INPUT_LENGTH = 100;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Turns a plain decimal string such as "1" or "0.25" into integer base units for a token
 * with `decimals` decimals, without any floating-point step.
 * Throws on: anything but digits with an optional fraction, more fraction digits than
 * `decimals`, zero, a value above uint256, or a `decimals` outside 0 to 77.
 * `decimals` must come from the token contract, not from an API response.
 */
export function parseAmount(decimalString: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error("decimals must be a whole number from 0 to 77.");
  }
  if (typeof decimalString !== "string" || decimalString.length > MAX_INPUT_LENGTH || !DECIMAL_STRING.test(decimalString)) {
    throw new Error("Amount must be a plain decimal number such as 1 or 0.25.");
  }
  const [whole = "0", fraction = ""] = decimalString.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount has more than ${decimals} digits after the decimal point.`);
  }
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (value === 0n) throw new Error("Amount must be above zero.");
  if (value > UINT256_MAX) throw new Error("Amount is too large.");
  return value;
}
