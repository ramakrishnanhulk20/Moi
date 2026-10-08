// npm run judge-gifts              dry run: reads the chain and one live quote, prints the plan, signs nothing
// MOI_LIVE=1 npm run judge-gifts   the sponsor (deployer key) funds the judge gifts, then prints MOI_JUDGE_POOL
// Settings come from the repo-root .env at run time: MOI_VAULT_ADDRESS and MOI_JUDGE_SEED (both
// required for a live run), MOI_JUDGE_COUNT (default 10, at most 64), MOI_JUDGE_STOCK (default
// NVDAB) and MOI_JUDGE_USD_EACH (default "1", at most MAX_GIFT_USD). The seed and every key
// derived from it are never printed.
import { createWalletClient, formatUnits, getAddress, http, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { parseAmount } from "../src/amounts.js";
import { BuyRefusedError, planBuy } from "../src/buy.js";
import { balanceOf, CHAIN_ID, NVDAB, readTokenInfo, RPC_TIMEOUT_MS, USDT, useRpcUrl, type TokenInfo } from "../src/chain.js";
import { buildApproveVaultTx, buildCreateGiftTx, CreateGiftInputError, defaultExpiry, MAX_GIFT_USD, readGiftIdFromReceipt } from "../src/create.js";
import { EnvError, loadEnv } from "../src/env.js";
import { clean, executeBuy, fmt, fmtShares, MAX_BUY_GAS_PRICE_WEI } from "../src/execute.js";
import { gasLimitFor } from "../src/gas.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { sealNote, signKeyProof } from "../src/gift.js";
import { deriveJudgeKey, JudgeConfigError, MAX_JUDGE_INDEX, parseJudgePool } from "../src/judge.js";
import { readGift } from "../src/vault.js";
import { createWeb3Api, Web3ApiError, type Web3Api } from "../src/web3api.js";

const NOTE = "A first share from Moi, for the BNB Hack judges.";
const DEFAULT_COUNT = "10";
const DEFAULT_USD_EACH = "1";
const MAX_VAULT_APPROVE_GAS = 100_000n;
// createGift with its key proof measured 343,885 gas on the fork (prove.fork.test.ts, 2026-10-07);
// with gasLimitFor's 30 percent pad that is 447,050, under this cap.
const MAX_CREATE_GIFT_GAS = 500_000n;
const RECEIPT_TIMEOUT_MS = 90_000;
const EXPLORER = "https://bscscan.com";

const live = process.env.MOI_LIVE === "1";
const secrets: string[] = [];

function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

function say(line = ""): void {
  console.log(redact(line));
}

type Settings = { start: number; count: number; stock: Address; usdEach: string; seed: `0x${string}` | null };

// Read by name from the environment loadEnv filled. A bad value is reported by variable name
// only (EnvError), never echoed, because MOI_JUDGE_SEED sits next to the others.
function judgeSettings(source: Record<string, string | undefined>): Settings {
  const bad: string[] = [];
  const countText = source.MOI_JUDGE_COUNT || DEFAULT_COUNT;
  const count = /^[1-9][0-9]?$/.test(countText) ? Number(countText) : 0;
  if (count < 1 || count > MAX_JUDGE_INDEX + 1) bad.push("MOI_JUDGE_COUNT");
  // WHY a start index: a run that stops part way leaves its keys used, so the next run resumes after them.
  const startText = source.MOI_JUDGE_START || "0";
  const start = /^(0|[1-9][0-9]?)$/.test(startText) ? Number(startText) : -1;
  if (start < 0 || start + count - 1 > MAX_JUDGE_INDEX) bad.push("MOI_JUDGE_START");
  let stock = getAddress(NVDAB);
  try {
    stock = getAddress(source.MOI_JUDGE_STOCK || NVDAB);
  } catch {
    bad.push("MOI_JUDGE_STOCK");
  }
  const usdEach = source.MOI_JUDGE_USD_EACH || DEFAULT_USD_EACH;
  if (!/^[0-9]{1,3}(\.[0-9]{1,6})?$/.test(usdEach)) bad.push("MOI_JUDGE_USD_EACH");
  const seedText = source.MOI_JUDGE_SEED || null;
  if (seedText !== null) secrets.push(seedText, seedText.slice(2));
  if (seedText !== null && !/^0x[0-9a-fA-F]{64}$/.test(seedText)) bad.push("MOI_JUDGE_SEED");
  if (bad.length > 0) throw new EnvError(bad);
  return { start, count, stock, usdEach, seed: seedText as `0x${string}` | null };
}

async function judgeKey(seed: `0x${string}`, index: number): Promise<{ key: `0x${string}`; address: Address }> {
  const key = await deriveJudgeKey(seed, index);
  secrets.push(key, key.slice(2));
  return { key, address: privateKeyToAccount(key).address };
}

async function vaultHasCode(client: PublicClient, vault: Address): Promise<boolean> {
  const code = await client.getCode({ address: vault });
  return code !== undefined && code !== "0x";
}

type Live = {
  api: Web3Api;
  client: PublicClient;
  walletClient: WalletClient;
  sponsor: LocalAccount;
  vault: Address;
  stock: Address;
  stockInfo: TokenInfo;
  usdtAmount: bigint;
  usdEach: string;
  seed: `0x${string}`;
};

async function send(l: Live, tx: { to: Address; data: Hex }, cap: bigint, what: string) {
  const gasPrice = await l.client.getGasPrice();
  if (gasPrice <= 0n || gasPrice > MAX_BUY_GAS_PRICE_WEI) throw new BuyRefusedError(`gas price ${gasPrice} wei is above the 3 gwei ceiling`);
  const hash = await l.walletClient.sendTransaction({
    account: l.sponsor,
    chain: bsc,
    to: tx.to,
    data: tx.data,
    value: 0n,
    gas: await gasLimitFor(l.client, l.sponsor.address, tx, cap),
    gasPrice,
  });
  say(`  ${what} sent: ${EXPLORER}/tx/${hash}`);
  const receipt = await l.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new Error(`${what} reverted on chain`);
  say(`  ${what} confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  return receipt;
}

/**
 * Funds judge gift `index`: buys when the sponsor holds less than a fresh quote's floor, approves
 * the vault for exactly the gift amount, signs the key proof with the judge key, and creates the
 * gift with the sealed note and a 30-day expiry. Returns the gift id once the vault shows it Open
 * under that judge key.
 */
async function createJudgeGift(l: Live, index: number): Promise<bigint> {
  const judge = await judgeKey(l.seed, index);
  const used = await l.client.readContract({ address: l.vault, abi: giftVaultAbi, functionName: "claimKeyUsed", args: [judge.address] });
  if (used) throw new Error(`judge key ${index} is already used on this vault; a fresh MOI_JUDGE_SEED is needed`);

  const plan = await planBuy({ api: l.api, stock: l.stock, usdtAmount: l.usdtAmount, wallet: l.sponsor.address, client: l.client });
  let amount = plan.minOut;
  let held = await balanceOf(l.stock, l.sponsor.address, l.client);
  if (held < amount) {
    say(`  The sponsor holds ${fmt(held, l.stockInfo)}, under the gift's ${fmt(amount, l.stockInfo)}: buying ${l.usdEach} USDT.`);
    await executeBuy({ api: l.api, client: l.client, walletClient: l.walletClient, account: l.sponsor, stock: l.stock, usdtAmount: l.usdtAmount, log: (line) => say(`    ${line}`) });
    held = await balanceOf(l.stock, l.sponsor.address, l.client);
    // The buy re-quotes, so it can land a little under this floor; the gift is then what it bought.
    if (held < amount) amount = held;
  }
  if (amount <= 0n) throw new BuyRefusedError("the sponsor holds none of the stock after the buy");

  await send(l, buildApproveVaultTx({ token: l.stock, amount, vault: l.vault }), MAX_VAULT_APPROVE_GAS, "Vault approve");
  const keyProof = await signKeyProof(judge.key, l.vault, CHAIN_ID, l.sponsor.address);
  const sealedNote = await sealNote(judge.key, NOTE);
  const nowSeconds = (await l.client.getBlock({ blockTag: "latest" })).timestamp;
  const expiry = defaultExpiry(nowSeconds);
  const receipt = await send(
    l,
    buildCreateGiftTx({ vault: l.vault, token: l.stock, amount, claimKeyAddress: judge.address, expiry, sealedNote, keyProof, nowSeconds }),
    MAX_CREATE_GIFT_GAS,
    "createGift",
  );
  const giftId = readGiftIdFromReceipt(receipt, l.vault);
  const gift = await readGift(l.client, l.vault, giftId);
  if (gift.state !== "Open" || getAddress(gift.claimKey) !== getAddress(judge.address)) {
    throw new Error(`gift ${giftId} is not Open under judge key ${index}`);
  }
  say(`  Gift ${giftId}: ${fmt(gift.amount, l.stockInfo)} = ${fmtShares(gift.amount, l.stockInfo)}, expires ${new Date(Number(expiry) * 1000).toISOString()}`);
  return giftId;
}

async function main(): Promise<number> {
  const env = loadEnv();
  secrets.push(env.OC_API_KEY, env.OC_SECRET_KEY, env.DEPLOYER_PRIVATE_KEY, env.DEPLOYER_PRIVATE_KEY.slice(2), env.RELAYER_PRIVATE_KEY, env.RELAYER_PRIVATE_KEY.slice(2), env.BSC_RPC_URL);
  const settings = judgeSettings(process.env);
  const client = useRpcUrl(env.BSC_RPC_URL);
  const sponsor = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
  const api = createWeb3Api({ apiKey: env.OC_API_KEY, secretKey: env.OC_SECRET_KEY });
  const vault = env.MOI_VAULT_ADDRESS ?? null;

  say(`Moi judge gifts, ${live ? "LIVE: will sign and send on BSC mainnet" : "DRY RUN: signs nothing"}`);
  say(`Sponsor (deployer): ${sponsor.address}`);
  say(`Judge seed: ${settings.seed === null ? "not set (MOI_JUDGE_SEED); a live run needs it" : "set (never printed)"}`);
  if (settings.seed !== null) await judgeKey(settings.seed, 0);

  const [usdt, stockInfo] = await Promise.all([readTokenInfo(USDT, client), readTokenInfo(settings.stock, client)]);
  const usdtAmount = parseAmount(settings.usdEach, usdt.decimals);
  if (usdtAmount > parseAmount(MAX_GIFT_USD, usdt.decimals)) throw new EnvError(["MOI_JUDGE_USD_EACH"]);
  const symbol = clean(stockInfo.symbol);
  say(`Gifts: ${settings.count} x ${settings.usdEach} USDT of ${symbol} (${settings.stock}), judge key indices ${settings.start} to ${settings.start + settings.count - 1}`);
  say(`Each gift: expiry 30 days after the latest block at creation; note, sealed so only that gift's key opens it: "${NOTE}"`);

  let vaultReady = false;
  let listed = false;
  const usedIndices: number[] = [];
  if (vault === null) {
    say("Vault: not set (MOI_VAULT_ADDRESS); a live run needs it");
  } else if (!(await vaultHasCode(client, vault))) {
    say(`Vault: ${vault} has no contract on BSC yet; a live run refuses`);
  } else {
    vaultReady = true;
    listed = await client.readContract({ address: vault, abi: giftVaultAbi, functionName: "isListed", args: [settings.stock] });
    say(`Vault: ${vault}; ${symbol} listed: ${listed ? "yes" : "NO, a live run refuses"}`);
    if (settings.seed !== null) {
      const seed = settings.seed;
      const flags = await Promise.all(
        Array.from({ length: settings.count }, async (_, i) => {
          const judge = await judgeKey(seed, settings.start + i);
          return client.readContract({ address: vault, abi: giftVaultAbi, functionName: "claimKeyUsed", args: [judge.address] });
        }),
      );
      flags.forEach((usedFlag, i) => usedFlag && usedIndices.push(settings.start + i));
      say(`Judge keys already used on this vault: ${usedIndices.length === 0 ? "none" : `${usedIndices.join(", ")} (a live run refuses)`}`);
    }
  }

  const [bnb, usdtHeld, stockHeld] = await Promise.all([client.getBalance({ address: sponsor.address }), balanceOf(USDT, sponsor.address, client), balanceOf(settings.stock, sponsor.address, client)]);
  say(`Sponsor holds: ${formatUnits(bnb, 18)} BNB, ${fmt(usdtHeld, usdt)}, ${fmt(stockHeld, stockInfo)}`);
  const plan = await planBuy({ api, stock: settings.stock, usdtAmount, wallet: sponsor.address, client });
  say(`Quote for ${settings.usdEach} USDT: expected ${fmt(plan.expectedOut, stockInfo)}, floor ${fmt(plan.minOut, stockInfo)} = ${fmtShares(plan.minOut, stockInfo)}`);
  const covered = plan.minOut > 0n ? stockHeld / plan.minOut : 0n;
  const buys = BigInt(settings.count) > covered ? BigInt(settings.count) - covered : 0n;
  say(`Each gift holds the floor of a fresh quote at its creation. The sponsor's ${symbol} covers ${covered} now, so up to ${buys} buy(s) of ${settings.usdEach} USDT (${formatUnits(buys * usdtAmount, usdt.decimals)} USDT in all).`);
  say("Per gift, live: buy if short (executeBuy, every quote check), approve the vault for exactly the gift amount, sign the key proof with that judge key, createGift, then confirm it Open on chain.");
  say("The last line of a live run is MOI_JUDGE_POOL=<giftId:index,...> for the server's environment.");

  if (!live) {
    say("Dry run complete. Nothing was signed or sent.");
    return 0;
  }
  if (vault === null) throw new EnvError(["MOI_VAULT_ADDRESS"]);
  if (settings.seed === null) throw new EnvError(["MOI_JUDGE_SEED"]);
  if (!vaultReady) throw new Error("the vault has no contract on BSC");
  if (!listed) throw new Error(`${symbol} is not listed in the vault`);
  if (usedIndices.length > 0) throw new Error("some judge keys are already used on this vault; a fresh MOI_JUDGE_SEED is needed");

  const walletClient = createWalletClient({ account: sponsor, chain: bsc, transport: http(env.BSC_RPC_URL, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) });
  const l: Live = { api, client, walletClient, sponsor, vault, stock: settings.stock, stockInfo, usdtAmount, usdEach: settings.usdEach, seed: settings.seed };
  const entries: string[] = [];
  try {
    for (let i = settings.start; i < settings.start + settings.count; i += 1) {
      say(`Judge gift ${i - settings.start + 1} of ${settings.count} (index ${i}):`);
      entries.push(`${await createJudgeGift(l, i)}:${i}`);
    }
  } catch (err) {
    if (entries.length > 0) {
      say("Gifts created before the stop, as a pool line the server accepts:");
      say(`MOI_JUDGE_POOL=${entries.join(",")}`);
    }
    throw err;
  }
  const pool = entries.join(",");
  parseJudgePool(pool);
  say(`MOI_JUDGE_POOL=${pool}`);
  return 0;
}

function describe(err: unknown): string {
  if (err instanceof BuyRefusedError || err instanceof Web3ApiError || err instanceof EnvError || err instanceof JudgeConfigError || err instanceof CreateGiftInputError) {
    return err.message;
  }
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
}
process.exitCode = exitCode;
