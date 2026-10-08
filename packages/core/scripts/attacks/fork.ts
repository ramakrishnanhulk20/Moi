// The chain the server attacks run against: an anvil fork of BSC mainnet at its latest block, with
// a freshly deployed GiftVault and fresh accounts funded from real holders on the fork only. No
// transaction here can reach mainnet: every write goes to the local anvil.
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
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TestClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { giftVaultAbi } from "../../src/generated/giftVaultAbi.js";
import { newClaimKey, sealNote, signKeyProof } from "../../src/gift.js";

export const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
export const TSLAB = getAddress("0x5b1910eaad6450e50f816082aa078c41f10c292f");
export const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
// United Stables, the first wrap asset (wrap.ts WRAP_ASSETS).
export const U = getAddress("0xce24439f2d9c6a2289f741120fe202248b666666");
export const COMPLIANCE = getAddress("0x53dba7aabde774787a1f57236b235567da8e14f4");
// Holds OPS_ROLE on the bStock Compliance contract (the fork tests check it with hasRole).
export const BLOCKLIST_OPS = getAddress("0xa4e4975433038361edc07d726022cb29a6aabc3e");
// Real holders, impersonated on the fork only to fund the fresh accounts: the Venus vNVDAB market
// and a contract holding about 3.5 million U.
const NVDAB_HOLDER = getAddress("0xeb8ca841cbe1bc4832a10b15c7dab1081edad371");
const U_HOLDER = getAddress("0x238a358808379702088667322f80ac48bad5e6c4");

const ANVIL = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
// Not the ports the fork tests use (8546, 8548), so a test run and an attack run never collide.
const PORT = 8552;
const RPC = `http://127.0.0.1:${PORT}`;
const ARTIFACT = new URL("../../../contracts/out/GiftVault.sol/GiftVault.json", import.meta.url);
const GAS_BNB = 10n ** 18n;
const RECEIPT_WAIT_MS = 120_000;

export const GIFT_AMOUNT = parseUnits("0.0005", 18);

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const complianceAbi = parseAbi([
  "function addToBlocklist(address token, address[] addresses)",
  "function removeFromBlocklist(address token, address[] addresses)",
]);

// WHY an archive node: a run lasts a few minutes and keeps touching fresh accounts, and a full node
// such as the public dataseed one drops a block's state about a minute after it, which fails
// anvil's lazy reads halfway through. Blast's public BSC endpoint keeps old state and needs no key
// (checked 2026-10-08: 60 reads of state 5,000 blocks old, none refused). The public NodeReal key in
// foundry.toml answered HTTP 429 the same day. MOI_ATTACK_FORK_URL names another archive node.
const DEFAULT_FORK_URL = "https://bsc-mainnet.public.blastapi.io";

function forkUrl(): string {
  const chosen = process.env.MOI_ATTACK_FORK_URL?.trim() || DEFAULT_FORK_URL;
  if (new URL(chosen).protocol !== "https:") throw new Error("MOI_ATTACK_FORK_URL must be an https URL.");
  return chosen;
}

export type Gift = { giftId: bigint; key: Hex; keyAddress: Address; createTx: Hex };

export type Fork = {
  rpc: string;
  client: PublicClient;
  test: TestClient;
  forkBlock: bigint;
  vault: Address;
  owner: PrivateKeyAccount;
  relayer: PrivateKeyAccount;
  relayerKey: Hex;
  sponsor: PrivateKeyAccount;
  payer: PrivateKeyAccount;
  /** Every claim key this run made, so the sweeps can prove none of them leaked. */
  secrets: string[];
  mined(hash: Hex): Promise<void>;
  makeGift(from: PrivateKeyAccount, opts?: { lifetimeSeconds?: bigint; note?: string; key?: Hex }): Promise<Gift>;
  latestTime(): Promise<bigint>;
  setTime(seconds: bigint): Promise<void>;
  setBlocked(who: Address, blocked: boolean): Promise<void>;
  stop(): Promise<void>;
};

async function waitForAnvil(proc: ChildProcess, output: () => string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`anvil exited early: ${output().slice(-500)}`);
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
  throw new Error(`anvil did not answer within ${deadlineMs} ms: ${output().slice(-500)}`);
}

