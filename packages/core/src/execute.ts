import { formatUnits, getAddress, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { bsc } from "viem/chains";
import { BuyRefusedError, planBuy, simulate, SLIPPAGE_PERCENT, type BuyPlan, type SimulationResult } from "./buy.js";
import { balanceOf, rawToShares, readTokenInfo, USDT, type TokenInfo } from "./chain.js";
import { checkSwapSimulation, DEFAULT_PRICE_BAND_BPS, type CheckResult } from "./checks.js";
import { gasLimitFor } from "./gas.js";
import type { Web3Api } from "./web3api.js";

export const MIN_BNB_FOR_BUY = 2_000_000_000_000_000n; // 0.002 BNB covers both transactions many times over at BSC prices
export const MAX_BUY_GAS_PRICE_WEI = 3_000_000_000n; // 3 gwei; BSC runs near 0.06 gwei, so anything above this is a bad node or a bad day
const MAX_APPROVE_GAS = 100_000n;
// WHY 2M: on 2026-10-08 live routes used up to 928,753 gas and Binance's own gas-limit endpoint
// named 1,120,153 for a 1 USDT route, which the 1.3 buffer puts near 1.5M. 2M at the 3 gwei
// ceiling is 0.006 BNB, still bounded.
const MAX_SWAP_GAS = 2_000_000n;
const RECEIPT_TIMEOUT_MS = 90_000;

// Upstream names (vendors, DEX names, symbols) go to a terminal: printable characters only.
export function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
}

export function fmt(raw: bigint, info: TokenInfo): string {
  return `${formatUnits(raw, info.decimals)} ${clean(info.symbol)} (raw ${raw})`;
}

export function fmtShares(raw: bigint, info: TokenInfo): string {
  return `${formatUnits(rawToShares(raw, info.uiMultiplier), info.decimals)} shares`;
}

export function simulationLines(name: string, sim: SimulationResult): string[] {
  const lines = [`  ${name}: ${sim.status}${sim.failReason ? ` (${clean(sim.failReason)})` : ""}`];
  for (const b of sim.balanceChanges) lines.push(`    balance change: owner ${clean(b.owner)} token ${clean(b.contractAddress) || "native"} ${b.change > 0n ? "+" : ""}${b.change}`);
  for (const a of sim.allowanceChanges) lines.push(`    allowance change: ${clean(a.owner)} -> ${clean(a.spender)} on ${clean(a.tokenAddress)}: ${a.preAmount} to ${a.postAmount}`);
  if (sim.balanceChanges.length === 0 && sim.allowanceChanges.length === 0) lines.push("    no balance or allowance changes reported");
  return lines;
}

/** The plan as printed lines. `usdtLabel` is the amount paid as the sender would write it, such as "1". */
export function planLines(plan: BuyPlan, stock: TokenInfo, usdtLabel: string): string[] {
  const q = plan.quote;
  const hops = (q.dexRouterList ?? []).map((h) => `${clean(h.dexProtocol.dexName)} ${clean(h.dexProtocol.percent)}%`).join(", ") || "not reported";
  return [
    `Quote: vendor ${clean(q.vendorName)}, mode ${clean(q.executionMode)}, route ${hops}, priceImpactPercent ${clean(q.priceImpactPercent)} (a fraction, not a percent)`,
    `Expected out for ${usdtLabel} USDT: ${fmt(plan.expectedOut, stock)} = ${fmtShares(plan.expectedOut, stock)}`,
    `Our floor at ${SLIPPAGE_PERCENT}% slippage: ${fmt(plan.minOut, stock)}; swap minReceiveAmount ${plan.swapTx.minReceiveAmount}`,
    `Router: ${plan.swapTx.to}`,
    `Check approve: ${plan.checks.approve === null ? "not needed, on-chain allowance already covers the amount" : plan.checks.approve.ok ? "PASS" : `FAIL ${plan.checks.approve.reason}`}`,
    `Check swap:    ${plan.checks.swap.ok ? "PASS" : `FAIL ${plan.checks.swap.reason}`}`,
    `Check price:   ${plan.checks.price.ok ? "PASS" : `FAIL ${plan.checks.price.reason}`} (RWA tokenPrice ${clean(plan.referenceUsdPrice)} USD, band ${DEFAULT_PRICE_BAND_BPS} bps)`,
  ];
}

/** checks.ts checkSwapSimulation for this plan, with its result as one printed line. */
export function swapSimulationCheck(
  sim: SimulationResult,
  plan: BuyPlan,
  wallet: Address,
  stock: Address,
  payAmount: bigint,
): { result: CheckResult; line: string } {
  const result = checkSwapSimulation(sim.raw, { wallet, payToken: USDT, payAmount, stock, minOut: plan.minOut });
  return { result, line: `  Check swap simulation: ${result.ok ? "PASS" : `FAIL ${result.reason}`}` };
}

