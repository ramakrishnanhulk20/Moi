// npm run slice           dry run: live quote, checks and simulations, signs nothing
// MOI_LIVE=1 npm run slice  buys 1 USDT of NVDAB with the deployer key, after the same gates
import { appendFileSync, mkdirSync } from "node:fs";
import { createWalletClient, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { parseAmount } from "../src/amounts.js";
import { BuyRefusedError, planBuy, simulate } from "../src/buy.js";
import { balanceOf, NVDAB, publicClient, readTokenInfo, RPC_TIMEOUT_MS, USDT, useRpcUrl, type TokenInfo } from "../src/chain.js";
import { EnvError, loadEnv } from "../src/env.js";
import { clean, executeBuy, fmt, fmtShares, planLines, simulationLines, swapSimulationCheck } from "../src/execute.js";
import { createWeb3Api, Web3ApiError, type CallRecord } from "../src/web3api.js";

const BUY_USDT = "1";
const CALL_LOG = new URL("../../../scratchpad/wo1/api-calls.jsonl", import.meta.url);

const live = process.env.MOI_LIVE === "1";
const secrets: string[] = [];
const calls: CallRecord[] = [];

function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

function say(line = ""): void {
  console.log(redact(line));
}

function logCall(c: CallRecord): void {
  calls.push(c);
  const line = { timestamp: new Date().toISOString(), path: c.path, method: c.method, ms: c.ms, httpStatus: c.httpStatus, code: c.code, msg: c.upstreamMsg?.slice(0, 200) ?? null };
  try {
    mkdirSync(new URL(".", CALL_LOG), { recursive: true });
    appendFileSync(CALL_LOG, `${redact(JSON.stringify(line))}\n`);
  } catch {
    // The log feeds the developer report; losing a line must not stop or change a purchase.
  }
}

async function balances(owner: string, usdt: TokenInfo, stock: TokenInfo) {
  const client = publicClient();
  const [bnb, u, s] = await Promise.all([client.getBalance({ address: owner as Hex }), balanceOf(USDT, owner), balanceOf(NVDAB, owner)]);
  const show = (tag: string) => {
    say(`${tag} BNB:   ${formatUnits(bnb, 18)} BNB (raw ${bnb})`);
    say(`${tag} USDT:  ${fmt(u, usdt)}`);
    say(`${tag} NVDAB: ${fmt(s, stock)} = ${fmtShares(s, stock)}`);
  };
  return { bnb, usdt: u, stock: s, show };
}

async function main(): Promise<number> {
  const env = loadEnv();
  secrets.push(env.OC_API_KEY, env.OC_SECRET_KEY, env.DEPLOYER_PRIVATE_KEY, env.DEPLOYER_PRIVATE_KEY.slice(2), env.RELAYER_PRIVATE_KEY, env.RELAYER_PRIVATE_KEY.slice(2), env.BSC_RPC_URL);
  useRpcUrl(env.BSC_RPC_URL);
  const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
  const api = createWeb3Api({ apiKey: env.OC_API_KEY, secretKey: env.OC_SECRET_KEY, onCall: logCall });

  say(`Moi core slice, ${live ? "LIVE: will sign and send on BSC mainnet" : "DRY RUN: signs nothing"}`);
  say(`Deployer: ${account.address}`);
  const [usdt, stock] = await Promise.all([readTokenInfo(USDT), readTokenInfo(NVDAB)]);
  say(`Tokens from chain: USDT decimals ${usdt.decimals}; ${clean(stock.symbol)} decimals ${stock.decimals}, uiMultiplier ${stock.uiMultiplier ?? "none"}`);
  const before = await balances(account.address, usdt, stock);
  before.show("Before");

  const amount = parseAmount(BUY_USDT, usdt.decimals);

  if (!live) {
    const plan = await planBuy({ api, stock: NVDAB, usdtAmount: amount, wallet: account.address });
    for (const line of planLines(plan, stock, BUY_USDT)) say(line);
    say("Simulations (Transaction API, latest BSC state):");
    const approveSim = plan.approveTx ? await simulate(api, plan.approveTx, account.address) : null;
    if (approveSim) for (const line of simulationLines("approve", approveSim)) say(line);
    const swapSim = await simulate(api, plan.swapTx, account.address);
    for (const line of simulationLines("swap", swapSim)) say(line);
    const swapSimCheck = swapSimulationCheck(swapSim, plan, account.address, NVDAB, amount);
    say(swapSimCheck.line);
    if (!swapSimCheck.result.ok) say("  (expected while the wallet is unfunded or the approval is not yet mined; a live run re-simulates after the approval and refuses unless this check passes)");
    say("Dry run complete. Nothing was signed or sent.");
    return 0;
  }

  const wallet = createWalletClient({ account, chain: bsc, transport: http(env.BSC_RPC_URL, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) });
  const result = await executeBuy({ api, client: publicClient(), walletClient: wallet, account, stock: NVDAB, usdtAmount: amount, log: say });

  const after = await balances(account.address, usdt, stock);
  before.show("Before");
  after.show("After ");
  for (const hash of result.txHashes) say(`https://bscscan.com/tx/${hash}`);
  return 0;
}

function describe(err: unknown): string {
  if (err instanceof BuyRefusedError || err instanceof Web3ApiError || err instanceof EnvError) return err.message;
  if (err instanceof Error) {
    const short = (err as Error & { shortMessage?: string }).shortMessage;
    return `${err.name}: ${short ?? err.message.split("\n")[0]}`;
  }
  return "unknown error";
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  say(`STOPPED, nothing further was sent: ${describe(err)}`);
} finally {
  if (calls.length > 0) {
    say("Web3 API calls (latency):");
    for (const c of calls) say(`  ${c.method} ${c.path} HTTP ${c.httpStatus} code ${c.code ?? "none"} ${c.ms} ms`);
  }
}
process.exitCode = exitCode;
