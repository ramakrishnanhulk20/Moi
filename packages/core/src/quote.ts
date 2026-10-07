import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { parseAmount } from "./amounts.js";
import { BuyRefusedError, planBuy, simulate, type SimulationResult } from "./buy.js";
import { readTokenInfo, USDT } from "./chain.js";
import { checkSwapSimulation } from "./checks.js";
import { buildApproveVaultTx, MAX_GIFT_USD } from "./create.js";
import { checkEligibility } from "./eligibility.js";
import { readListedTokens } from "./vault.js";
import { Web3ApiError, type Web3Api } from "./web3api.js";

/** Every error a quote request can get back. Short, fixed, and never built from upstream text (C19). */
export type QuoteErrorCode =
  | "bad_request"
  | "bad_stock"
  | "bad_wallet"
  | "bad_amount"
  | "amount_too_small"
  | "amount_too_large"
  | "restricted_place"
  | "unknown_place"
  | "not_listed"
  | "quote_refused"
  | "simulation_refused"
  | "upstream_unavailable"
  | "chain_unavailable";

const STATUS: Record<QuoteErrorCode, number> = {
  bad_request: 400,
  bad_stock: 400,
  bad_wallet: 400,
  bad_amount: 400,
  amount_too_small: 400,
  amount_too_large: 400,
  restricted_place: 403,
  unknown_place: 403,
  not_listed: 400,
  quote_refused: 422,
  simulation_refused: 422,
  upstream_unavailable: 502,
  chain_unavailable: 502,
};

/**
 * A transaction handed to the sender's wallet. It carries no gas limit and no gas price: the wallet
 * estimates both, so no upstream figure reaches a signature (C34).
 */
export type HandedTx = { to: Address; data: Hex; value: "0" };

/** The wallet's USDT allowance to the router is short. Send this approval alone, then ask again (C33). */
export type QuoteApprove = { ok: true; step: "approve"; approveTx: HandedTx };

/**
 * A swap that passed its own simulation for this wallet. Every bigint is a decimal string. `stock`
 * is the checksummed stock address and `usdAmount` the amount exactly as the request gave it, after
 * both passed their checks.
 */
export type QuoteSwap = {
  ok: true;
  step: "swap";
  stock: Address;
  usdAmount: string;
  swapTx: HandedTx;
  vaultApproveTx: HandedTx;
  expectedOut: string;
  minOut: string;
  priceUsd: string;
};

export type QuoteOk = QuoteApprove | QuoteSwap;

export type QuoteResponse = { status: 200; body: QuoteOk } | { status: number; body: { ok: false; error: QuoteErrorCode } };

// Lengths are the longest valid form of each field, so an oversized string fails before any
// parser sees it. The total body size is the caller's cap.
const bodySchema = z.strictObject({
  stock: z.string().max(42),
  usdAmount: z.string().max(40),
  wallet: z.string().max(42),
});

const MIN_GIFT_USD = "1";

const fail = (error: QuoteErrorCode): QuoteResponse => ({ status: STATUS[error], body: { ok: false, error } });

function errorCode(err: unknown): QuoteErrorCode {
  if (err instanceof BuyRefusedError) return "quote_refused";
  if (err instanceof Web3ApiError) return "upstream_unavailable";
  // RPC timeouts, a wrong chain and any other failure: the chain could not be read safely.
  return "chain_unavailable";
}

/**
 * The /api/quote handler, framework free. `body` is the already-parsed JSON (the caller caps its
 * size); `ctx` is the country and ISO 3166-2 region the hosting platform reports for the caller.
 * Checks, in order, and answers with the first that fails:
 * 1. the caller's place (403 restricted_place or unknown_place, C30);
 * 2. shape: exactly {stock, usdAmount, wallet} as strings (400);
 * 3. stock and wallet through getAddress, wallet not zero (400);
 * 4. the stock is in vault.listedTokens() read from chain (400 not_listed, C22);
 * 5. usdAmount through parseAmount with USDT decimals read from chain, from 1 USDT to
 *    MAX_GIFT_USD inclusive (400);
 * 6. buy.ts planBuy: every C21 check on the approval and swap, and the price band (422
 *    quote_refused; 502 upstream_unavailable when the Web3 API fails).
 * When the wallet's allowance to the router is short, answers 200 {step: "approve", approveTx}
 * and nothing else; the client sends it, waits for it to be mined and asks again (C33).
 * Otherwise:
 * 7. the exact swap handed out is simulated for this wallet on current state and must pass
 *    checks.ts checkSwapSimulation: the wallet pays exactly the USDT amount, gains at least minOut
 *    of the stock, loses nothing else and gains no allowance (422 simulation_refused, C33).
 * Then 200 {step: "swap", stock, usdAmount, swapTx, vaultApproveTx, expectedOut, minOut, priceUsd},
 * where stock is checksummed, usdAmount is the request's own text, and vaultApproveTx is an exact
 * approval of minOut to Moi's own vault, the least the swap can deliver.
 * Every handed-out transaction is {to, data, value: "0"} with no gas fields (C34). Sends nothing.
 * Never throws, and never returns upstream or chain text.
 */
