import { encodeFunctionData, getAddress, isHex, parseAbi } from "viem";
import { z } from "zod";

/**
 * The Binance Web3 aggregator router on BSC. Pinned 2026-10-07 from three live responses for a
 * 1 USDT to NVDAB buy that all named it: /api/v1/dex/aggregator/approve-transaction
 * (dexContractAddress and the spender inside its calldata), /api/v1/dex/aggregator/quote
 * (approveTarget) and /api/v1/dex/aggregator/swap (tx.to). A router change fails closed here
 * until a person reviews the new address and updates this constant.
 */
export const EXPECTED_ROUTER = getAddress("0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5");

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

export type TxLike = {
  to: string;
  data: string;
  value?: string | bigint | undefined;
};

export type SwapTxLike = TxLike & {
  minReceiveAmount?: string | undefined;
};

export type CheckResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): CheckResult => ({ ok: false, reason });

function sameAddress(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

function isZeroValue(v: TxLike["value"]): boolean {
  if (typeof v === "bigint") return v === 0n;
  return v === "0";
}

/**
 * Checks an ERC-20 approve transaction as if the sender had typed it: sent to `token`, with
 * calldata that is exactly approve(EXPECTED_ROUTER, amount) and no native value.
 * Rejects an unlimited or larger approval, any other spender, extra calldata bytes and any
 * non-canonical encoding. Never throws; a malformed field is a failed check.
 */
export function checkApproveTx(tx: TxLike, expect: { token: string; spender: string; amount: bigint }): CheckResult {
  try {
    if (!sameAddress(tx.to, expect.token)) return fail("approval is not addressed to the token being spent");
    if (!sameAddress(expect.spender, EXPECTED_ROUTER)) return fail("expected spender is not the pinned router");
    if (!isZeroValue(tx.value)) return fail("approval carries native value");
    if (typeof tx.data !== "string" || !isHex(tx.data, { strict: true })) return fail("approval calldata is not hex");
    if (expect.amount <= 0n) return fail("expected approval amount must be above zero");
    // Re-encoding what we expect and comparing bytes catches a wrong selector, wrong spender,
    // wrong amount, trailing bytes and dirty padding in one comparison.
    const canonical = encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [EXPECTED_ROUTER, expect.amount] });
    if (tx.data.toLowerCase() === canonical.toLowerCase()) return { ok: true };
    return fail(describeApproveMismatch(tx.data, expect.amount));
  } catch {
    return fail("approval has a malformed address or field");
  }
}

function describeApproveMismatch(data: string, amount: bigint): string {
  const lower = data.toLowerCase();
  if (!lower.startsWith("0x095ea7b3")) return "calldata is not an ERC-20 approve";
  if (lower.length !== 138) return "approve calldata has the wrong length";
  const spender = `0x${lower.slice(34, 74)}`;
  if (lower.slice(10, 34) !== "0".repeat(24) || getAddress(spender) !== EXPECTED_ROUTER) {
    return "approve spender is not the pinned router";
  }
  const encoded = BigInt(`0x${lower.slice(74)}`);
  if (encoded > amount) return "approve amount is larger than this purchase (unlimited approvals are refused)";
  return "approve amount does not equal this purchase";
}

/**
 * Checks the `tx` object from /api/v1/dex/aggregator/swap. Checked here: `to` equals `router`
 * (getAddress on both sides), `value` is exactly "0", `data` is non-empty strict hex, and
 * `minReceiveAmount` is a plain integer at or above our own floor `minOut`.
 * Not checked here, and where it is:
 * - output token, recipient and the exact amount paid: checkSwapSimulation, which slice.ts runs
 *   on a simulation before any swap is sent;
 * - price against an independent reference: checkPriceBand, inside buy.ts planBuy;
 * - chain, amount, tokens and wallet as the API reports them: buy.ts planBuy cross-checks;
 * - chain id 56: viem signs with `chain: bsc`, and chain.ts refuses any other RPC chain.
 * Checked nowhere: that the calldata itself encodes minReceiveAmount, and any deadline inside
 * the calldata. Neither is decoded; the simulation proves the output only at simulation time.
 * Never throws.
 */