/**
 * Buys `usdtAmount` USDT (base units) of `stock` for `account` on BSC, the one live buy path that
 * slice.ts and prove.ts share. In order: plan with buy.ts planBuy (every C21 check and the price
 * band), simulate the approval if one is needed and the swap, refuse unless the wallet holds the
 * USDT and 0.002 BNB and the node's gas price is at most 3 gwei, send the exact-amount approval
 * and wait for its receipt, then re-plan and re-simulate against the mined approval (the simulate
 * endpoint has no state override), send the swap only when checkSwapSimulation passes, and wait
 * for its receipt. Gas limits come from gas.ts gasLimitFor under fixed caps.
 * Returns the transaction hashes in send order and the stock received, measured as the wallet's
 * balance difference. Throws BuyRefusedError for any failed check or a reverted transaction (no
 * further transaction is sent after a refusal), Web3ApiError when the API fails, and the RPC's own
 * error when the node fails. `log` gets one printable line per step.
 */
export async function executeBuy(opts: {
  api: Web3Api;
  client: PublicClient;
  walletClient: WalletClient;
  account: Account;
  stock: Address;
  usdtAmount: bigint;
  log?: (line: string) => void;
}): Promise<{ txHashes: Hex[]; received: bigint }> {
  const { api, client, walletClient, account, usdtAmount } = opts;
  const log = opts.log ?? (() => undefined);
  const wallet = getAddress(account.address);
  const stock = getAddress(opts.stock);
  const [usdt, stockInfo] = await Promise.all([readTokenInfo(USDT, client), readTokenInfo(stock, client)]);
  const usdtLabel = formatUnits(usdtAmount, usdt.decimals);
  const [bnbBefore, usdtBefore, stockBefore] = await Promise.all([
    client.getBalance({ address: wallet }),
    balanceOf(USDT, wallet, client),
    balanceOf(stock, wallet, client),
  ]);

  let plan = await planBuy({ api, stock, usdtAmount, wallet, client });
  for (const line of planLines(plan, stockInfo, usdtLabel)) log(line);
  log("Simulations (Transaction API, latest BSC state):");
  const approveSim = plan.approveTx ? await simulate(api, plan.approveTx, wallet) : null;
  if (approveSim) for (const line of simulationLines("approve", approveSim)) log(line);
  const swapSim = await simulate(api, plan.swapTx, wallet);
  for (const line of simulationLines("swap", swapSim)) log(line);
  const firstCheck = swapSimulationCheck(swapSim, plan, wallet, stock, usdtAmount);
  log(firstCheck.line);

  if (usdtBefore < usdtAmount) throw new BuyRefusedError(`wallet holds less than ${usdtLabel} USDT`);
  if (bnbBefore < MIN_BNB_FOR_BUY) throw new BuyRefusedError("wallet holds less than 0.002 BNB for gas");
  const gasPrice = await client.getGasPrice();
  if (gasPrice <= 0n || gasPrice > MAX_BUY_GAS_PRICE_WEI) throw new BuyRefusedError(`gas price ${gasPrice} wei is above the 3 gwei ceiling`);
  const txHashes: Hex[] = [];
  const send = async (tx: { to: Address; data: Hex; gas: bigint }, cap: bigint) =>
    walletClient.sendTransaction({
      account,
      chain: bsc,
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: await gasLimitFor(client, wallet, { to: tx.to, data: tx.data, gas: tx.gas }, cap),
      gasPrice,
    });

  if (plan.approveTx) {
    if (!approveSim?.ok) throw new BuyRefusedError("approval simulation did not succeed");
    const hash = await send(plan.approveTx, MAX_APPROVE_GAS);
    log(`Approve sent: https://bscscan.com/tx/${hash}`);
    txHashes.push(hash);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new BuyRefusedError("approval reverted on chain");
    log(`Approve confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
    // WHY: the simulate endpoint documents no state override, so the swap is simulated again
    // after the approval is mined, against real chain state, with a fresh quote and fresh checks.
    plan = await planBuy({ api, stock, usdtAmount, wallet, client });
    for (const line of planLines(plan, stockInfo, usdtLabel)) log(line);
    if (plan.approveTx) throw new BuyRefusedError("allowance still short after the approval was mined");
    const again = await simulate(api, plan.swapTx, wallet);
    for (const line of simulationLines("swap (after approval)", again)) log(line);
    const againCheck = swapSimulationCheck(again, plan, wallet, stock, usdtAmount);
    log(againCheck.line);
    if (!againCheck.result.ok) throw new BuyRefusedError(`swap simulation check failed: ${againCheck.result.reason}`);
  } else if (!firstCheck.result.ok) {
    throw new BuyRefusedError(`swap simulation check failed: ${firstCheck.result.reason}`);
  }

  const swapHash = await send(plan.swapTx, MAX_SWAP_GAS);
  log(`Swap sent: https://bscscan.com/tx/${swapHash}`);
  txHashes.push(swapHash);
  const swapReceipt = await client.waitForTransactionReceipt({ hash: swapHash, timeout: RECEIPT_TIMEOUT_MS });
  if (swapReceipt.status !== "success") throw new BuyRefusedError("swap reverted on chain");
  log(`Swap confirmed in block ${swapReceipt.blockNumber}, gas used ${swapReceipt.gasUsed}`);

  const stockAfter = await balanceOf(stock, wallet, client);
  const received = stockAfter - stockBefore;
  log(`Received: ${fmt(received, stockInfo)} = ${fmtShares(received, stockInfo)} (floor was raw ${plan.minOut})`);
  return { txHashes, received };
}
