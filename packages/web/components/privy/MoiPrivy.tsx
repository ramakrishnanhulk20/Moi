"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { Component, createContext, useContext, useMemo, type ReactNode } from "react";
import { bsc } from "@/lib/chain";

// Privy throws on any app id that is not exactly this long, and the throw would take the whole page down.
const APP_ID_LENGTH = 25;

const SignInUnavailable = createContext(false);

/** False when the page was built without a usable Privy app id, so the page can say so instead of crashing. */
export function useSignInAvailable(): boolean {
  return !useContext(SignInUnavailable);
}

const config = (nonce: string | undefined): PrivyClientConfig => ({
  loginMethods: ["google", "email"],
  embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
  defaultChain: bsc,
  supportedChains: [bsc],
  appearance: {
    theme: "#1A1012",
    accentColor: "#F2B13D",
    logo: "/v-mark.svg",
    landingHeader: "Sign in to open your gift",
    loginMessage: "Moi makes a wallet for you. No seed phrase, no fees.",
    walletChainType: "ethereum-only",
  },
  scriptNonce: nonce,
});

/**
 * A browser that blocks site data makes Privy throw as it starts (localStorage raises SecurityError),
 * which would take the whole page down. The page then carries on without sign-in instead, and says so.
 */
class PrivyFailSafe extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Privy's sign-in, mounted only around the parts of the site that need it. It is not in the root
 * layout on purpose: the claim page must take the claim key out of the address bar before this
 * loads, because Privy sends the page address to its server when Google sign-in starts (C12).
 * `nonce` is the response's script nonce from proxy.ts.
 */
export function MoiPrivy({ nonce, children }: { nonce: string | undefined; children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
  const settings = useMemo(() => config(nonce), [nonce]);
  if (appId.length !== APP_ID_LENGTH) {
    return <SignInUnavailable.Provider value={true}>{children}</SignInUnavailable.Provider>;
  }
  return (
    <PrivyFailSafe fallback={<SignInUnavailable.Provider value={true}>{children}</SignInUnavailable.Provider>}>
      <SignInUnavailable.Provider value={false}>
        <PrivyProvider appId={appId} config={settings}>
          {children}
        </PrivyProvider>
      </SignInUnavailable.Provider>
    </PrivyFailSafe>
  );
}
