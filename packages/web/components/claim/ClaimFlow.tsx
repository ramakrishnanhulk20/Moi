"use client";

import { getEmbeddedConnectedWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { claimGift, ClaimFlowError, loadGift, type GiftView } from "@moi/core/src/client/claim.js";
import { useSignInAvailable } from "@/components/privy/MoiPrivy";
import { publicClient, VAULT } from "@/lib/chain";
import { useStocks } from "@/lib/stocks";
import { ClaimView, type SignInView, type View } from "./ClaimView";
import { forgetClaimKey, type ClaimKeyResult } from "./claimKey";
import { previewScenario, type PreviewScenario } from "./preview";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; gift: GiftView; note: string | null; expired: boolean }
  | { status: "invalid" }
  | { status: "failed"; error: unknown };

type ClaimState =
  | { status: "idle" }
  | { status: "opening" }
  | { status: "opened"; txHash: Hex; address: Address }
  | { status: "failed"; error: unknown; started: boolean };

// These answers from loadGift mean the link itself is no good, so the page says so instead of showing an error.
const LINK_CODES = new Set(["link_damaged", "link_invalid", "not_found"]);
// For these, trying the same step again can work.
const RETRY_CODES = new Set(["server_unreachable", "chain_unavailable", "unconfirmed", "declined"]);
// Once the claim was sent, a failure leaves the envelope half open. These codes come only after sending.
const SENT_CODES = new Set(["unconfirmed", "not_claimed", "chain_unavailable"]);
const UNKNOWN_ERROR = "Something went wrong on our side. Try again in a minute.";

const messageOf = (error: unknown): string => (error instanceof ClaimFlowError ? error.message : UNKNOWN_ERROR);
const canRetry = (error: unknown): boolean => !(error instanceof ClaimFlowError) || RETRY_CODES.has(error.code);
const wasSent = (error: unknown): boolean => error instanceof ClaimFlowError && SENT_CODES.has(error.code);

function claimDeps() {
  return { fetch: window.fetch.bind(window), origin: window.location.origin, publicClient, vault: VAULT };
}

// Turns a made-up development scenario into the same states the real flow uses.
function stateOfPreview(scenario: PreviewScenario): { load: LoadState; claim: ClaimState } {
  const load: LoadState = scenario.loading
    ? { status: "loading" }
    : scenario.invalid
    ? { status: "invalid" }
    : scenario.loadFailed
      ? { status: "failed", error: new ClaimFlowError("server_unreachable", "Moi's server could not be reached. Your gift is safe; try again in a minute.") }
      : { status: "loaded", gift: scenario.gift, note: scenario.note, expired: scenario.expired };
  const claim: ClaimState =
    scenario.claim === "opening"
      ? { status: "opening" }
      : scenario.claim === "opened"
        ? { status: "opened", txHash: scenario.txHash, address: scenario.address }
        : scenario.claim === "failed-after"
          ? {
              status: "failed",
              started: true,
              error: new ClaimFlowError("unconfirmed", `The claim was sent (transaction ${scenario.txHash}) but is not confirmed yet. Check again in a minute.`),
            }
          : { status: "idle" };
  return { load, claim };
}

/**
 * The claim page's brain. It loads the gift with the key the page took from the address, works out
 * which screen applies, and runs the claim only when the signed-in friend taps "Open your gift"
 * (C16). It never claims on load and never calls the claim from an effect.
 */
