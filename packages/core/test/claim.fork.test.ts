// Runs only with MOI_FORK_TESTS=1 (npm run test:fork). It forks BSC mainnet with anvil, deploys
// GiftVault from packages/contracts/out, funds a sender with real NVDAB, and claims through the
// real handleClaim, relayer and gift crypto: once for a gift from the sponsor wallet, and once for
// a gift that pays its wrapping fee through handleWrap first.
// Not covered here: the Upstash store (an in-process store stands in), a live mempool or a busy
// relayer queue (anvil mines each transaction at once), real geolocation, and the claim page.
// b402 is a fake answering verify and settle. Its settle moves the wrapping fee itself with a plain
// U transfer from the payer, so handleWrap reads a real Transfer receipt, but the buyer's signed
// authorization is never checked on chain here; the real facilitator is proven by the sender
// agent's paid run. The fork is a copy of mainnet at start-up,
// so it proves behaviour against real token code, not that the deployed mainnet vault behaves the
// same.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balanceOf } from "../src/chain.js";
import { handleClaim } from "../src/claim.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { newClaimKey, openNote, sealNote, signClaim, signKeyProof } from "../src/gift.js";
import { confirmClaim, createRelayer } from "../src/relayer.js";
import { createMemoryStore } from "../src/store.js";
import { readGift } from "../src/vault.js";
import type { Web3Api } from "../src/web3api.js";
import { handleWrap, isWrapped, type PaymentRequirementsV2 } from "../src/wrap.js";

const ENABLED = process.env.MOI_FORK_TESTS === "1";
if (!ENABLED) {
  console.log("claim.fork.test.ts skipped: run MOI_FORK_TESTS=1 npm run test:fork (needs anvil and network access).");
}

const ANVIL = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK_URL = "https://bsc-dataseed.bnbchain.org";
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const ARTIFACT = new URL("../../contracts/out/GiftVault.sol/GiftVault.json", import.meta.url);
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
// Holds NVDAB on mainnet; impersonated on the fork only, to give the test sender a little.
const NVDAB_HOLDER = getAddress("0xEb8Ca841cBe1BC4832A10b15c7dAB1081eDaD371");
// Anvil's own published development words. They control nothing outside a local anvil.
const ANVIL_WORDS = "test test test test test test test test test test test junk";
// Ram's payout wallet (DECISIONS.md). On the fork the fake settle pays it the wrap price in U.
const PAYOUT = getAddress("0x96E854aBDdc5C618ca843956d1303017b586aB75");
// United Stables, the first wrap asset (WRAP_ASSETS), and a contract holding about 3.5 million U
// at block 126282597; impersonated on the fork only, to give the payer the wrap price.
const U = getAddress("0xcE24439F2D9C6a2289F741120FE202248B666666");
const U_HOLDER = getAddress("0x238a358808379702088667322f80ac48bad5e6c4");
// The U eip3009 kind from the live /supported answer of 2026-10-07.
const U_EIP3009_KIND = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:56",
  extra: { name: "United Stables", version: "1", assetTransferMethod: "eip3009", signerAddress: "0x34F7a661160780Ce1346e6D7B96D2bE244590899" },
};

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

let anvil: ChildProcess | null = null;
let anvilOutput = "";

async function waitForAnvil(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (anvil?.exitCode !== null) throw new Error(`anvil exited early: ${anvilOutput.slice(-500)}`);
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`anvil did not answer within ${deadlineMs} ms: ${anvilOutput.slice(-500)}`);
}

