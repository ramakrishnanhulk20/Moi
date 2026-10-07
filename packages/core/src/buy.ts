import { getAddress, type PublicClient } from "viem";
import { z } from "zod";
import { allowance, CHAIN_ID, publicClient, readTokenInfo, USDT } from "./chain.js";
import { checkApproveTx, checkPriceBand, checkSwapTx, DEFAULT_PRICE_BAND_BPS, EXPECTED_ROUTER, type CheckResult } from "./checks.js";
import type { Web3Api } from "./web3api.js";

const CHAIN = String(CHAIN_ID);
export const SLIPPAGE_PERCENT = "1";
// Must stay equal to SLIPPAGE_PERCENT: the API applies the percent, we apply the same in basis points.
export const SLIPPAGE_BPS = 100n;

const uint = z.string().regex(/^\d{1,78}$/);
const addressString = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const label = z.string().max(80);

const tokenMeta = z.object({
  tokenContractAddress: addressString,
  tokenSymbol: label,
  decimal: z.string().optional(),
});

const routeSchema = z.object({
  quoteId: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
  vendorName: label,
  executionMode: z.string(),
  binanceChainId: z.string(),
  fromTokenAmount: uint,
  toTokenAmount: uint,
  priceImpactPercent: z.string().nullable().optional(),
  tradeFee: z.string().nullable().optional(),
  estimateGasFee: z.string().nullable().optional(),
  approveTarget: addressString.nullable().optional(),
  fromToken: tokenMeta,
  toToken: tokenMeta,
  dexRouterList: z
    .array(z.object({ dexProtocol: z.object({ dexName: label, percent: z.string().max(16) }) }))
    .max(50)
    .optional(),
});

const quoteSchema = z.array(routeSchema).min(1).max(50);

const approveSchema = z
  .array(z.object({ data: hexData, dexContractAddress: addressString, gasLimit: uint, gasPrice: uint }))
  .length(1);

const swapSchema = z.object({
  executionMode: z.string(),
  routerResult: z.object({
    binanceChainId: z.string(),
    vendorName: label,
    fromTokenAmount: uint,
    toTokenAmount: uint,
    fromToken: tokenMeta,
    toToken: tokenMeta,
  }),
  tx: z
    .object({
      from: addressString,
      to: addressString,
      data: hexData,
      value: z.string(),
      gas: uint,
      gasPrice: uint,
      maxPriorityFeePerGas: uint.nullable().optional(),
      minReceiveAmount: uint,
      slippagePercent: z.string(),
    })
    .nullable(),
});

const rwaPriceSchema = z
  .array(
    z.object({
      binanceChainId: z.string(),
      tokenContractAddress: addressString,
      tokenPrice: z.string().max(100).nullable().optional(),
    }),
  )
  .max(100);

const simulateSchema = z.object({
  status: z.string().max(32),
  failReason: z.string().nullable().optional(),
  balanceChanges: z
    .array(z.object({ contractAddress: z.string().max(64), tokenType: z.string().max(32).optional(), change: z.string().regex(/^-?\d{1,78}$/), owner: z.string().max(64) }))
    .max(200)
    .nullable()
    .optional(),
  allowanceChanges: z
    .array(z.object({ tokenAddress: z.string().max(64), owner: z.string().max(64), spender: z.string().max(64), preAmount: uint, postAmount: uint }))
    .max(200)
    .nullable()
    .optional(),
});

export type QuoteRoute = z.infer<typeof routeSchema>;

export type ApproveTx = { to: `0x${string}`; data: `0x${string}`; value: "0"; gas: bigint; gasPrice: bigint };

export type SwapTx = {
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  gas: bigint;
  gasPrice: bigint;
  minReceiveAmount: string;
};

export type BuyPlan = {
  quote: QuoteRoute;
  approveTx: ApproveTx | null;
  swapTx: SwapTx;
  expectedOut: bigint;
  minOut: bigint;
  referenceUsdPrice: string;
  checks: { approve: CheckResult | null; swap: CheckResult; price: CheckResult };
};

export type SimulationResult = {
  ok: boolean;
  status: string;
  failReason: string | null;
  balanceChanges: { contractAddress: string; tokenType: string | null; change: bigint; owner: string }[];
  allowanceChanges: { tokenAddress: string; owner: string; spender: string; preAmount: bigint; postAmount: bigint }[];
  /** The untouched `data` object, for checks.ts checkSwapSimulation, which applies its own strict parse. */
  raw: unknown;
};