export function ClaimFlow({ giftId, boot }: { giftId: string; boot: ClaimKeyResult }) {
  const signInAvailable = useSignInAvailable();
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const stocks = useStocks();
  const [preview] = useState<PreviewScenario | null>(() => (process.env.NODE_ENV === "production" ? null : previewScenario(window.location.search)));
  const fixture = process.env.NODE_ENV === "production" || preview === null ? null : stateOfPreview(preview);

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [claim, setClaim] = useState<ClaimState>({ status: "idle" });
  const [declared, setDeclared] = useState(false);
  const lastRecipient = useRef<Address | null>(null);
  const key = boot.key;

  useEffect(() => {
    if (key === null || preview !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await loadGift(claimDeps(), BigInt(giftId), key);
        if (cancelled) return;
        setLoad(
          result.keyMatches
            ? { status: "loaded", gift: result.gift, note: result.note, expired: result.gift.expiry * 1000n <= BigInt(Date.now()) }
            : { status: "invalid" },
        );
      } catch (error) {
        if (cancelled) return;
        setLoad(error instanceof ClaimFlowError && LINK_CODES.has(error.code) ? { status: "invalid" } : { status: "failed", error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, giftId, key, preview]);

  const reloadGift = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  const run = useCallback(
    async (recipient: Address) => {
      if (key === null) return;
      lastRecipient.current = recipient;
      setClaim({ status: "opening" });
      try {
        const { txHash } = await claimGift(claimDeps(), { giftId: BigInt(giftId), claimKey: key, recipient, declaration: true });
        forgetClaimKey(giftId);
        setClaim({ status: "opened", txHash, address: recipient });
      } catch (error) {
        setClaim({ status: "failed", error, started: wasSent(error) });
      }
    },
    [giftId, key],
  );

  const retryClaim = useCallback(() => {
    const recipient = lastRecipient.current;
    if (recipient !== null) void run(recipient);
  }, [run]);

  const worthOf = (gift: GiftView): string | null => {
    if (stocks.status !== "ready") return null;
    const price = stocks.stocks.find((stock) => stock.symbol === gift.symbol)?.priceUsd ?? null;
    const shares = Number(gift.shares);
    if (price === null || !Number.isFinite(shares)) return null;
    return `WORTH ABOUT $${(shares * price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const embedded = walletsReady ? getEmbeddedConnectedWallet(wallets) : null;
  let signIn: SignInView;
  if (process.env.NODE_ENV !== "production" && preview?.fakeSignedIn === true) {
    // Development only: tapping open plays the opening and then the opened screen, with nothing sent anywhere.
    signIn = {
      kind: "signedIn",
      who: preview.email,
      address: preview.address,
      onSignOut: () => undefined,
      declared,
      onDeclared: setDeclared,
      onOpen: () => {
        setClaim({ status: "opening" });
        window.setTimeout(() => setClaim({ status: "opened", txHash: preview.txHash, address: preview.address }), 5000);
      },
    };
  } else if (!signInAvailable) {
    signIn = { kind: "unavailable", storageBlocked: boot.storageBlocked };
  } else if (!ready) {
    signIn = { kind: "booting" };
  } else if (!authenticated) {
    signIn = { kind: "signedOut", storageBlocked: boot.storageBlocked, onSignIn: () => login() };
  } else if (embedded === null) {
    signIn = { kind: "makingWallet" };
  } else {
    const address = embedded.address as Address;
    signIn = {
      kind: "signedIn",
      who: user?.email?.address ?? user?.google?.email ?? null,
      address,
      onSignOut: () => void logout(),
      declared,
      onDeclared: setDeclared,
      onOpen: () => {
        if (declared) void run(address);
      },
    };
  }

  const shownLoad = fixture?.load ?? load;
  const shownClaim = fixture !== null && fixture.claim.status !== "idle" ? fixture.claim : claim;
  let view: View;
  if (key === null && fixture === null) {
    view = { screen: "invalid" };
  } else if (shownLoad.status === "loading") {
    view = { screen: "loading" };
  } else if (shownLoad.status === "invalid") {
    view = { screen: "invalid" };
  } else if (shownLoad.status === "failed") {
    view = { screen: "error", gift: null, worth: null, message: messageOf(shownLoad.error), started: false, onRetry: canRetry(shownLoad.error) ? reloadGift : null };
  } else {
    const { gift, note, expired } = shownLoad;
    const worth = worthOf(gift);
    if (shownClaim.status === "opening") {
      view = { screen: "opening", gift, worth };
    } else if (shownClaim.status === "opened") {
      view = { screen: "opened", gift, worth, note, txHash: shownClaim.txHash, address: shownClaim.address };
    } else if (shownClaim.status === "failed") {
      view = {
        screen: "error",
        gift,
        worth,
        message: messageOf(shownClaim.error),
        started: shownClaim.started,
        onRetry: canRetry(shownClaim.error) ? retryClaim : null,
      };
    } else if (gift.state === "Claimed") {
      view = { screen: "claimed", gift, worth };
    } else if (gift.state === "Refunded") {
      view = { screen: "refunded", gift, worth };
    } else if (expired) {
      view = { screen: "expired", gift, worth };
    } else if (!gift.senderCompliant) {
      view = { screen: "paused", gift, worth };
    } else {
      view = { screen: "ready", gift, worth, signIn };
    }
  }

  return <ClaimView view={view} />;
}