export async function handleQuote(
  deps: { api: Web3Api; client: PublicClient; vault: Address; devAllowUnknownCountry?: boolean },
  body: unknown,
  ctx: { country?: string | null; region?: string | null },
): Promise<QuoteResponse> {
  // WHY true for the declaration: the "not a US person, not in a restricted place" statement is
  // the friend's, recorded on the claim page before a claim. A sender asking for a quote signs
  // every transaction in their own wallet, so only the place gate applies here, and passing true
  // leaves checkEligibility judging the place alone.
  const place = checkEligibility(
    { country: ctx?.country, region: ctx?.region, devAllowUnknown: deps.devAllowUnknownCountry === true },
    true,
  );
  if (!place.ok) return fail(place.reason === "restricted_place" ? "restricted_place" : "unknown_place");

  const shape = bodySchema.safeParse(body);
  if (!shape.success) return fail("bad_request");
  let stock: Address;
  try {
    stock = getAddress(shape.data.stock);
  } catch {
    return fail("bad_stock");
  }
  let wallet: Address;
  try {
    wallet = getAddress(shape.data.wallet);
  } catch {
    return fail("bad_wallet");
  }
  if (wallet === zeroAddress) return fail("bad_wallet");

  try {
    const [listed, usdt] = await Promise.all([readListedTokens(deps.client, deps.vault), readTokenInfo(USDT, deps.client)]);
    if (!listed.includes(stock)) return fail("not_listed");

    let usdtAmount: bigint;
    try {
      usdtAmount = parseAmount(shape.data.usdAmount, usdt.decimals);
    } catch {
      return fail("bad_amount");
    }
    if (usdtAmount < parseAmount(MIN_GIFT_USD, usdt.decimals)) return fail("amount_too_small");
    if (usdtAmount > parseAmount(MAX_GIFT_USD, usdt.decimals)) return fail("amount_too_large");

    const plan = await planBuy({ api: deps.api, stock, usdtAmount, wallet, client: deps.client });

    // WHY (C34): only to, data and a zero value leave this handler. planBuy has already proved the
    // value is zero (checkApproveTx, checkSwapTx), and the upstream gas and gasPrice are dropped
    // here so the wallet's own estimate is the only gas figure the sender signs.
    if (plan.approveTx !== null) {
      // WHY (C33): a swap cannot be simulated while its approval is unmined, and an unsimulated
      // swap is never handed out, so the approval goes alone and the swap is quoted afresh after.
      const approveTx: HandedTx = { to: plan.approveTx.to, data: plan.approveTx.data, value: "0" };
      return { status: 200, body: { ok: true, step: "approve", approveTx } };
    }

    // WHY (C33): the simulation runs on the exact object handed out, so what was proved and what
    // the wallet signs cannot drift apart. It is the only check that sees the swap's recipient and
    // output token inside the router calldata.
    const swapTx: HandedTx = { to: plan.swapTx.to, data: plan.swapTx.data, value: "0" };
    let sim: SimulationResult;
    try {
      sim = await simulate(deps.api, swapTx, wallet);
    } catch (err) {
      if (err instanceof BuyRefusedError) return fail("simulation_refused");
      throw err;
    }
    const proved = checkSwapSimulation(sim.raw, { wallet, payToken: USDT, payAmount: usdtAmount, stock, minOut: plan.minOut });
    if (!proved.ok) return fail("simulation_refused");

    const vaultApprove = buildApproveVaultTx({ token: stock, amount: plan.minOut, vault: deps.vault });
    return {
      status: 200,
      body: {
        ok: true,
        step: "swap",
        stock,
        usdAmount: shape.data.usdAmount,
        swapTx,
        vaultApproveTx: { to: vaultApprove.to, data: vaultApprove.data, value: "0" },
        expectedOut: plan.expectedOut.toString(),
        minOut: plan.minOut.toString(),
        priceUsd: plan.referenceUsdPrice,
      },
    };
  } catch (err) {
    return fail(errorCode(err));
  }
}
