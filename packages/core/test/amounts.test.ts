// Not covered here: where `decimals` comes from. The caller must read it from the token
// contract (chain.ts readTokenInfo); this file only proves the string to integer step.
import { describe, expect, it } from "vitest";
import { parseAmount } from "../src/amounts.js";

describe("parseAmount", () => {
  it("parses whole and fractional amounts exactly", () => {
    expect(parseAmount("1", 18)).toBe(10n ** 18n);
    expect(parseAmount("0.25", 18)).toBe(25n * 10n ** 16n);
    expect(parseAmount("1.000000000000000001", 18)).toBe(10n ** 18n + 1n);
    expect(parseAmount("7", 0)).toBe(7n);
  });

  it.each(["1e3", "-1", "0", "1.", "1.0000000000000000001", "", " 1", "1 ", ".5", "0x10", "1,5", "+1", "0.000"])(
    "rejects %j with 18 decimals",
    (input) => {
      expect(() => parseAmount(input, 18)).toThrow();
    },
  );

  it("rejects fraction digits when the token has none", () => {
    expect(() => parseAmount("1.5", 0)).toThrow();
  });

  it("rejects a bad decimals value", () => {
    expect(() => parseAmount("1", 1.5)).toThrow();
    expect(() => parseAmount("1", -1)).toThrow();
    expect(() => parseAmount("1", 78)).toThrow();
  });

  it("rejects values above uint256 and over-long strings", () => {
    expect(() => parseAmount("1" + "0".repeat(60), 18)).toThrow();
    expect(() => parseAmount("1".repeat(101), 0)).toThrow();
  });
});
