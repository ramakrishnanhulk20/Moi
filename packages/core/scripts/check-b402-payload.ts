// npm run check:b402               builds the wrap payment the website builds, for USDT through Permit2,
//                                  and asks b402 verify about it. Sends nothing on chain.
// MOI_LIVE=1 npm run check:b402    also sends the one Permit2 approval of exactly the fee when the
//                                  deployer lacks it (gas only, no USDT moves).
// Never calls b402 settle, so no fee is ever taken. Signs with DEPLOYER_PRIVATE_KEY from the
// repo-root .env, pays the configured MOI_PAYOUT_ADDRESS, and prints no key.
import { createWalletClient, erc20Abi, formatUnits, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { balanceOf, CHAIN_ID, RPC_TIMEOUT_MS, USDT, useRpcUrl } from "../src/chain.js";
import { buildPayment, PaymentRequestError, PERMIT2_ADDRESS, permit2ApprovalTx, pickRequirement, WRAP_FEE_CEILING_USD, type WalletSigner } from "../src/client/x402.js";
import { EnvError, loadEnv } from "../src/env.js";
import { gasLimitFor } from "../src/gas.js";
import { createWeb3Api, Web3ApiError, type Web3Api } from "../src/web3api.js";
import { buildPaymentRequirements, WRAP_ASSETS, wrapResource, type PaymentRequirementsV2 } from "../src/wrap.js";

const live = process.env.MOI_LIVE === "1";
// Requirements do not name a gift; only the resource URL does, and verify never reads the gift.
const GIFT_ID = 1n;
const LOCAL_ORIGIN = "http://localhost:3000";
const MAX_APPROVE_GAS = 100_000n;
// 3 gwei, the relayer's default ceiling. BSC runs near 0.05 gwei, so this only stops a lying node.
const MAX_GAS_PRICE_WEI = 3_000_000_000n;
const RECEIPT_TIMEOUT_MS = 90_000;
const secrets: string[] = [];

function say(line = ""): void {
  let out = line;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  console.log(out);
}

// The only b402 calls this script may make. Settle is refused here, before any network call, so
// no edit further down can take the fee by accident.
function verifyOnly(api: Web3Api): Web3Api {
  return {
    get: () => Promise.reject(new Error("check:b402 makes no GET calls")),
    post: (path, body) => {
      if (path !== "/api/v2/b402/supported" && path !== "/api/v2/b402/verify") {
        return Promise.reject(new Error(`check:b402 refuses ${path}: only /supported and /verify are allowed`));
      }
      return api.post(path, body);
    },
  };
}

type VerifyAnswer = { isValid?: unknown; invalidReason?: unknown; invalidMessage?: unknown; payer?: unknown };

async function verify(api: Web3Api, header: string, requirement: PaymentRequirementsV2): Promise<VerifyAnswer> {
  // Decoded from the very header the website would send, so verify judges exactly those bytes.
  const paymentPayload: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const answer = await api.post("/api/v2/b402/verify", { body: { x402Version: 2, paymentPayload, paymentRequirements: requirement } });
  return (answer ?? {}) as VerifyAnswer;
}

function report(label: string, answer: VerifyAnswer): void {
  say(`${label}: isValid ${String(answer.isValid)}`);
  if (answer.invalidReason !== undefined && answer.invalidReason !== null) say(`  invalidReason: ${String(answer.invalidReason).slice(0, 120)}`);
  if (typeof answer.invalidMessage === "string") say(`  invalidMessage: ${answer.invalidMessage.slice(0, 300)}`);
  if (typeof answer.payer === "string") say(`  payer b402 recovered: ${answer.payer.slice(0, 42)}`);
}

async function approvePermit2(client: PublicClient, signer: WalletSigner, approval: { token: Address; spender: Address; amount: bigint }): Promise<void> {
  const tx = permit2ApprovalTx(approval);
  say(`Sending approve(Permit2, ${approval.amount}) on ${tx.to}: exactly the fee, never unlimited.`);
  const hash = await signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n, chainId: CHAIN_ID });
  say(`  sent: https://bscscan.com/tx/${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new Error(`the Permit2 approval ${hash} reverted`);
  say(`  mined in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
}

