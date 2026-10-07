// Not covered here: whether the RWA tokenPrice is itself a fair price (it is derived from the
// on-chain token price, not a stock exchange feed), or a pay token that is not worth one dollar.
import { describe, expect, it } from "vitest";
import { checkPriceBand, DEFAULT_PRICE_BAND_BPS } from "../src/checks.js";

const E18 = 10n ** 18n;
const ONE_USDT = E18;

// Expected output that puts the quote exactly `bpsOver` above a whole-dollar reference, rounded
// down, which nudges the effective price a hair higher than the target.
function outAt(referenceDollars: bigint, bpsOver: bigint, pay = ONE_USDT): bigint {
  return (pay * 10_000n * E18) / (referenceDollars * E18 * (10_000n + bpsOver));
}

const base = { payAmount: ONE_USDT, payDecimals: 18, stockDecimals: 18, referenceUsdPrice: "240", maxDeviationBps: DEFAULT_PRICE_BAND_BPS };

describe("checkPriceBand", () => {
  it("defaults to a 200 bps band", () => {
    expect(DEFAULT_PRICE_BAND_BPS).toBe(200);
  });

  it("passes 199 bps over and refuses 201 bps over", () => {
    expect(checkPriceBand({ ...base, expectedOut: outAt(240n, 199n) })).toEqual({ ok: true });
    expect(checkPriceBand({ ...base, expectedOut: outAt(240n, 201n) })).toMatchObject({ ok: false, reason: expect.stringMatching(/above the reference/) });
  });

  it("decides a 1-wei difference at the exact band edge, which float math cannot", () => {
    // 255 USDT for 1 token against 250 is exactly +200 bps: allowed. One wei less output is over.
    const edge = { ...base, payAmount: 255n * E18, referenceUsdPrice: "250" };
    expect(checkPriceBand({ ...edge, expectedOut: E18 })).toEqual({ ok: true });
    expect(checkPriceBand({ ...edge, expectedOut: E18 - 1n }).ok).toBe(false);
    expect(Number(255n * E18) / Number(E18 - 1n)).toBe(255);
  });

  it("handles different decimals and a long fractional reference", () => {
    expect(checkPriceBand({ ...base, payAmount: 255_000_000n, payDecimals: 6, referenceUsdPrice: "250", expectedOut: E18 })).toEqual({ ok: true });
    expect(checkPriceBand({ ...base, payAmount: 255_000_000n, payDecimals: 6, referenceUsdPrice: "250", expectedOut: E18 - 1n }).ok).toBe(false);
    // The live NVDAB numbers from 2026-10-07: 1 USDT bought 0.004179420361712676 NVDAB against a tokenPrice near 239.27.
    expect(checkPriceBand({ ...base, expectedOut: 4179420361712676n, referenceUsdPrice: "239.26605773482130436420000000" })).toEqual({ ok: true });
  });

  it("passes a price below the reference", () => {
    expect(checkPriceBand({ ...base, expectedOut: outAt(200n, 0n) })).toEqual({ ok: true });
  });

  it("refuses a missing reference and names the gap", () => {
    for (const ref of ["", undefined as unknown as string, null as unknown as string]) {
      expect(checkPriceBand({ ...base, expectedOut: outAt(240n, 0n), referenceUsdPrice: ref })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/AAPLB and AMZNB/),
      });
    }
  });

  it.each(["0", "0.000", "-240", "2.4e2", "abc", "240.", " 240"])("refuses the malformed reference %j", (ref) => {
    expect(checkPriceBand({ ...base, expectedOut: outAt(240n, 0n), referenceUsdPrice: ref }).ok).toBe(false);
  });

  it("refuses bad bands, decimals and zero amounts", () => {
    const out = outAt(240n, 0n);
    for (const maxDeviationBps of [-1, 1.5, 10_001, Number.NaN]) expect(checkPriceBand({ ...base, expectedOut: out, maxDeviationBps }).ok).toBe(false);
    expect(checkPriceBand({ ...base, expectedOut: out, payDecimals: 78 }).ok).toBe(false);
    expect(checkPriceBand({ ...base, expectedOut: 0n }).ok).toBe(false);
    expect(checkPriceBand({ ...base, expectedOut: out, payAmount: 0n }).ok).toBe(false);
  });
});