export function checkSwapTx(tx: SwapTxLike, expect: { router: string; minOut: bigint }): CheckResult {
  try {
    if (!sameAddress(tx.to, expect.router)) return fail("swap is not addressed to the expected router");
    if (tx.value !== "0") return fail("swap carries native value");
    if (typeof tx.data !== "string" || !isHex(tx.data, { strict: true }) || tx.data.length < 10) {
      return fail("swap calldata is missing or not hex");
    }
    if (typeof tx.minReceiveAmount !== "string" || !/^\d{1,78}$/.test(tx.minReceiveAmount)) {
      return fail("swap has no readable minimum-receive amount");
    }
    if (expect.minOut <= 0n) return fail("our minimum output must be above zero");
    if (BigInt(tx.minReceiveAmount) < expect.minOut) return fail("swap minimum-receive is below our slippage floor");
    return { ok: true };
  } catch {
    return fail("swap has a malformed address or field");
  }
}

const signedInt = z.string().regex(/^-?\d{1,78}$/);
const unsignedInt = z.string().regex(/^\d{1,78}$/);

// Strict on purpose: the shape below is the one the live endpoint returned on 2026-10-07. A new
// or missing field means the endpoint changed, and a person should look before money moves.
const swapSimulationSchema = z.strictObject({
  status: z.enum(["SUCCESS", "FAILED"]),
  failReason: z.string().max(2_000).nullable(),
  balanceChanges: z
    .array(z.strictObject({ contractAddress: z.string().max(64), tokenType: z.string().max(32), change: signedInt, owner: z.string().max(64) }))
    .max(200),
  allowanceChanges: z
    .array(z.strictObject({ tokenAddress: z.string().max(64), owner: z.string().max(64), spender: z.string().max(64), preAmount: unsignedInt, postAmount: unsignedInt }))
    .max(200),
});

/**
 * Proves a swap from its own simulation, not from what the swap response claims. Passes only
 * when the raw `data` of /api/v1/dex/pre-transaction/simulate has status SUCCESS with an empty
 * failReason, and its balance changes show `wallet` paying exactly `payAmount` of `payToken`,
 * gaining at least `minOut` of `stock`, and losing no other token.
 * Extra rule: the swap must not raise any allowance owned by the wallet (allowanceChanges with
 * postAmount above preAmount), because a swap that grants a new approval could drain later.
 * Covers the recipient and output token that checkSwapTx cannot see inside the router calldata.
 * Does not cover the price (checkPriceBand) or what happens between simulation and inclusion.
 * Never throws: a malformed body, an unknown status, an unreadable address or a duplicate
 * entry for the wallet is a failed check.
 */
export function checkSwapSimulation(
  sim: unknown,
  expect: { wallet: string; payToken: string; payAmount: bigint; stock: string; minOut: bigint },
): CheckResult {
  try {
    const parsed = swapSimulationSchema.safeParse(sim);
    if (!parsed.success) return fail("simulation response did not have the expected shape");
    const s = parsed.data;
    if (s.status !== "SUCCESS") return fail(`simulation status is ${s.status}`);
    if (s.failReason !== null && s.failReason !== "") return fail("simulation reports success but also a failure reason");
    if (expect.payAmount <= 0n || expect.minOut <= 0n) return fail("expected pay amount and minimum must be above zero");

    const wallet = getAddress(expect.wallet);
    const payToken = getAddress(expect.payToken);
    const stock = getAddress(expect.stock);
    if (payToken === stock) return fail("pay token and stock are the same token");

    const walletDeltas = new Map<string, bigint>();
    for (const b of s.balanceChanges) {
      if (getAddress(b.owner) !== wallet) continue;
      // The docs say native BNB is reported with an empty or marker address. A token we cannot
      // name is an ambiguity, and the swap carries no native value, so it fails either way.
      let token: string;
      try {
        token = getAddress(b.contractAddress);
      } catch {
        return fail("simulation moves an unidentified asset for the wallet");
      }
      if (walletDeltas.has(token)) return fail("simulation lists the same token twice for the wallet");
      walletDeltas.set(token, BigInt(b.change));
    }

    const paid = walletDeltas.get(payToken);
    if (paid === undefined) return fail("simulation shows no payment from the wallet");
    if (paid !== -expect.payAmount) return fail("simulation shows the wallet paying a different amount");
    const gained = walletDeltas.get(stock);
    if (gained === undefined || gained <= 0n) return fail("simulation shows the wallet receiving none of the stock");
    if (gained < expect.minOut) return fail("simulation shows the wallet receiving less than the minimum");
    for (const [token, delta] of walletDeltas) {
      if (token !== payToken && delta < 0n) return fail("simulation shows another token leaving the wallet");
    }

    for (const a of s.allowanceChanges) {
      if (getAddress(a.owner) === wallet && BigInt(a.postAmount) > BigInt(a.preAmount)) {
        return fail("simulation shows the swap raising an allowance on the wallet");
      }
    }
    return { ok: true };
  } catch {
    return fail("simulation has a malformed address or amount");
  }
}