async function main(): Promise<number> {
  const env = loadEnv();
  secrets.push(env.OC_API_KEY, env.OC_SECRET_KEY, env.DEPLOYER_PRIVATE_KEY, env.DEPLOYER_PRIVATE_KEY.slice(2), env.RELAYER_PRIVATE_KEY, env.RELAYER_PRIVATE_KEY.slice(2), env.BSC_RPC_URL);
  if (env.MOI_PAYOUT_ADDRESS === undefined) throw new EnvError(["MOI_PAYOUT_ADDRESS"]);
  const payTo = env.MOI_PAYOUT_ADDRESS;
  const origin = env.MOI_PUBLIC_ORIGIN ?? LOCAL_ORIGIN;
  const client = useRpcUrl(env.BSC_RPC_URL);
  const api = verifyOnly(createWeb3Api({ apiKey: env.OC_API_KEY, secretKey: env.OC_SECRET_KEY, timeoutMs: 25_000 }));
  const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain: bsc, transport: http(env.BSC_RPC_URL, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) });

  // The same shape the website's wallet glue has, so buildPayment runs exactly as in the browser.
  const signer: WalletSigner = {
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData),
    signMessage: (message) => account.signMessage({ message }),
    sendTransaction: async (tx) => {
      if (!live) throw new Error("a dry run sends nothing; set MOI_LIVE=1");
      const gas = await gasLimitFor(client, account.address, tx, MAX_APPROVE_GAS);
      const gasPrice = await client.getGasPrice();
      if (gasPrice > MAX_GAS_PRICE_WEI) throw new Error(`gas price ${gasPrice} is above the ${MAX_GAS_PRICE_WEI} wei ceiling`);
      return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas, gasPrice });
    },
  };

  say(`b402 payload check, ${live ? "LIVE: may send one Permit2 approval (gas only)" : "DRY RUN: sends nothing on chain"}. Never calls settle.`);
  say(`Payer (deployer): ${account.address}`);
  say(`Payee (MOI_PAYOUT_ADDRESS): ${payTo}`);
  const resourceUrl = wrapResource(origin, GIFT_ID).url;
  say(`Resource: ${resourceUrl}`);

  const requirements = await buildPaymentRequirements({ api, origin, payTo, priceUsd: env.MOI_WRAP_PRICE_USD }, GIFT_ID);
  say(`wrap.ts built ${requirements.length} requirement(s) from the live /supported: ${requirements.map((r) => `${WRAP_ASSETS.find((a) => a.address === r.asset)?.symbol}/${String(r.extra.assetTransferMethod)}`).join(", ")}`);
  const usdtAsset = WRAP_ASSETS.find((a) => a.symbol === "USDT")!;
  const usdtOffer = requirements.filter((r) => r.asset === usdtAsset.address && r.extra.assetTransferMethod === "permit2-exact");
  const usdt = pickRequirement(usdtOffer, { payTo, maxUsd: WRAP_FEE_CEILING_USD, assets: WRAP_ASSETS, prefer: "eip3009-first" });
  if (usdt === null) throw new Error("no USDT permit2-exact requirement passed pickRequirement");
  say(`Picked: USDT permit2-exact, amount ${usdt.amount} (${formatUnits(BigInt(usdt.amount), usdtAsset.decimals)} USDT), spender ${String(usdt.extra.spenderAddress)}`);

  const [bnb, usdtHeld, allowance] = await Promise.all([
    client.getBalance({ address: account.address }),
    balanceOf(USDT, account.address, client),
    client.readContract({ address: usdtAsset.address, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] }),
  ]);
  say(`Deployer holds ${formatUnits(bnb, 18)} BNB and ${formatUnits(usdtHeld, usdtAsset.decimals)} USDT; USDT allowance to Permit2: ${allowance}`);

  const deps = { signer, publicClient: client };
  let built = await buildPayment(deps, usdt, resourceUrl);
  if (built.needsPermit2Approval !== null) {
    say(`buildPayment asks for a Permit2 approval of exactly ${built.needsPermit2Approval.amount} first, and signed nothing.`);
    if (!live) {
      say("Dry run: rerun with MOI_LIVE=1 to send that approval, then the payment is signed and verified.");
      return 1;
    }
    await approvePermit2(client, signer, built.needsPermit2Approval);
    built = await buildPayment(deps, usdt, resourceUrl);
    if (built.needsPermit2Approval !== null) throw new Error("the allowance is still short after the approval was mined");
  }
  say(`Signed a browser-built USDT payment: header of ${built.headerValue.length} base64 characters.`);
  const usdtAnswer = await verify(api, built.headerValue, usdt);
  report("b402 verify, USDT permit2-exact", usdtAnswer);

  // Informational only: the deployer holds no U or USD1, so b402 is expected to refuse on balance.
  // The reason it gives still shows whether it got as far as checking the signature.
  for (const symbol of ["U", "USD1"]) {
    const a = WRAP_ASSETS.find((w) => w.symbol === symbol)!;
    const offer = requirements.filter((r) => r.asset === a.address && r.extra.assetTransferMethod === "eip3009");
    const req = pickRequirement(offer, { payTo, maxUsd: WRAP_FEE_CEILING_USD, assets: WRAP_ASSETS, prefer: "eip3009-first" });
    if (req === null) {
      say(`${symbol} eip3009: not offered by /supported today, skipped.`);
      continue;
    }
    const held = await balanceOf(a.address, account.address, client);
    const eip3009 = await buildPayment(deps, req, resourceUrl);
    report(`b402 verify, ${symbol} eip3009 (deployer holds ${formatUnits(held, a.decimals)} ${symbol})`, await verify(api, eip3009.headerValue, req));
  }
  return usdtAnswer.isValid === true ? 0 : 1;
}

function describe(err: unknown): string {
  if (err instanceof EnvError || err instanceof Web3ApiError || err instanceof PaymentRequestError) return err.message;
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
  say(`STOPPED: ${describe(err)}`);
}
process.exitCode = exitCode;