/** Starts anvil on a fork of the latest BSC block, deploys a fresh vault and funds four fresh accounts. */
export async function startFork(): Promise<Fork> {
  // A leftover anvil on this port would answer the readiness check below in place of the new one,
  // and every transaction would go to the wrong chain.
  const leftover = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then(
    () => true,
    () => false,
  );
  if (leftover) throw new Error(`Something already answers on ${RPC}; stop that anvil first.`);
  let output = "";
  // WHY mixed mining: automine alone mines a block only when a transaction arrives, and viem's
  // waitForTransactionReceipt, which the claim page's own code uses, waits for the next block when
  // its first look comes a moment too early. A block every second means that next block always comes.
  const args = ["--fork-url", forkUrl(), "--port", String(PORT), "--block-time", "1", "--mixed-mining"];
  const proc = spawn(ANVIL, args, { stdio: ["ignore", "pipe", "pipe"] });
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  process.once("exit", () => proc.kill());
  const stop = async () => {
    if (proc.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  };

  try {
    await waitForAnvil(proc, () => output, 90_000);
    const transport = http(RPC, { timeout: 60_000 });
    const client = createPublicClient({ chain: bsc, transport, pollingInterval: 250 }) as PublicClient;
    const test = createTestClient({ chain: bsc, mode: "anvil", transport });
    if ((await client.getChainId()) !== 56) throw new Error("The fork does not report chain 56.");
    const forkBlock = await client.getBlockNumber();

    const relayerKey = generatePrivateKey();
    const [owner, relayer, sponsor, payer] = [generatePrivateKey(), relayerKey, generatePrivateKey(), generatePrivateKey()].map((k) => privateKeyToAccount(k)) as [
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
    ];
    for (const a of [owner, relayer, sponsor, payer]) await test.setBalance({ address: a.address, value: GAS_BNB });
    const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain: bsc, transport });
    const receiptOf = async (hash: Hex) => {
      const deadline = Date.now() + RECEIPT_WAIT_MS;
      for (;;) {
        try {
          return await client.getTransactionReceipt({ hash });
        } catch (err) {
          if (!(err instanceof TransactionReceiptNotFoundError) || Date.now() > deadline) throw err;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    const mined = async (hash: Hex) => {
      if ((await receiptOf(hash)).status !== "success") throw new Error(`fork transaction ${hash} reverted`);
    };
    const asImpersonated = async (who: Address, send: (w: ReturnType<typeof createWalletClient>) => Promise<Hex>) => {
      await test.impersonateAccount({ address: who });
      await test.setBalance({ address: who, value: GAS_BNB });
      try {
        await mined(await send(createWalletClient({ account: who, chain: bsc, transport })));
      } finally {
        await test.stopImpersonatingAccount({ address: who });
      }
    };

    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
    const deployHash = await wallet(owner).deployContract({ abi: giftVaultAbi, bytecode: artifact.bytecode.object, args: [owner.address, relayer.address, [NVDAB]] });
    const deployed = await receiptOf(deployHash);
    const vault = getAddress(deployed.contractAddress ?? "");

    for (const to of [sponsor.address, payer.address]) {
      await asImpersonated(NVDAB_HOLDER, (w) => w.writeContract({ account: NVDAB_HOLDER, chain: bsc, address: NVDAB, abi: erc20Abi, functionName: "transfer", args: [to, 20n * GIFT_AMOUNT] }));
    }
    await asImpersonated(U_HOLDER, (w) => w.writeContract({ account: U_HOLDER, chain: bsc, address: U, abi: erc20Abi, functionName: "transfer", args: [payer.address, parseUnits("1", 18)] }));

    const secrets: string[] = [relayerKey];
    const makeGift: Fork["makeGift"] = async (from, opts = {}) => {
      const claimKey = opts.key === undefined ? newClaimKey() : { privateKey: opts.key, address: privateKeyToAccount(opts.key).address };
      secrets.push(claimKey.privateKey);
      const w = wallet(from);
      await mined(await w.writeContract({ address: NVDAB, abi: erc20Abi, functionName: "approve", args: [vault, GIFT_AMOUNT] }));
      const note = await sealNote(claimKey.privateKey, opts.note ?? "");
      const proof = await signKeyProof(claimKey.privateKey, vault, 56, from.address);
      const expiry = (await client.getBlock({ blockTag: "latest" })).timestamp + (opts.lifetimeSeconds ?? 7n * 86_400n);
      const createTx = await w.writeContract({ address: vault, abi: giftVaultAbi, functionName: "createGift", args: [NVDAB, GIFT_AMOUNT, claimKey.address, expiry, note, proof] });
      const receipt = await receiptOf(createTx);
      const giftId = parseEventLogs({ abi: giftVaultAbi, logs: receipt.logs, eventName: "GiftCreated" })[0]?.args.giftId;
      if (receipt.status !== "success" || giftId === undefined) throw new Error("createGift on the fork made no gift");
      return { giftId, key: claimKey.privateKey, keyAddress: claimKey.address, createTx };
    };

    return {
      rpc: RPC,
      client,
      test,
      forkBlock,
      vault,
      owner,
      relayer,
      relayerKey,
      sponsor,
      payer,
      secrets,
      mined,
      makeGift,
      latestTime: async () => (await client.getBlock({ blockTag: "latest" })).timestamp,
      setTime: async (seconds) => {
        await test.setNextBlockTimestamp({ timestamp: seconds });
        await test.mine({ blocks: 1 });
      },
      setBlocked: async (who, blocked) => {
        await asImpersonated(BLOCKLIST_OPS, (w) =>
          w.writeContract({ account: BLOCKLIST_OPS, chain: bsc, address: COMPLIANCE, abi: complianceAbi, functionName: blocked ? "addToBlocklist" : "removeFromBlocklist", args: [NVDAB, [who]] }),
        );
      },
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
