// Runs only with MOI_FORK_TESTS=1. It forks BSC mainnet with anvil on port 8548, deploys GiftVault
// from packages/contracts/out, gives the sender real NVDAB from the Venus vNVDAB market instead of
// buying it, and runs prove.ts giftAndClaim: vault approval, createGift with a key proof the claim
// key signed for the sender (signKeyProof), the hidden link, a claim through handleClaim and the
// real relayer into a brand-new wallet, and every on-chain check.
// Not covered here: the buy itself (executeBuy needs the live Web3 API, which quotes and simulates
// against mainnet, not this fork; the live buy was proven on 2026-10-07), the Upstash store (an
// in-process store stands in), a live mempool, and real geolocation. The fork is a copy of mainnet
// at start-up, so it proves behaviour against real token code, not the deployed mainnet vault.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, parseAbi, parseUnits, type Hex, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { giftAndClaim } from "../scripts/prove.js";
import { balanceOf } from "../src/chain.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { createMemoryStore } from "../src/store.js";
import { readGift } from "../src/vault.js";

const ENABLED = process.env.MOI_FORK_TESTS === "1";
if (!ENABLED) {
  console.log("prove.fork.test.ts skipped: run MOI_FORK_TESTS=1 npx vitest run test/prove.fork.test.ts (needs anvil and network access).");
}

const ANVIL = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK_URL = "https://bsc-dataseed.bnbchain.org";
const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const ARTIFACT = new URL("../../contracts/out/GiftVault.sol/GiftVault.json", import.meta.url);
const LINK_FILE = fileURLToPath(new URL("../../../scratchpad/wo4b/fork-last-link.txt", import.meta.url));
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
// The Venus vNVDAB market holds NVDAB on mainnet; impersonated on the fork only.
const VNVDAB = getAddress("0xEb8Ca841cBe1BC4832A10b15c7dAB1081eDaD371");
// Anvil's own published development words. They control nothing outside a local anvil.
const ANVIL_WORDS = "test test test test test test test test test test test junk";

const erc20Abi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

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

describe.skipIf(!ENABLED)("prove flow on a BSC mainnet fork", () => {
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
    rmSync(LINK_FILE, { force: true });
  }, 15_000);

  it("gifts real NVDAB and claims it into a brand-new wallet through the relayer, never printing the key", async () => {
    const transport = http(RPC, { timeout: 60_000 });
    const client = createPublicClient({ chain: bsc, transport, pollingInterval: 250 }) as PublicClient;
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

    // Roughly what a 1 USDT buy delivered on 2026-10-07 (0.0042 NVDAB).
    const amount = parseUnits("0.0042", 18);
    await testClient.impersonateAccount({ address: VNVDAB });
    await testClient.setBalance({ address: VNVDAB, value: 10n ** 18n });
    const holderWallet = createWalletClient({ account: VNVDAB, chain: bsc, transport });
    await mined(await holderWallet.writeContract({ address: NVDAB, abi: erc20Abi, functionName: "transfer", args: [sender.address, amount] }));
    await testClient.stopImpersonatingAccount({ address: VNVDAB });
    expect(await balanceOf(NVDAB, sender.address, client)).toBe(amount);

    const lines: string[] = [];
    const secrets: string[] = [];
    const relayerNonceBefore = await client.getTransactionCount({ address: relayerAccount.address });
    const result = await giftAndClaim(
      {
        client,
        vault,
        sender,
        senderWallet: createWalletClient({ account: sender, chain: bsc, transport }),
        relayerAccount,
        relayerWallet: createWalletClient({ account: relayerAccount, chain: bsc, transport }),
        store: createMemoryStore(),
        allowMemoryStore: true,
        maxGasPriceWei: 3_000_000_000n,
        dailyCapWei: 2_000_000_000_000_000n,
        origin: "http://localhost:3000",
        country: "IN",
        linkFile: LINK_FILE,
        log: (line) => {
          lines.push(line);
          console.log(`prove: ${line}`);
        },
        onSecret: (s) => secrets.push(s),
        // The sender is the configured sponsor, as the deployer is in .env, so its unwrapped
        // gift passes the wrap gate (C24).
        sponsor: sender.address,
      },
      NVDAB,
      amount,
    );

    expect(result.amount).toBe(amount);
    expect(await balanceOf(NVDAB, result.recipient, client)).toBe(amount);
    expect(await balanceOf(NVDAB, sender.address, client)).toBe(0n);
    expect(await client.readContract({ address: vault, abi: giftVaultAbi, functionName: "liabilities", args: [NVDAB] })).toBe(0n);
    expect((await readGift(client, vault, result.giftId)).state).toBe("Claimed");
    expect(await client.getTransactionCount({ address: relayerAccount.address })).toBe(relayerNonceBefore + 1);
    expect(result.senderGasWei).toBeGreaterThan(0n);
    expect(result.relayerGasWei).toBeGreaterThan(0n);

    // C12: the full link lived only in the file, and the file is gone once the claim confirmed.
    // No printed line carries the key, with or without 0x.
    expect(existsSync(LINK_FILE)).toBe(false);
    const keyHex = secrets.find((s) => /^[0-9a-f]{64}$/.test(s));
    if (keyHex === undefined) throw new Error("giftAndClaim reported no claim key to redact");
    expect(secrets).toContain(`0x${keyHex}`);
    expect(lines.some((l) => l.includes(`/g/${result.giftId}#<hidden>`))).toBe(true);
    expect(lines.some((l) => l.startsWith("Gift link file deleted"))).toBe(true);
    expect(lines.filter((l) => l.toLowerCase().includes(keyHex))).toEqual([]);
    console.log(`fork: sender gas ${result.senderGasWei} wei, relayer gas ${result.relayerGasWei} wei`);
  }, 300_000);
});