export const DEFAULT_PRICE_BAND_BPS = 200;
const PRICE_STRING = /^\d{1,40}(\.\d{1,40})?$/;

/**
 * Refuses a quote whose effective price per stock token is more than `maxDeviationBps` above
 * `referenceUsdPrice` (tokenPrice from /api/v1/dex/market/rwa/price). Integer math only: both
 * prices are compared after cross-multiplying, so no amount or price ever becomes a float.
 * Treats one unit of the pay token as one US dollar, which holds for USDT to a fraction of a
 * percent and is wrong for any non-dollar pay token. Does not refuse a price below the reference;
 * the simulation check already proves what the wallet receives. An empty reference is refused,
 * because the keyed RWA data does not cover every bStock and an unbounded price is not allowed.
 * Never throws.
 */
export function checkPriceBand(input: {
  payAmount: bigint;
  payDecimals: number;
  expectedOut: bigint;
  stockDecimals: number;
  referenceUsdPrice: string;
  maxDeviationBps: number;
}): CheckResult {
  try {
    const { payAmount, payDecimals, expectedOut, stockDecimals, referenceUsdPrice, maxDeviationBps } = input;
    if (typeof referenceUsdPrice !== "string" || referenceUsdPrice === "") {
      return fail("no RWA reference price for this token, so the price cannot be bounded (the keyed RWA data does not cover every bStock: its token list omits AAPLB and AMZNB)");
    }
    if (!PRICE_STRING.test(referenceUsdPrice)) return fail("reference price is not a plain decimal number");
    const validDecimals = (d: number) => Number.isInteger(d) && d >= 0 && d <= 77;
    if (!validDecimals(payDecimals) || !validDecimals(stockDecimals)) return fail("token decimals are out of range");
    if (!Number.isInteger(maxDeviationBps) || maxDeviationBps < 0 || maxDeviationBps > 10_000) {
      return fail("price band must be a whole number of basis points from 0 to 10000");
    }
    if (payAmount <= 0n || expectedOut <= 0n) return fail("pay amount and expected output must be above zero");

    const [whole = "0", fraction = ""] = referenceUsdPrice.split(".");
    const refUnits = BigInt(whole + fraction);
    if (refUnits === 0n) return fail("reference price is zero");
    const refScale = 10n ** BigInt(fraction.length);

    // effective = (payAmount / 10^payDecimals) / (expectedOut / 10^stockDecimals)
    // limit     = (refUnits / refScale) * (10000 + band) / 10000
    // Refuse when effective > limit, rearranged so every term stays a positive integer.
    const effectiveSide = payAmount * 10n ** BigInt(stockDecimals) * refScale * 10_000n;
    const referenceSide = refUnits * expectedOut * 10n ** BigInt(payDecimals);
    if (effectiveSide > referenceSide * BigInt(10_000 + maxDeviationBps)) {
      const overBps = (effectiveSide * 10_000n) / (referenceSide * 10_000n) - 10_000n;
      return fail(`quote price is about ${overBps} bps above the reference, more than the ${maxDeviationBps} bps band`);
    }
    return { ok: true };
  } catch {
    return fail("price inputs are malformed");
  }
}
