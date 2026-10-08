import { createPublicClient, defineChain, http } from "viem";
import { bsc as viemBsc } from "viem/chains";

// The BNB Chain team's own RPC, the one host the page CSP allows. viem's bsc defaults to a
// third-party RPC, and Privy hands rpcUrls.default to wallets that need to add the chain.
export const BSC_RPC = "https://bsc-dataseed.bnbchain.org";

export const bsc = defineChain({ ...viemBsc, rpcUrls: { default: { http: [BSC_RPC] } } });

export const publicClient = createPublicClient({ chain: bsc, transport: http(BSC_RPC) });

export const VAULT = "0x808EB6B3dC1ad50Ca114F5eA9d053BEAd958975C" as const;

// The only payee a wrap fee may go to (C24, C27): pinned here, never taken from a server reply.
export const WRAP_PAY_TO = "0x96E854aBDdc5C618ca843956d1303017b586aB75" as const;
