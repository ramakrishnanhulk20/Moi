// Not covered here: whether the router address itself is honest, and what the swap calldata
// does inside the router. Those are pinned by a reviewed constant and confirmed by simulation.
import { encodeFunctionData, maxUint256, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { USDT } from "../src/chain.js";
import { checkApproveTx, checkSwapTx, EXPECTED_ROUTER } from "../src/checks.js";

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const ONE = 10n ** 18n;
const OTHER = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const approveData = (spender: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [spender, amount] });
const expectApprove = { token: USDT, spender: EXPECTED_ROUTER, amount: ONE };

describe("checkApproveTx", () => {
  it("accepts the exact live shape: approve(router, amount) sent to the token", () => {
    // Calldata copied from the live approve-transaction response of 2026-10-07.
    const live = "0x095ea7b3000000000000000000000000b44446b0c8e56988c34f7ff73ae904982b5fdda50000000000000000000000000000000000000000000000000de0b6b3a7640000";
    expect(checkApproveTx({ to: USDT, data: live, value: "0" }, expectApprove)).toEqual({ ok: true });
    expect(checkApproveTx({ to: USDT.toLowerCase(), data: approveData(EXPECTED_ROUTER, ONE), value: 0n }, expectApprove)).toEqual({ ok: true });
  });

  it("refuses an unlimited approval", () => {
    const r = checkApproveTx({ to: USDT, data: approveData(EXPECTED_ROUTER, maxUint256), value: "0" }, expectApprove);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/larger|unlimited/) });
  });

  it("refuses an approval larger or smaller than the purchase", () => {
    expect(checkApproveTx({ to: USDT, data: approveData(EXPECTED_ROUTER, ONE + 1n), value: "0" }, expectApprove).ok).toBe(false);
    expect(checkApproveTx({ to: USDT, data: approveData(EXPECTED_ROUTER, ONE - 1n), value: "0" }, expectApprove).ok).toBe(false);
  });

  it("refuses a wrong spender in the calldata", () => {
    const r = checkApproveTx({ to: USDT, data: approveData(OTHER, ONE), value: "0" }, expectApprove);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/spender/) });
  });

  it("refuses when the caller expects a spender other than the pinned router", () => {
    expect(checkApproveTx({ to: USDT, data: approveData(OTHER, ONE), value: "0" }, { ...expectApprove, spender: OTHER }).ok).toBe(false);
  });

  it("refuses a wrong token", () => {
    const r = checkApproveTx({ to: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", data: approveData(EXPECTED_ROUTER, ONE), value: "0" }, expectApprove);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/token/) });
  });

  it("refuses native value, trailing bytes, another function and garbage", () => {
    const good = approveData(EXPECTED_ROUTER, ONE);
    expect(checkApproveTx({ to: USDT, data: good, value: "1" }, expectApprove).ok).toBe(false);
    expect(checkApproveTx({ to: USDT, data: good, value: undefined }, expectApprove).ok).toBe(false);
    expect(checkApproveTx({ to: USDT, data: `${good}00`, value: "0" }, expectApprove).ok).toBe(false);
    expect(checkApproveTx({ to: USDT, data: `0xa9059cbb${good.slice(10)}`, value: "0" }, expectApprove).ok).toBe(false);
    expect(checkApproveTx({ to: USDT, data: "not hex", value: "0" }, expectApprove).ok).toBe(false);
    expect(checkApproveTx({ to: "0x123", data: good, value: "0" }, expectApprove).ok).toBe(false);
  });

  it("refuses dirty padding in the spender word", () => {
    const good = approveData(EXPECTED_ROUTER, ONE);
    const dirty = `${good.slice(0, 10)}ff${good.slice(12)}`;
    expect(checkApproveTx({ to: USDT, data: dirty, value: "0" }, expectApprove).ok).toBe(false);
  });
});

describe("checkSwapTx", () => {
  const tx = { to: EXPECTED_ROUTER, data: "0xad43f73d00", value: "0", minReceiveAmount: "4136525573308007" };
  const expectSwap = { router: EXPECTED_ROUTER, minOut: 4136525573308007n };

  it("accepts a swap at the floor and above it", () => {
    expect(checkSwapTx(tx, expectSwap)).toEqual({ ok: true });
    expect(checkSwapTx({ ...tx, to: EXPECTED_ROUTER.toLowerCase() }, { ...expectSwap, minOut: 1n })).toEqual({ ok: true });
  });

  it("refuses a wrong router", () => {
    expect(checkSwapTx({ ...tx, to: OTHER }, expectSwap)).toMatchObject({ ok: false, reason: expect.stringMatching(/router/) });
  });

  it("refuses a minimum below our floor", () => {
    expect(checkSwapTx({ ...tx, minReceiveAmount: "4136525573308006" }, expectSwap)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/below/),
    });
    expect(checkSwapTx({ ...tx, minReceiveAmount: "0" }, expectSwap).ok).toBe(false);
  });

  it("refuses native value, a missing or malformed minimum, and empty calldata", () => {
    expect(checkSwapTx({ ...tx, value: "1" }, expectSwap).ok).toBe(false);
    expect(checkSwapTx({ ...tx, value: 0n }, expectSwap).ok).toBe(false);
    expect(checkSwapTx({ ...tx, minReceiveAmount: undefined }, expectSwap).ok).toBe(false);
    expect(checkSwapTx({ ...tx, minReceiveAmount: "4.1e15" }, expectSwap).ok).toBe(false);
    expect(checkSwapTx({ ...tx, minReceiveAmount: "-1" }, expectSwap).ok).toBe(false);
    expect(checkSwapTx({ ...tx, data: "0x" }, expectSwap).ok).toBe(false);
  });

  it("refuses a zero floor from the caller", () => {
    expect(checkSwapTx(tx, { ...expectSwap, minOut: 0n }).ok).toBe(false);
  });
});
