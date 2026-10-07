// Not covered here: whether the simulator itself is right, or whether chain state moves between
// simulation and inclusion. The fixture is a real recorded response; this file proves how we read it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NVDAB, USDT } from "../src/chain.js";
import { checkSwapSimulation } from "../src/checks.js";

type Change = { contractAddress: string; tokenType: string; change: string; owner: string };
type Sim = { status: string; failReason: string | null; balanceChanges: Change[]; allowanceChanges: Record<string, string>[] };

const fixture = JSON.parse(readFileSync(new URL("./fixtures/simulate-swap.json", import.meta.url), "utf8")) as {
  expect: { wallet: string; payAmount: string; minOut: string };
  success: Sim;
  failed: Sim;
};

const expectBuy = {
  wallet: fixture.expect.wallet,
  payToken: USDT,
  payAmount: BigInt(fixture.expect.payAmount),
  stock: NVDAB,
  minOut: BigInt(fixture.expect.minOut),
};

const copy = (): Sim => structuredClone(fixture.success);
const stockEntry = (s: Sim) => s.balanceChanges.find((b) => b.contractAddress.toLowerCase() === NVDAB.toLowerCase())!;
const payEntry = (s: Sim) => s.balanceChanges.find((b) => b.contractAddress.toLowerCase() === USDT.toLowerCase())!;

describe("checkSwapSimulation", () => {
  it("passes the real recorded success shape (mixed-case addresses, tokenType Erc20, empty failReason)", () => {
    expect(checkSwapSimulation(fixture.success, expectBuy)).toEqual({ ok: true });
  });

  it("refuses a FAILED status, using the real recorded failure", () => {
    const r = checkSwapSimulation(fixture.failed, { ...expectBuy, wallet: "0x69F1Cc47f7969dC8E2B0b1369059591A674FB15f" });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/FAILED/) });
  });

  it("refuses when the stock goes to a recipient other than the wallet", () => {
    const s = copy();
    stockEntry(s).owner = "0x000000000000000000000000000000000000dead";
    expect(checkSwapSimulation(s, expectBuy)).toMatchObject({ ok: false, reason: expect.stringMatching(/none of the stock/) });
  });

  it("refuses a stock gain below the minimum, and passes exactly at it", () => {
    const gain = BigInt(stockEntry(fixture.success).change);
    expect(checkSwapSimulation(fixture.success, { ...expectBuy, minOut: gain + 1n })).toMatchObject({ ok: false, reason: expect.stringMatching(/less than the minimum/) });
    expect(checkSwapSimulation(fixture.success, { ...expectBuy, minOut: gain })).toEqual({ ok: true });
  });

  it("refuses a different pay amount in either direction", () => {
    expect(checkSwapSimulation(fixture.success, { ...expectBuy, payAmount: expectBuy.payAmount - 1n }).ok).toBe(false);
    const s = copy();
    payEntry(s).change = "-1000000000000000001";
    expect(checkSwapSimulation(s, expectBuy)).toMatchObject({ ok: false, reason: expect.stringMatching(/different amount/) });
  });

  it("refuses an extra token leaving the wallet", () => {
    const s = copy();
    s.balanceChanges.push({ contractAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", tokenType: "Erc20", change: "-5", owner: fixture.expect.wallet.toLowerCase() });
    expect(checkSwapSimulation(s, expectBuy)).toMatchObject({ ok: false, reason: expect.stringMatching(/another token/) });
  });

  it("refuses an unidentified asset or a duplicate entry for the wallet", () => {
    const native = copy();
    native.balanceChanges.push({ contractAddress: "", tokenType: "Native", change: "-1", owner: fixture.expect.wallet });
    expect(checkSwapSimulation(native, expectBuy).ok).toBe(false);
    const dup = copy();
    dup.balanceChanges.push({ ...stockEntry(dup) });
    expect(checkSwapSimulation(dup, expectBuy)).toMatchObject({ ok: false, reason: expect.stringMatching(/twice/) });
  });

  it("refuses a swap that raises an allowance on the wallet", () => {
    const s = copy();
    s.allowanceChanges.push({ tokenAddress: USDT, owner: fixture.expect.wallet, spender: "0x000000000000000000000000000000000000dead", preAmount: "0", postAmount: "1" });
    expect(checkSwapSimulation(s, expectBuy)).toMatchObject({ ok: false, reason: expect.stringMatching(/allowance/) });
  });

  it("refuses success paired with a failure reason", () => {
    const s = copy();
    s.failReason = "execution reverted";
    expect(checkSwapSimulation(s, expectBuy).ok).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "SUCCESS"],
    ["an unknown status", { ...fixture.success, status: "PENDING" }],
    ["a missing balanceChanges", (({ balanceChanges: _b, ...rest }) => rest)(fixture.success)],
    ["a missing failReason", (({ failReason: _f, ...rest }) => rest)(fixture.success)],
    ["an extra top-level field", { ...fixture.success, warnings: [] }],
    ["a decimal change", { ...fixture.success, balanceChanges: [{ ...fixture.success.balanceChanges[0]!, change: "1.5" }] }],
    ["a malformed owner", { ...fixture.success, balanceChanges: [{ ...fixture.success.balanceChanges[0]!, owner: "0x123" }] }],
  ])("refuses a malformed body: %s", (_name, body) => {
    expect(checkSwapSimulation(body, expectBuy).ok).toBe(false);
  });
});