async function stopAnvil(): Promise<void> {
  const proc = anvil;
  anvil = null;
  if (proc === null || proc.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
}

describe.skipIf(!ENABLED)("claim on a BSC mainnet fork", () => {
  beforeAll(async () => {
    anvil = spawn(ANVIL, ["--fork-url", FORK_URL, "--port", String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk: Buffer) => {
      anvilOutput = (anvilOutput + chunk.toString("utf8")).slice(-4_000);
    };
    anvil.stdout?.on("data", keep);
    anvil.stderr?.on("data", keep);
    process.once("exit", () => anvil?.kill());
    await waitForAnvil(90_000);
  }, 120_000);

  afterAll(async () => {
    await stopAnvil();
  }, 15_000);

  it("claims a real NVDAB gift once through handleClaim and the relayer", async () => {
    const transport = http(RPC, { timeout: 60_000 });
    const client = createPublicClient({ chain: bsc, transport }) as PublicClient;
    const testClient = createTestClient({ chain: bsc, mode: "anvil", transport });
    expect(await client.getChainId()).toBe(56);

    const owner = mnemonicToAccount(ANVIL_WORDS, { addressIndex: 0 });
    const relayerAccount = mnemonicToAccount(ANVIL_WORDS, { addressIndex: 1 });
    const sender = mnemonicToAccount(ANVIL_WORDS, { addressIndex: 2 });
    const mined = async (hash: Hex) => {
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      return receipt;
    };

    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
    const ownerWallet = createWalletClient({ account: owner, chain: bsc, transport });
    const deployed = await mined(
      await ownerWallet.deployContract({ abi: giftVaultAbi, bytecode: artifact.bytecode.object, args: [owner.address, relayerAccount.address, [NVDAB]] }),
    );
    const vault = getAddress(deployed.contractAddress ?? "");

    const decimals = await client.readContract({ address: NVDAB, abi: erc20Abi, functionName: "decimals" });
    const amount = parseUnits("0.001", decimals);
    await testClient.impersonateAccount({ address: NVDAB_HOLDER });
    await testClient.setBalance({ address: NVDAB_HOLDER, value: 10n ** 18n });
    const holderWallet = createWalletClient({ account: NVDAB_HOLDER, chain: bsc, transport });
    await mined(await holderWallet.writeContract({ address: NVDAB, abi: erc20Abi, functionName: "transfer", args: [sender.address, amount] }));
    await testClient.stopImpersonatingAccount({ address: NVDAB_HOLDER });

    const senderWallet = createWalletClient({ account: sender, chain: bsc, transport });
    await mined(await senderWallet.writeContract({ address: NVDAB, abi: erc20Abi, functionName: "approve", args: [vault, amount] }));
    const claimKey = newClaimKey();
    const sealedNote = await sealNote(claimKey.privateKey, "Happy Diwali");
    const keyProof = await signKeyProof(claimKey.privateKey, vault, 56, sender.address);
    const expiry = (await client.getBlock()).timestamp + 7n * 86_400n;
    const created = await mined(
      await senderWallet.writeContract({ address: vault, abi: giftVaultAbi, functionName: "createGift", args: [NVDAB, amount, claimKey.address, expiry, sealedNote, keyProof] }),
    );
    const giftId = parseEventLogs({ abi: giftVaultAbi, logs: created.logs, eventName: "GiftCreated" })[0]?.args.giftId;
    if (giftId === undefined) throw new Error("createGift emitted no GiftCreated event");
    const gift = await readGift(client, vault, giftId);
    expect(gift.state).toBe("Open");
    console.log(`fork: vault ${vault}, gift ${giftId} holds ${gift.amount} raw NVDAB, createGift gas used ${created.gasUsed}`);

    const store = createMemoryStore();
    const relayer = createRelayer({
      account: relayerAccount,
      client,
      walletClient: createWalletClient({ account: relayerAccount, chain: bsc, transport }),
      vault,
      store,
      maxGasPriceWei: 3_000_000_000n,
      dailyCapWei: 10n ** 16n,
      allowMemoryStore: true,
    });
    // The sender is the configured sponsor, so this unwrapped gift passes the wrap gate (C24).
    const deps = { client, vault, relayer, store, sponsor: sender.address };
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const nonceBefore = await client.getTransactionCount({ address: relayerAccount.address });

    // A real node's revert must reach the same refusal the unit tests prove: wrong key, nothing sent.
    const wrongKey = newClaimKey();
    const forged = await signClaim(wrongKey.privateKey, vault, 56, giftId, recipient);
    const refused = await handleClaim(deps, { giftId: giftId.toString(), recipient, signature: forged, declaration: true }, { country: "IN" });
    expect(refused).toEqual({ status: 400, body: { ok: false, error: "bad_signature" } });
    expect(await client.getTransactionCount({ address: relayerAccount.address })).toBe(nonceBefore);

    const signature = await signClaim(claimKey.privateKey, vault, 56, giftId, recipient);
    const body = { giftId: giftId.toString(), recipient, signature, declaration: true };
    const first = await handleClaim(deps, body, { country: "IN" });
    expect(first.status).toBe(200);
    if (!first.body.ok) throw new Error(`claim refused: ${first.body.error}`);
    expect(first.body.reused).toBe(false);
    const txHash = first.body.txHash;
    const claimed = await mined(txHash);
    console.log(`fork: claim ${txHash} gas used ${claimed.gasUsed} at ${claimed.effectiveGasPrice} wei per gas`);

    expect(await confirmClaim(client, vault, txHash, giftId, recipient)).toBe(true);
    expect(await balanceOf(NVDAB, recipient, client)).toBe(gift.amount);
    expect(await client.readContract({ address: vault, abi: giftVaultAbi, functionName: "liabilities", args: [NVDAB] })).toBe(0n);
    const after = await readGift(client, vault, giftId);
    expect(after.state).toBe("Claimed");
    expect(await openNote(claimKey.privateKey, after.sealedNote)).toBe("Happy Diwali");

    const blockAfterClaim = await client.getBlockNumber({ cacheTime: 0 });
    const second = await handleClaim(deps, body, { country: "IN" });
    expect(second).toEqual({ status: 200, body: { ok: true, txHash, reused: true } });
    expect(await client.getTransactionCount({ address: relayerAccount.address })).toBe(nonceBefore + 1);
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(blockAfterClaim);
  }, 300_000);

  it("refuses an unwrapped gift from a non-sponsor, wraps it through handleWrap, then claims it", async () => {
    const transport = http(RPC, { timeout: 60_000 });
    const client = createPublicClient({ chain: bsc, transport }) as PublicClient;
    const testClient = createTestClient({ chain: bsc, mode: "anvil", transport });
    const owner = mnemonicToAccount(ANVIL_WORDS, { addressIndex: 0 });
    const relayerAccount = mnemonicToAccount(ANVIL_WORDS, { addressIndex: 1 });
    const sponsor = mnemonicToAccount(ANVIL_WORDS, { addressIndex: 2 });
    const sender = mnemonicToAccount(ANVIL_WORDS, { addressIndex: 3 });
    const mined = async (hash: Hex) => {
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      return receipt;
    };

    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
    const ownerWallet = createWalletClient({ account: owner, chain: bsc, transport });
    const deployed = await mined(
      await ownerWallet.deployContract({ abi: giftVaultAbi, bytecode: artifact.bytecode.object, args: [owner.address, relayerAccount.address, [NVDAB]] }),
    );
    const vault = getAddress(deployed.contractAddress ?? "");
    const amount = parseUnits("0.001", await client.readContract({ address: NVDAB, abi: erc20Abi, functionName: "decimals" }));
    await testClient.impersonateAccount({ address: NVDAB_HOLDER });
    await testClient.setBalance({ address: NVDAB_HOLDER, value: 10n ** 18n });
    const holderWallet = createWalletClient({ account: NVDAB_HOLDER, chain: bsc, transport });
    await mined(await holderWallet.writeContract({ address: NVDAB, abi: erc20Abi, functionName: "transfer", args: [sender.address, amount] }));
    await testClient.stopImpersonatingAccount({ address: NVDAB_HOLDER });
    const wrapPrice = parseUnits("0.05", 18);
    await testClient.impersonateAccount({ address: U_HOLDER });
    await testClient.setBalance({ address: U_HOLDER, value: 10n ** 18n });
    const uHolderWallet = createWalletClient({ account: U_HOLDER, chain: bsc, transport });
    await mined(await uHolderWallet.writeContract({ address: U, abi: erc20Abi, functionName: "transfer", args: [sender.address, wrapPrice] }));
    await testClient.stopImpersonatingAccount({ address: U_HOLDER });

    const senderWallet = createWalletClient({ account: sender, chain: bsc, transport });
    await mined(await senderWallet.writeContract({ address: NVDAB, abi: erc20Abi, functionName: "approve", args: [vault, amount] }));
    const claimKey = newClaimKey();
    const keyProof = await signKeyProof(claimKey.privateKey, vault, 56, sender.address);
    const expiry = (await client.getBlock()).timestamp + 7n * 86_400n;
    const created = await mined(
      await senderWallet.writeContract({ address: vault, abi: giftVaultAbi, functionName: "createGift", args: [NVDAB, amount, claimKey.address, expiry, "0x", keyProof] }),
    );
    const giftId = parseEventLogs({ abi: giftVaultAbi, logs: created.logs, eventName: "GiftCreated" })[0]?.args.giftId;
    if (giftId === undefined) throw new Error("createGift emitted no GiftCreated event");

    const store = createMemoryStore();
    const relayer = createRelayer({
      account: relayerAccount,
      client,
      walletClient: createWalletClient({ account: relayerAccount, chain: bsc, transport }),
      vault,
      store,
      maxGasPriceWei: 3_000_000_000n,
      dailyCapWei: 10n ** 16n,
      allowMemoryStore: true,
    });
    const claimDeps = { client, vault, relayer, store, sponsor: sponsor.address };
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const body = { giftId: giftId.toString(), recipient, signature: await signClaim(claimKey.privateKey, vault, 56, giftId, recipient), declaration: true };
    const nonceBefore = await client.getTransactionCount({ address: relayerAccount.address });
    expect(await handleClaim(claimDeps, body, { country: "IN" })).toEqual({ status: 402, body: { ok: false, error: "gift_not_wrapped" } });
    expect(await client.getTransactionCount({ address: relayerAccount.address })).toBe(nonceBefore);

    // b402 stands in as a fake: the gift, its state and its expiry come from the fork.
    let settleTx: Hex | null = null;
    const b402Calls: string[] = [];
    const api: Web3Api = {
      get: async () => {
        throw new Error("no GET in wrap");
      },
      post: async (path, body) => {
        b402Calls.push(path);
        if (path === "/api/v2/b402/supported") return { kinds: [U_EIP3009_KIND] };
        if (path === "/api/v2/b402/verify") return { isValid: true, payer: sender.address };
        if (path === "/api/v2/b402/settle") {
          // What b402 does on settle, minus the signature: the payer moves exactly the amount the
          // server asked for, in its asset, to its payee, so handleWrap's receipt check (C42)
          // reads a real Transfer from the fork.
          const asked = (body as { body: { paymentRequirements: PaymentRequirementsV2 } }).body.paymentRequirements;
          const moved = await mined(await senderWallet.writeContract({ address: asked.asset, abi: erc20Abi, functionName: "transfer", args: [asked.payTo, BigInt(asked.amount)] }));
          settleTx = moved.transactionHash;
          return { success: true, transaction: settleTx, payer: sender.address, network: "eip155:56", amount: asked.amount };
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const payoutBefore = await balanceOf(U, PAYOUT, client);
    const wrapDeps = { api, client, vault, store, origin: "http://localhost:3000", payTo: PAYOUT, priceUsd: "0.05" };
    const challenge = await handleWrap(wrapDeps, giftId.toString(), null);
    expect(challenge.status).toBe(402);
    const offer = challenge.body as { resource: unknown; accepts: PaymentRequirementsV2[] };
    const requirement = offer.accepts[0];
    if (requirement === undefined) throw new Error("the 402 offered no requirement");
    const payment = {
      x402Version: 2,
      resource: offer.resource,
      accepted: requirement,
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: sender.address,
          to: requirement.payTo,
          value: requirement.amount,
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 120),
          nonce: `0x${"0c".repeat(32)}`,
        },
      },
    };
    const paid = await handleWrap(wrapDeps, giftId.toString(), Buffer.from(JSON.stringify(payment), "utf8").toString("base64"));
    expect(settleTx).not.toBeNull();
    expect(paid).toMatchObject({ status: 200, body: { ok: true, wrapped: true, txHash: settleTx } });
    expect(await isWrapped(store, vault, giftId)).toBe(true);
    expect((await balanceOf(U, PAYOUT, client)) - payoutBefore).toBe(wrapPrice);
    expect(b402Calls).toEqual(["/api/v2/b402/supported", "/api/v2/b402/verify", "/api/v2/b402/settle"]);

    const claimed = await handleClaim(claimDeps, body, { country: "IN" });
    expect(claimed.status).toBe(200);
    if (!claimed.body.ok) throw new Error(`claim refused: ${claimed.body.error}`);
    const receipt = await mined(claimed.body.txHash);
    console.log(`fork: wrapped gift ${giftId} claimed in ${claimed.body.txHash}, gas used ${receipt.gasUsed}`);
    expect(await confirmClaim(client, vault, claimed.body.txHash, giftId, recipient)).toBe(true);
    expect(await balanceOf(NVDAB, recipient, client)).toBe(amount);
  }, 300_000);
});