/** Thrown when a quote, an approval or a swap fails a check. The reason is ours, never upstream text. */
export class BuyRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Purchase refused: ${reason}`);
    this.name = "BuyRefusedError";
    this.reason = reason;
  }
}

function parseOrRefuse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new BuyRefusedError(`${what} response did not have the expected shape`);
  return r.data;
}

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

/**
 * Quotes `usdtAmount` USDT (base units) into `stock`, fetches an exact-amount approval when the
 * wallet's on-chain allowance to the router is short, and builds the swap. Every transaction is
 * checked (C21), every response is cross-checked against the request, and the quote's price is
 * held within DEFAULT_PRICE_BAND_BPS of the RWA tokenPrice (decimals read from chain, C22).
 * Throws BuyRefusedError on any failed check, any RFQ route, a missing or duplicated reference
 * price, or any unexpected response shape;
 * throws Web3ApiError when the API itself fails. Sends nothing.
 */
export async function planBuy(args: {
  api: Web3Api;
  stock: string;
  usdtAmount: bigint;
  wallet: string;
  client?: PublicClient;
}): Promise<BuyPlan> {
  const { api, usdtAmount } = args;
  const stock = getAddress(args.stock);
  const wallet = getAddress(args.wallet);
  const client = args.client ?? publicClient();
  if (usdtAmount <= 0n) throw new BuyRefusedError("amount must be above zero");
  if (same(stock, USDT)) throw new BuyRefusedError("cannot buy USDT with USDT");
  const amount = usdtAmount.toString();

  const routes = parseOrRefuse(
    quoteSchema,
    await api.get("/api/v1/dex/aggregator/quote", {
      binanceChainId: CHAIN,
      amount,
      fromTokenAddress: USDT,
      toTokenAddress: stock,
      userWalletAddress: wallet,
    }),
    "quote",
  );
  const quote = routes[0]!;
  if (quote.executionMode === "RFQ") {
    throw new BuyRefusedError(`the best route (${quote.vendorName}) is an RFQ order, which Moi does not sign yet`);
  }
  if (quote.executionMode !== "SWAP") throw new BuyRefusedError("quote has an unknown execution mode");
  if (quote.binanceChainId !== CHAIN) throw new BuyRefusedError("quote is for another chain");
  if (quote.fromTokenAmount !== amount) throw new BuyRefusedError("quote is for a different amount");
  if (!same(quote.fromToken.tokenContractAddress, USDT)) throw new BuyRefusedError("quote sells a token other than USDT");
  if (!same(quote.toToken.tokenContractAddress, stock)) throw new BuyRefusedError("quote buys a token other than the requested stock");
  const expectedOut = BigInt(quote.toTokenAmount);
  if (expectedOut === 0n) throw new BuyRefusedError("quote returns nothing");
  const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (minOut === 0n) throw new BuyRefusedError("quote is too small to protect with a minimum");

  const [payInfo, stockInfo] = await Promise.all([readTokenInfo(USDT, client), readTokenInfo(stock, client)]);
  const prices = parseOrRefuse(
    rwaPriceSchema,
    await api.get("/api/v1/dex/market/rwa/price", { binanceChainId: CHAIN, tokenContractAddresses: stock }),
    "rwa/price",
  ).filter((p) => p.binanceChainId === CHAIN && same(p.tokenContractAddress, stock));
  if (prices.length > 1) throw new BuyRefusedError("reference price is listed more than once for this token");
  const referenceUsdPrice = prices[0]?.tokenPrice ?? "";
  const priceCheck = checkPriceBand({
    payAmount: usdtAmount,
    payDecimals: payInfo.decimals,
    expectedOut,
    stockDecimals: stockInfo.decimals,
    referenceUsdPrice,
    maxDeviationBps: DEFAULT_PRICE_BAND_BPS,
  });
  if (!priceCheck.ok) throw new BuyRefusedError(priceCheck.reason);

  let approveTx: ApproveTx | null = null;
  let approveCheck: CheckResult | null = null;
  const current = await allowance(USDT, wallet, EXPECTED_ROUTER, client);
  if (current < usdtAmount) {
    const [a] = parseOrRefuse(
      approveSchema,
      await api.get("/api/v1/dex/aggregator/approve-transaction", {
        binanceChainId: CHAIN,
        tokenContractAddress: USDT,
        approveAmount: amount,
      }),
      "approve-transaction",
    );
    if (!same(a!.dexContractAddress, EXPECTED_ROUTER)) throw new BuyRefusedError("approval names a spender other than the pinned router");
    // `to` is our own constant: the response does not carry one, and the check below proves
    // the calldata is an approval of exactly this token amount to the router.
    approveTx = { to: getAddress(USDT), data: a!.data as `0x${string}`, value: "0", gas: BigInt(a!.gasLimit), gasPrice: BigInt(a!.gasPrice) };
    approveCheck = checkApproveTx(approveTx, { token: USDT, spender: EXPECTED_ROUTER, amount: usdtAmount });
    if (!approveCheck.ok) throw new BuyRefusedError(approveCheck.reason);
  }

  const swap = parseOrRefuse(
    swapSchema,
    await api.get("/api/v1/dex/aggregator/swap", {
      binanceChainId: CHAIN,
      amount,
      fromTokenAddress: USDT,
      toTokenAddress: stock,
      userWalletAddress: wallet,
      quoteId: quote.quoteId,
      slippagePercent: SLIPPAGE_PERCENT,
    }),
    "swap",
  );
  if (swap.executionMode === "RFQ") throw new BuyRefusedError("swap came back as an RFQ order, which Moi does not sign yet");
  if (swap.executionMode !== "SWAP" || swap.tx === null) throw new BuyRefusedError("swap has no transaction to sign");
  const rr = swap.routerResult;
  if (rr.binanceChainId !== CHAIN) throw new BuyRefusedError("swap is for another chain");
  if (rr.fromTokenAmount !== amount) throw new BuyRefusedError("swap spends a different amount");
  if (!same(rr.fromToken.tokenContractAddress, USDT)) throw new BuyRefusedError("swap sells a token other than USDT");
  if (!same(rr.toToken.tokenContractAddress, stock)) throw new BuyRefusedError("swap buys a token other than the requested stock");
  if (!same(swap.tx.from, wallet)) throw new BuyRefusedError("swap is built for a different wallet");

  const swapTx: SwapTx = {
    from: getAddress(swap.tx.from),
    to: getAddress(swap.tx.to),
    data: swap.tx.data as `0x${string}`,
    value: swap.tx.value,
    gas: BigInt(swap.tx.gas),
    gasPrice: BigInt(swap.tx.gasPrice),
    minReceiveAmount: swap.tx.minReceiveAmount,
  };
  const swapCheck = checkSwapTx(swapTx, { router: EXPECTED_ROUTER, minOut });
  if (!swapCheck.ok) throw new BuyRefusedError(swapCheck.reason);

  return { quote, approveTx, swapTx, expectedOut, minOut, referenceUsdPrice, checks: { approve: approveCheck, swap: swapCheck, price: priceCheck } };
}

/**
 * Dry-runs one unsigned transaction on BSC through the Transaction API. The body field is `evmTx`
 * as documented, confirmed live on 2026-10-07 (some gateway errors name it `evmParams`). A revert
 * comes back as HTTP 200, code 0, status FAILED, so ok is true only for status SUCCESS.
 * Throws Web3ApiError when the API fails and BuyRefusedError when the answer has an unexpected shape.
 */
export async function simulate(api: Web3Api, tx: { to: string; data: string; value: string }, from: string): Promise<SimulationResult> {
  const raw = await api.post("/api/v1/dex/pre-transaction/simulate", {
    binanceChainId: CHAIN,
    evmTx: { from: getAddress(from), to: getAddress(tx.to), value: tx.value, data: tx.data },
  });
  const sim = parseOrRefuse(simulateSchema, raw, "simulate");
  return {
    ok: sim.status === "SUCCESS",
    status: sim.status,
    failReason: sim.failReason ?? null,
    balanceChanges: (sim.balanceChanges ?? []).map((b) => ({
      contractAddress: b.contractAddress,
      tokenType: b.tokenType ?? null,
      change: BigInt(b.change),
      owner: b.owner,
    })),
    allowanceChanges: (sim.allowanceChanges ?? []).map((a) => ({
      tokenAddress: a.tokenAddress,
      owner: a.owner,
      spender: a.spender,
      preAmount: BigInt(a.preAmount),
      postAmount: BigInt(a.postAmount),
    })),
    raw,
  };
}
