"use client";

import { Fraunces } from "next/font/google";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import type { GiftView } from "@moi/core/src/client/claim.js";
import { Grain } from "@/components/hero/Grain";
import { VMark } from "@/components/hero/VMark";
import { displayName } from "@/lib/stocks";
import { ClaimStage, type SceneState } from "./ClaimStage";

// The root layout loads Fraunces upright only, so the italic cut is loaded here, as the hero does.
const displayItalic = Fraunces({
  subsets: ["latin"],
  style: ["italic"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const STILL_WAITING_AFTER_SECONDS = 20;

/** What the sign-in part of the ready panel shows. */
export type SignInView =
  | { kind: "unavailable"; storageBlocked: boolean }
  | { kind: "booting" }
  | { kind: "signedOut"; storageBlocked: boolean; onSignIn: () => void }
  | { kind: "makingWallet" }
  | {
      kind: "signedIn";
      who: string | null;
      address: Address;
      onSignOut: () => void;
      declared: boolean;
      onDeclared: (declared: boolean) => void;
      onOpen: () => void;
    };

/** Everything the page can show. ClaimFlow decides which one, this file only draws it. */
export type View =
  | { screen: "loading" }
  | { screen: "invalid" }
  | { screen: "claimed" | "refunded" | "expired" | "paused"; gift: GiftView; worth: string | null }
  | { screen: "ready"; gift: GiftView; worth: string | null; signIn: SignInView }
  | { screen: "opening"; gift: GiftView; worth: string | null }
  | { screen: "opened"; gift: GiftView; worth: string | null; note: string | null; txHash: Hex; address: Address }
  | { screen: "error"; gift: GiftView | null; worth: string | null; message: string; started: boolean; onRetry: (() => void) | null };

function sceneOf(view: View): SceneState | null {
  switch (view.screen) {
    case "invalid":
      return null;
    case "loading":
    case "ready":
    case "paused":
      return "closed";
    case "refunded":
    case "expired":
      return "dimmed";
    case "claimed":
      return "claimed";
    case "opening":
      return "opening";
    case "opened":
      return "opened";
    case "error":
      return view.started ? "half-open" : "closed";
  }
}

/** The day as "15 OCT 2026", read in UTC so every reader sees the same date. */
function expiryText(expiry: bigint): string {
  const date = new Date(Number(expiry) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The first 6 and last 4 characters of an address. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The claim page: top bar, the scene box, and the panel under it. Every string that came from
 * the chain or the sender (token name, symbol, note) is a plain text child here, never markup (C14).
 */
export function ClaimView({ view }: { view: View }) {
  const scene = sceneOf(view);
  const gift = "gift" in view ? view.gift : null;
  const worth = "worth" in view ? view.worth : null;
  const certificate = useMemo(
    () => (gift === null ? undefined : { figure: gift.shares, holding: `SHARES OF ${displayName(gift.name).toUpperCase()}`, worth }),
    [gift, worth],
  );

  return (
    <div className="claim-page" data-scene={scene === null ? "none" : "shown"}>
      <header className="claim-bar">
        <Link className="claim-brand" href="/" prefetch={false}>
          <VMark width={12} />
          <span className="claim-wordmark">Moi</span>
        </Link>
      </header>
      {scene === null ? null : <ClaimStage state={scene} certificate={certificate} />}
      <main className="claim-panel" key={view.screen} data-screen={view.screen} aria-live="polite">
        <Panel view={view} />
      </main>
      <Grain />
    </div>
  );
}

function Panel({ view }: { view: View }) {
  switch (view.screen) {
    case "loading":
      return (
        <>
          <p className="claim-meta">OPENING THE LINK</p>
          <span className="claim-skel" />
          <span className="claim-skel claim-skel-short" />
        </>
      );
    case "invalid":
      return (
        <>
          <h1 className="claim-h">{"This link doesn't open a gift."}</h1>
          <p className="claim-body">It may have been cut short or changed. Ask the sender to send it again, whole.</p>
          <p className="claim-links">
            <Link className="claim-link" href="/" prefetch={false}>
              What is Moi?
            </Link>
          </p>
        </>
      );
    case "claimed":
      return (
        <>
          <h1 className="claim-h">This gift has been opened.</h1>
          <p className="claim-body">Its share now belongs to whoever opened it. If that was you, it is already in your wallet.</p>
        </>
      );
    case "refunded":
      return (
        <>
          <h1 className="claim-h">This gift went back to the sender.</h1>
          <p className="claim-body">Gifts that are not opened before they expire return to whoever sent them.</p>
        </>
      );
    case "expired":
      return (
        <>
          <h1 className="claim-h">This gift has expired.</h1>
          <p className="claim-body">The sender can now take it back. Ask them to send you a new one.</p>
        </>
      );
    case "paused":
      return (
        <>
          <h1 className="claim-h">{"This gift can't be opened right now."}</h1>
          <p className="claim-body">
            {"The share's issuer is holding gifts from this sender. If that changes, the link will work again until it expires."}
          </p>
        </>
      );
    case "ready":
      return <ReadyPanel gift={view.gift} worth={view.worth} signIn={view.signIn} />;
    case "opening":
      return <OpeningPanel />;
    case "opened":
      return <OpenedPanel view={view} />;
    case "error":
      return (
        <div className="claim-error" role="alert">
          <h1 className="claim-error-h">{"That didn't work"}</h1>
          <p className="claim-body claim-error-body">{view.message}</p>
          {view.onRetry === null ? null : (
            <button type="button" className="claim-link claim-retry" onClick={view.onRetry}>
              Try again
            </button>
          )}
        </div>
      );
  }
}

function ReadyPanel({ gift, worth, signIn }: { gift: GiftView; worth: string | null; signIn: SignInView }) {
  return (
    <>
      <p className="claim-meta">{`A GIFT FOR YOU · ${displayName(gift.name).toUpperCase()} · OPEN BY ${expiryText(gift.expiry)}`}</p>
      <h1 className="claim-h claim-h-big">
        Someone sent you
        <br />
        <em className="claim-italic" style={{ fontFamily: displayItalic.style.fontFamily }}>{`a piece of ${displayName(gift.name)}.`}</em>
      </h1>
      <p className="claim-count">{`${gift.shares} SHARES${worth === null ? "" : ` · ${worth}`}`}</p>
      <SignIn signIn={signIn} />
    </>
  );
}

function SignIn({ signIn }: { signIn: SignInView }) {
  switch (signIn.kind) {
    case "booting":
      return (
        <button type="button" className="claim-primary" disabled>
          Getting ready
        </button>
      );
    case "makingWallet":
      return (
        <button type="button" className="claim-primary" disabled>
          Making your wallet
        </button>
      );
    case "unavailable":
    case "signedOut":
      return (
        <>
          {signIn.kind === "unavailable" ? (
            <p className="claim-unavailable">Sign-in is not available right now. Try again later.</p>
          ) : (
            <button type="button" className="claim-primary" onClick={signIn.onSignIn}>
              Sign in to open it
            </button>
          )}
          <p className="claim-fine">Use Google or email. Moi makes a wallet for you: no seed phrase, no fees.</p>
          {signIn.storageBlocked ? (
            <p className="claim-fine">This browser blocks storage, so use email to sign in, or the link will need opening again.</p>
          ) : null}
        </>
      );
    case "signedIn":
      return <SignedIn signIn={signIn} />;
  }
}

function SignedIn({ signIn }: { signIn: Extract<SignInView, { kind: "signedIn" }> }) {
  const [why, setWhy] = useState(false);
  return (
    <>
      <p className="claim-who">
        <span>
          {signIn.who === null ? "Signed in" : `Signed in as ${signIn.who}`}
          {" · wallet "}
          <span className="claim-nowrap">{shortAddress(signIn.address)}</span>
        </span>
        <button type="button" className="claim-link claim-link-small" onClick={signIn.onSignOut}>
          Not you? Sign out
        </button>
      </p>
      <label className="claim-check">
        <input type="checkbox" className="claim-check-input" checked={signIn.declared} onChange={(event) => signIn.onDeclared(event.target.checked)} />
        <span className="claim-check-box" aria-hidden="true">
          <svg viewBox="0 0 12 10" width="12" height="10" fill="none">
            <path d="M1 5.2 L4.4 8.4 L11 1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="claim-check-text">I am not a US person, and I am not in the US or a restricted region.</span>
      </label>
      <button type="button" className="claim-link claim-link-small claim-why" aria-expanded={why} onClick={() => setWhy((open) => !open)}>
        Why we ask
      </button>
      {why ? (
        <p className="claim-fine claim-why-text">
          {"The share's issuer allows these gifts only outside the US and restricted regions. Moi also checks the country your connection comes from."}
        </p>
      ) : null}
      <button type="button" className="claim-primary claim-open" disabled={!signIn.declared} onClick={signIn.onOpen}>
        Open your gift
      </button>
    </>
  );
}

function OpeningPanel() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <h1 className="claim-h claim-h-opening">Opening your gift</h1>
      <p className="claim-body">Moi is moving the share into your wallet and paying the network fee. BNB Chain usually confirms in a few seconds.</p>
      <p className="claim-timer">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</p>
      {seconds >= STILL_WAITING_AFTER_SECONDS ? <p className="claim-fine">Still waiting for BNB Chain. This can take up to two minutes.</p> : null}
    </>
  );
}

function OpenedPanel({ view }: { view: Extract<View, { screen: "opened" }> }) {
  const { gift, note, txHash, address } = view;
  return (
    <>
      <h1 className="claim-h claim-h-big">{"It's yours."}</h1>
      <p className="claim-body claim-body-ink">{`${gift.shares} shares of ${displayName(gift.name)} are in your wallet ${shortAddress(address)} on BNB Chain.`}</p>
      {note !== null && note !== "" ? (
        <blockquote className="claim-note">
          <p className="claim-note-text" style={{ fontFamily: displayItalic.style.fontFamily }}>
            {note}
          </p>
          <p className="claim-note-from">A NOTE FROM THE SENDER</p>
        </blockquote>
      ) : null}
      <p className="claim-links">
        <a className="claim-link" href={`https://bscscan.com/tx/${txHash}`} target="_blank" rel="noopener noreferrer">
          See it on BscScan
        </a>
        <Link className="claim-link" href="/" prefetch={false}>
          What is Moi?
        </Link>
      </p>
      <Link className="claim-secondary" href="/send" prefetch={false}>
        Send someone their first stock
      </Link>
    </>
  );
}
