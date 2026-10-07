// npm run prove             dry run: the plan for 1 USDT of NVDAB and the vault's listed tokens; signs nothing
// MOI_LIVE=1 npm run prove  on BSC mainnet: buys 1 USDT of NVDAB, gifts it, claims it into a brand-new
//                           wallet through the relayer, and prints the proof. Needs MOI_VAULT_ADDRESS.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  type Account,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { parseAmount } from "../src/amounts.js";
import { BuyRefusedError, planBuy } from "../src/buy.js";
import { balanceOf, CHAIN_ID, NVDAB, readTokenInfo, RPC_TIMEOUT_MS, USDT, useRpcUrl } from "../src/chain.js";
import { handleClaim } from "../src/claim.js";
import { buildApproveVaultTx, buildCreateGiftTx, defaultExpiry, readGiftIdFromReceipt } from "../src/create.js";
import { EnvError, loadEnv } from "../src/env.js";
import { clean, executeBuy, fmt, fmtShares, MAX_BUY_GAS_PRICE_WEI, planLines } from "../src/execute.js";
import { gasLimitFor } from "../src/gas.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { buildLink, newClaimKey, openNote, sealNote, signClaim, signKeyProof } from "../src/gift.js";
import { confirmClaim, createRelayer } from "../src/relayer.js";
import { createMemoryStore, createUpstashStore, isSharedStore, type KvStore } from "../src/store.js";
import { readGift, readListedTokens, readRelayer } from "../src/vault.js";
import { createWeb3Api, Web3ApiError, type CallRecord } from "../src/web3api.js";

const BUY_USDT = "1";
const DEFAULT_ORIGIN = "http://localhost:3000";
const DEFAULT_COUNTRY = "IN";
const LINK_FILE = new URL("../../../scratchpad/prove/last-link.txt", import.meta.url);
const MAX_VAULT_APPROVE_GAS = 100_000n;
// createGift with its key proof measured 343,885 gas on the fork (prove.fork.test.ts, 2026-10-07);
// with gasLimitFor's 30 percent pad that is 447,050, under this cap.
const MAX_CREATE_GIFT_GAS = 500_000n;
const RECEIPT_TIMEOUT_MS = 90_000;
const EXPLORER = "https://bscscan.com";

/** A proof step that did not hold. The run stops and exits non-zero. */
export class ProveAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProveAssertionError";
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new ProveAssertionError(message);
}

const txLink = (hash: Hex) => `${EXPLORER}/tx/${hash}`;
const addressLink = (address: Address) => `${EXPLORER}/address/${address}`;

/** Total BNB the given transactions paid for gas, from their receipts. */
export async function gasSpent(client: PublicClient, hashes: readonly Hex[]): Promise<bigint> {
  let total = 0n;
  for (const hash of hashes) {
    const r = await client.getTransactionReceipt({ hash });
    total += r.gasUsed * r.effectiveGasPrice;
  }
  return total;
}

export type GiftAndClaimDeps = {
  client: PublicClient;
  vault: Address;
  sender: Account;
  senderWallet: WalletClient;
  relayerAccount: LocalAccount;
  relayerWallet: WalletClient;
  store: KvStore;
  /** True only when `store` is a one-process store on purpose: a fork test, or a run without Upstash (C38). */
  allowMemoryStore?: boolean;
  maxGasPriceWei: bigint;
  dailyCapWei: bigint;
  origin: string;
  country: string;
  linkFile: URL | string;
  log: (line: string) => void;
  /** Called with the claim key as soon as it exists, so the caller can redact it from every line. */
  onSecret?: (secret: string) => void;
  /**
   * MOI_SPONSOR_ADDRESS, the wallet whose gifts the relayer delivers without a wrapping fee, or
   * null. This run's gift is unwrapped, so handleClaim refuses it unless `sender` is the sponsor.
   */
  sponsor: Address | null;
};

export type GiftAndClaimResult = {
  giftId: bigint;
  recipient: Address;
  amount: bigint;
  txHashes: { vaultApprove: Hex; createGift: Hex; claim: Hex };
  senderGasWei: bigint;
  relayerGasWei: bigint;
};

