import { callMoi } from "@moi/core/src/client/send.js";
import { giftVaultAbi } from "@moi/core/src/generated/giftVaultAbi.js";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { publicClient, VAULT } from "@/lib/chain";
import type { WalletSigner } from "@moi/core/src/client/x402.js";

export const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";

export type Balances = { usdt: bigint; usdtDecimals: number; bnb: bigint };

/** USDT and BNB held by `address`, read from BNB Chain. USDT's decimals come from the token itself. */
export async function readBalances(address: Address): Promise<Balances> {
  const [usdt, usdtDecimals, bnb] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "decimals" }),
    publicClient.getBalance({ address }),
  ]);
  return { usdt, usdtDecimals, bnb };
}

/** The latest block's time in Unix seconds. */
export async function readChainTime(): Promise<number> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

export type GiftStatus = { state: "Open" | "Claimed" | "Refunded"; expiry: number; symbol: string };

/** One gift as Moi's server reads it from the vault, or null when the answer is missing or not what was expected. */
export async function readGiftStatus(giftId: string): Promise<GiftStatus | null> {
  try {
    const reply = await callMoi({ fetch: window.fetch.bind(window), origin: window.location.origin }, "GET", `/api/gift/${giftId}`);
    if (reply.status !== 200 || typeof reply.body !== "object" || reply.body === null) return null;
    const { state, expiry, symbol } = reply.body as Record<string, unknown>;
    if (state !== "Open" && state !== "Claimed" && state !== "Refunded") return null;
    const expirySeconds = typeof expiry === "string" && /^[0-9]{1,12}$/.test(expiry) ? Number(expiry) : Number.NaN;
    if (!Number.isFinite(expirySeconds)) return null;
    return { state, expiry: expirySeconds, symbol: typeof symbol === "string" ? symbol.slice(0, 16) : "" };
  } catch {
    return null;
  }
}

/** True when the wallet's refusal sits anywhere in the error's chain of causes. */
export function wasDeclined(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; depth < 8 && typeof node === "object" && node !== null; depth += 1) {
    const { code, name } = node as { code?: unknown; name?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Takes an expired gift back: the vault's refund(giftId), sent from the sender's wallet, then a
 * wait for the receipt. Throws when the wallet declines, the send fails or the transaction fails.
 */
export async function refundGift(signer: WalletSigner, giftId: string): Promise<Hex> {
  const data = encodeFunctionData({ abi: giftVaultAbi, functionName: "refund", args: [BigInt(giftId)] });
  const hash = await signer.sendTransaction({ to: VAULT, data, value: 0n, chainId: 56 });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("The refund transaction failed on chain.");
  return hash;
}
