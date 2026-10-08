import type { ConnectedWallet } from "@privy-io/react-auth";
import { createWalletClient, custom, getAddress, type Address, type EIP1193Provider, type Hex } from "viem";
import type { WalletSigner } from "@moi/core/src/client/x402.js";
import { bsc } from "@/lib/chain";

/** What the wallet is doing for the step on screen. "sent" carries the transaction hash. */
export type WalletPhase = "in-wallet" | "confirming" | "sent";

/** A connected wallet that is on BNB Chain, with a provider fetched after any chain switch. */
export type SigningWallet = { address: Address; provider: EIP1193Provider };

/**
 * Gets a connected wallet ready to sign. A wallet on another chain is asked to switch to BNB Chain
 * first, and the provider is fetched after that, because Privy's own note says a switch does not
 * update providers that were fetched earlier. Throws when the wallet refuses to switch.
 */
export async function openWallet(wallet: ConnectedWallet): Promise<SigningWallet> {
  if (wallet.chainId !== "eip155:56") await wallet.switchChain(56);
  const provider = await wallet.getEthereumProvider();
  return { address: getAddress(wallet.address), provider: provider as EIP1193Provider };
}

/**
 * The connected wallet as core's browser flows use it: a viem wallet client over the wallet's own
 * provider, on BNB Chain. `onWallet` hears what the wallet is doing, so the call sheet can show
 * "Confirm in your wallet" before the wallet is asked and "Confirming on BNB Chain" after it
 * answers: a transaction reports "in-wallet" before and "sent" with its hash after, and a
 * signature reports "in-wallet" before and "confirming" after.
 */
export function walletSigner(wallet: SigningWallet, onWallet: (phase: WalletPhase, hash?: Hex) => void): WalletSigner {
  const client = createWalletClient({ account: wallet.address, chain: bsc, transport: custom(wallet.provider) });
  return {
    address: wallet.address,
    async sendTransaction(tx) {
      onWallet("in-wallet");
      const hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
      onWallet("sent", hash);
      return hash;
    },
    async signTypedData(typedData) {
      onWallet("in-wallet");
      const signature = await client.signTypedData(typedData as Parameters<typeof client.signTypedData>[0]);
      onWallet("confirming");
      return signature;
    },
    async signMessage(message) {
      onWallet("in-wallet");
      const signature = await client.signMessage({ message });
      onWallet("confirming");
      return signature;
    },
  };
}