/**
 * Prove steps 2 to 7: gifts exactly `amount` of `stock` from `sender` and claims it into a fresh
 * random wallet through the real relayer and handleClaim. The claim key is printed nowhere: the
 * printed link carries "<hidden>" and the full link goes only to `linkFile` (C12), which is deleted
 * as soon as confirmClaim shows the claim landed. Before that it stays, as the way to finish the
 * claim by hand if the run stops. Every check that fails throws ProveAssertionError; nothing
 * further is sent after a failure.
 */
export async function giftAndClaim(deps: GiftAndClaimDeps, stock: Address, amount: bigint): Promise<GiftAndClaimResult> {
  const { client, log } = deps;
  const vault = getAddress(deps.vault);
  const token = getAddress(stock);
  const sender = getAddress(deps.sender.address);
  const info = await readTokenInfo(token, client);
  const readLiability = () => client.readContract({ address: vault, abi: giftVaultAbi, functionName: "liabilities", args: [token] });
  const liabilityBefore = await readLiability();

  const claimKey = newClaimKey();
  deps.onSecret?.(claimKey.privateKey);
  deps.onSecret?.(claimKey.privateKey.slice(2));
  const note = `Moi prove run ${new Date().toISOString()}`;
  const sealedNote = await sealNote(claimKey.privateKey, note);
  const keyProof = await signKeyProof(claimKey.privateKey, vault, CHAIN_ID, sender);
  const nowSeconds = (await client.getBlock({ blockTag: "latest" })).timestamp;
  const expiry = defaultExpiry(nowSeconds);
  log(`Gift: ${fmt(amount, info)} = ${fmtShares(amount, info)}, expiry ${new Date(Number(expiry) * 1000).toISOString()}`);

  const gasPrice = await client.getGasPrice();
  check(gasPrice > 0n && gasPrice <= MAX_BUY_GAS_PRICE_WEI, `gas price ${gasPrice} wei is above the 3 gwei ceiling`);
  const send = async (tx: { to: Address; data: Hex }, cap: bigint, what: string) => {
    const hash = await deps.senderWallet.sendTransaction({
      account: deps.sender,
      chain: bsc,
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: await gasLimitFor(client, sender, tx, cap),
      gasPrice,
    });
    log(`${what} sent: ${txLink(hash)}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    check(receipt.status === "success", `${what} reverted on chain`);
    log(`${what} confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
    return { hash, receipt };
  };

  const approve = await send(buildApproveVaultTx({ token, amount, vault }), MAX_VAULT_APPROVE_GAS, "Vault approve");
  const created = await send(
    buildCreateGiftTx({ vault, token, amount, claimKeyAddress: claimKey.address, expiry, sealedNote, keyProof, nowSeconds }),
    MAX_CREATE_GIFT_GAS,
    "createGift",
  );
  const giftId = readGiftIdFromReceipt(created.receipt, vault);
  const opened = await readGift(client, vault, giftId);
  check(opened.state === "Open", `gift ${giftId} is ${opened.state}, expected Open`);
  check(opened.amount === amount, `gift ${giftId} holds ${opened.amount} raw, expected ${amount}`);
  check(getAddress(opened.claimKey) === claimKey.address, "the gift's stored claim key is not the one this run made");

  const link = buildLink(deps.origin, giftId, claimKey.privateKey);
  const hashAt = link.indexOf("#");
  check(hashAt > 0 && link.slice(hashAt + 1) === claimKey.privateKey.slice(2), "the gift link does not end in its claim key");
  const linkPath = deps.linkFile instanceof URL ? fileURLToPath(deps.linkFile) : deps.linkFile;
  mkdirSync(resolve(linkPath, ".."), { recursive: true });
  writeFileSync(linkPath, `${link}\n`, "utf8");
  log(`Gift link: ${link.slice(0, hashAt + 1)}<hidden> (the full link is only in ${linkPath})`);

  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  log(`Recipient: a brand-new wallet ${recipient}`);
  const signature = await signClaim(claimKey.privateKey, vault, CHAIN_ID, giftId, recipient);
  const relayer = createRelayer({
    account: deps.relayerAccount,
    client,
    walletClient: deps.relayerWallet,
    vault,
    store: deps.store,
    maxGasPriceWei: deps.maxGasPriceWei,
    dailyCapWei: deps.dailyCapWei,
    allowMemoryStore: deps.allowMemoryStore === true,
  });
  log(`Claim request country: ${deps.country} (a stated value for this run, not a lookup)`);
  const answer = await handleClaim(
    { client, vault, relayer, store: deps.store, sponsor: deps.sponsor },
    { giftId: giftId.toString(), recipient, signature, declaration: true },
    { country: deps.country },
  );
  if (!answer.body.ok) throw new ProveAssertionError(`the claim was refused: ${answer.body.error}`);
  const claimHash = answer.body.txHash;
  log(`Claim sent by the relayer: ${txLink(claimHash)}`);
  const claimReceipt = await client.waitForTransactionReceipt({ hash: claimHash, timeout: RECEIPT_TIMEOUT_MS });
  check(claimReceipt.status === "success", "the claim reverted on chain");
  check(await confirmClaim(client, vault, claimHash, giftId, recipient), "confirmClaim did not find this gift claimed to this recipient");
  // WHY (C12): once the claim is confirmed the key in the link is spent, and a spent key still
  // has no reason to sit on disk, so the only copy of the link is erased.
  rmSync(linkPath, { force: true });
  log(`Gift link file deleted now that the claim is confirmed: ${linkPath}`);

  const received = await balanceOf(token, recipient, client);
  const liabilityAfter = await readLiability();
  const after = await readGift(client, vault, giftId);
  const openedNote = await openNote(claimKey.privateKey, after.sealedNote);
  log(`Recipient holds: ${fmt(received, info)} = ${fmtShares(received, info)}`);
  log(`Vault liability for ${clean(info.symbol)}: raw ${liabilityAfter} (raw ${liabilityBefore} before this gift)`);
  log(`Opened note: ${clean(openedNote)}`);
  check(received === amount, `recipient holds ${received} raw, expected ${amount}`);
  check(after.state === "Claimed", `gift ${giftId} is ${after.state}, expected Claimed`);
  check(liabilityAfter === liabilityBefore, "the vault liability did not return to its level before this gift");
  check(openedNote === note, "the opened note is not the note this run sealed");

  const senderGasWei = await gasSpent(client, [approve.hash, created.hash]);
  const relayerGasWei = await gasSpent(client, [claimHash]);
  log(`Gift ${giftId}: claimed, confirmed and checked.`);
  log(`Links: vault ${addressLink(vault)}; recipient ${addressLink(recipient)}`);
  for (const hash of [approve.hash, created.hash, claimHash]) log(txLink(hash));
  return { giftId, recipient, amount, txHashes: { vaultApprove: approve.hash, createGift: created.hash, claim: claimHash }, senderGasWei, relayerGasWei };
}

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

async function main(): Promise<number> {
  const env = loadEnv();
  secrets.push(env.OC_API_KEY, env.OC_SECRET_KEY, env.DEPLOYER_PRIVATE_KEY, env.DEPLOYER_PRIVATE_KEY.slice(2), env.RELAYER_PRIVATE_KEY, env.RELAYER_PRIVATE_KEY.slice(2), env.BSC_RPC_URL);
  if (env.UPSTASH_REDIS_REST_TOKEN) secrets.push(env.UPSTASH_REDIS_REST_TOKEN);
  const client = useRpcUrl(env.BSC_RPC_URL);
  const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
  const relayerAccount = privateKeyToAccount(env.RELAYER_PRIVATE_KEY);
  const api = createWeb3Api({ apiKey: env.OC_API_KEY, secretKey: env.OC_SECRET_KEY, onCall: (c) => calls.push(c) });
  const origin = process.env.MOI_PUBLIC_ORIGIN || DEFAULT_ORIGIN;
  const country = process.env.MOI_PROVE_COUNTRY || DEFAULT_COUNTRY;
  const vault = env.MOI_VAULT_ADDRESS;

  say(`Moi prove, ${live ? "LIVE: will sign and send on BSC mainnet" : "DRY RUN: signs nothing"}`);
  say(`Sender (deployer): ${deployer.address}`);
  say(`Relayer: ${relayerAccount.address}, gas price ceiling ${env.MOI_RELAYER_MAX_GAS_PRICE_WEI} wei, daily cap ${formatUnits(env.MOI_RELAYER_DAILY_CAP_WEI, 18)} BNB, store ${env.UPSTASH_REDIS_REST_URL ? "Upstash (shared)" : "a single-process store in memory for this run"}`);
  say(`Claim request country: ${country} (a stated value for this run, not a lookup)`);

  const [usdt, stock] = await Promise.all([readTokenInfo(USDT, client), readTokenInfo(NVDAB, client)]);
  const amount = parseAmount(BUY_USDT, usdt.decimals);

  if (vault === undefined) {
    say("Vault: not deployed yet (MOI_VAULT_ADDRESS is not set), so there is no token list to read and nothing to gift into.");
  } else {
    const [listed, relayerOnChain] = await Promise.all([readListedTokens(client, vault), readRelayer(client, vault)]);
    say(`Vault: ${vault} (${addressLink(vault)}), relayer on chain ${relayerOnChain}`);
    say(`Vault listed tokens (${listed.length}):`);
    for (const t of listed) say(`  ${t} ${clean((await readTokenInfo(t, client)).symbol)}`);
  }

  if (!live) {
    const plan = await planBuy({ api, stock: NVDAB, usdtAmount: amount, wallet: deployer.address, client });
    for (const line of planLines(plan, stock, BUY_USDT)) say(line);
    say(`A live run buys ${BUY_USDT} USDT of ${clean(stock.symbol)}, gifts exactly what arrives, claims it through the relayer into a brand-new wallet, and checks every step on chain.`);
    say(`Spend per live run: ${BUY_USDT} USDT plus gas from the deployer and the relayer.`);
    say("Dry run complete. Nothing was signed or sent.");
    return 0;
  }

  if (vault === undefined) throw new ProveAssertionError("MOI_LIVE=1 needs MOI_VAULT_ADDRESS: deploy the vault first");
  const [listed, relayerOnChain, paused] = await Promise.all([
    readListedTokens(client, vault),
    readRelayer(client, vault),
    client.readContract({ address: vault, abi: giftVaultAbi, functionName: "paused" }),
  ]);
  check(listed.includes(getAddress(NVDAB)), "the vault does not list NVDAB");
  check(relayerOnChain === relayerAccount.address, "the vault's relayer is not RELAYER_PRIVATE_KEY's address");
  check(!paused, "the vault is paused");

  const transport = http(env.BSC_RPC_URL, { timeout: RPC_TIMEOUT_MS, retryCount: 0 });
  const senderWallet = createWalletClient({ account: deployer, chain: bsc, transport });
  const relayerWallet = createWalletClient({ account: relayerAccount, chain: bsc, transport });
  const store = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? createUpstashStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    : createMemoryStore();
  const shared = isSharedStore(store);
  if (!shared) say("Store: running with a single-process store (in memory, this run only) because Upstash is not configured. A server refuses this; one prove run is the only claimer here.");

  const buy = await executeBuy({ api, client, walletClient: senderWallet, account: deployer, stock: NVDAB, usdtAmount: amount, log: say });
  check(buy.received > 0n, "the buy delivered no NVDAB");
  for (const hash of buy.txHashes) say(txLink(hash));

  const result = await giftAndClaim(
    {
      client,
      vault,
      sender: deployer,
      senderWallet,
      relayerAccount,
      relayerWallet,
      store,
      allowMemoryStore: !shared,
      maxGasPriceWei: env.MOI_RELAYER_MAX_GAS_PRICE_WEI,
      dailyCapWei: env.MOI_RELAYER_DAILY_CAP_WEI,
      origin,
      country,
      linkFile: LINK_FILE,
      log: say,
      onSecret: (s) => secrets.push(s),
      sponsor: env.MOI_SPONSOR_ADDRESS ?? null,
    },
    NVDAB,
    buy.received,
  );
  const buyGas = await gasSpent(client, buy.txHashes);
  say(`Gas spent: deployer ${formatUnits(buyGas + result.senderGasWei, 18)} BNB (buy ${formatUnits(buyGas, 18)}, gift ${formatUnits(result.senderGasWei, 18)}); relayer ${formatUnits(result.relayerGasWei, 18)} BNB`);
  say("PROVED: bought, gifted and claimed into a brand-new wallet through the relayer.");
  return 0;
}

function describe(err: unknown): string {
  if (err instanceof ProveAssertionError) return `check failed: ${err.message}`;
  if (err instanceof BuyRefusedError || err instanceof Web3ApiError || err instanceof EnvError) return err.message;
  if (err instanceof Error) {
    const short = (err as Error & { shortMessage?: string }).shortMessage;
    return `${err.name}: ${short ?? err.message.split("\n")[0]}`;
  }
  return "unknown error";
}

// Runs only as a script, so prove.fork.test.ts can import giftAndClaim without starting a run.
const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
const isScript = invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isScript) {
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
}
