"use client";

import "@/components/claim/zodNoEval";
import { giftVaultAbi } from "@moi/core/src/generated/giftVaultAbi.js";
import { ClaimFlowError } from "@moi/core/src/client/claim.js";
import { claimJudgeGift } from "@moi/core/src/client/judge.js";
import { callMoi } from "@moi/core/src/client/send.js";
import { getEmbeddedConnectedWallet, usePrivy, useSignMessage, useWallets } from "@privy-io/react-auth";
import gsap from "gsap";
import { Fraunces } from "next/font/google";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Address, Hex } from "viem";
import { Grain } from "@/components/hero/Grain";
import { useMediaQuery } from "@/components/hero/useMediaQuery";
import { V_MARK_PATH } from "@/components/hero/VMark";
import { MoiPrivy, useSignInAvailable } from "@/components/privy/MoiPrivy";
import { publicClient, VAULT } from "@/lib/chain";
import { displayName } from "@/lib/stocks";
import "./judges.css";

// The root layout loads Fraunces upright only, so the italic cut is loaded here, as the hero does.
const displayItalic = Fraunces({
  subsets: ["latin"],
  style: ["italic"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});

const TILT_MAX_DEGREES = 4;
const TILT_LERP = 0.08;
const TILT_SETTLED = 0.001;
const TEAR_SLIDE_PIXELS = 28;
const TEAR_TURN_DEGREES = -10;
const TEAR_STUB_SECONDS = 0.6;
const TEAR_FLIP_SECONDS = 0.8;

/** What the ticket back shows once the share has landed. Null fields mean the server could not be asked. */
type Owned = { shares: string | null; name: string | null; txHash: Hex };

type TicketPhase = "idle" | "claiming" | "done";

type GiftNumber = { status: "loading" } | { status: "ready"; value: string } | { status: "failed" };

/** The vault's nextGiftId, read live, so the number printed on the ticket is the one the next gift will get. */
function useNextGiftNumber(): GiftNumber {
  const [state, setState] = useState<GiftNumber>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    publicClient.readContract({ address: VAULT, abi: giftVaultAbi, functionName: "nextGiftId" }).then(
      (next) => {
        if (!cancelled) setState({ status: "ready", value: next.toString() });
      },
      () => {
        if (!cancelled) setState({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));

/** Desktop only: the ticket leans toward the cursor, easing 8 percent of the way each frame. Writes straight to CSS variables, so React never re-renders. */
function useTicketTilt(root: RefObject<HTMLDivElement | null>, tilt: RefObject<HTMLDivElement | null>) {
  const enabled = useMediaQuery("(min-width: 1024px) and (prefers-reduced-motion: no-preference)");
  useEffect(() => {
    const rootElement = root.current;
    const tiltElement = tilt.current;
    if (!enabled || !rootElement || !tiltElement) return;
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let frame = 0;
    const draw = () => {
      x += (targetX - x) * TILT_LERP;
      y += (targetY - y) * TILT_LERP;
      tiltElement.style.setProperty("--rx", `${(-y * TILT_MAX_DEGREES).toFixed(3)}deg`);
      tiltElement.style.setProperty("--ry", `${(x * TILT_MAX_DEGREES).toFixed(3)}deg`);
      const settled = Math.abs(targetX - x) < TILT_SETTLED && Math.abs(targetY - y) < TILT_SETTLED;
      frame = settled ? 0 : requestAnimationFrame(draw);
    };
    const onMove = (event: PointerEvent) => {
      const box = rootElement.getBoundingClientRect();
      targetX = clampUnit((event.clientX - (box.left + box.width / 2)) / (window.innerWidth / 2));
      targetY = clampUnit((event.clientY - (box.top + box.height / 2)) / (window.innerHeight / 2));
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
      tiltElement.style.removeProperty("--rx");
      tiltElement.style.removeProperty("--ry");
    };
  }, [enabled, root, tilt]);
}

/** The tear: the stub slides and turns away while the body flips to its back. Reduced motion is handled in CSS, so nothing runs here. */
function useTear(phase: TicketPhase, stub: RefObject<HTMLDivElement | null>, flip: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const stubElement = stub.current;
    const flipElement = flip.current;
    if (phase !== "done" || !stubElement || !flipElement) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timeline = gsap.timeline();
    timeline.to(stubElement, { x: -TEAR_SLIDE_PIXELS, rotation: TEAR_TURN_DEGREES, duration: TEAR_STUB_SECONDS, ease: "power3.out" }, 0);
    timeline.to(flipElement, { rotationY: 180, duration: TEAR_FLIP_SECONDS, ease: "power2.inOut" }, 0);
    return () => {
      timeline.kill();
    };
  }, [phase, stub, flip]);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The cinema ticket. Every size inside is written as a share of the ticket's own width (the --u
 * unit in judges.css), so one drawing scales from the 520 px desktop size down to a phone.
 */
function Ticket({ phase, owned, number }: { phase: TicketPhase; owned: Owned | null; number: GiftNumber }) {
  const root = useRef<HTMLDivElement>(null);
  const tilt = useRef<HTMLDivElement>(null);
  const stub = useRef<HTMLDivElement>(null);
  const flip = useRef<HTMLDivElement>(null);
  useTicketTilt(root, tilt);
  useTear(phase, stub, flip);

  return (
    <div className="jt" data-phase={phase} ref={root}>
      <div className="jt-tilt" ref={tilt}>
        <div className="jt-stub" ref={stub}>
          <span className="jt-shadow" aria-hidden="true" />
          <div className="jt-face jt-stub-face" aria-hidden="true">
            <svg className="jt-v" viewBox="0 0 24 14" fill="none" focusable="false">
              <path d={V_MARK_PATH} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="jt-admit">ADMIT ONE</span>
          </div>
        </div>
        <div className="jt-body">
          <span className="jt-shadow" aria-hidden="true" />
          <div className="jt-flip" ref={flip}>
            <div className="jt-face jt-front" aria-hidden="true">
              <p className="jt-presents">MOI PRESENTS</p>
              <p className="jt-title">Your first stock</p>
              <p className="jt-fine">BNB CHAIN · ONE PER JUDGE · SEAT: YOURS</p>
              <p className="jt-number" data-state={number.status}>
                {number.status === "ready" ? `NO. ${number.value}` : number.status === "loading" ? <span className="jt-number-skeleton" /> : null}
              </p>
            </div>
            <div className="jt-face jt-back" aria-hidden={owned === null}>
              {owned === null ? null : <TicketBack owned={owned} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TicketBack({ owned }: { owned: Owned }) {
  return (
    <div className="jt-back-inner">
      <p className="jt-own">YOU OWN</p>
      {owned.shares === null ? (
        <p className="jt-figure jt-figure-title">Your first stock</p>
      ) : (
        <p className="jt-figure" style={{ "--len": Math.max(owned.shares.length, 1) } as CSSProperties}>
          {owned.shares}
        </p>
      )}
      {owned.shares === null || owned.name === null ? null : <p className="jt-holding">{`shares of ${owned.name}`}</p>}
      <a className="jt-link" href={`https://bscscan.com/tx/${owned.txHash}`} target="_blank" rel="noopener noreferrer">
        SEE IT ON BSCSCAN
      </a>
    </div>
  );
}

/** What step 1 shows. */
type SignInView =
  | { kind: "unavailable" }
  | { kind: "booting" }
  | { kind: "signedOut" }
  | { kind: "makingWallet" }
  | { kind: "signedIn"; who: string | null; address: Address };

function SignInStep({ signIn, onSignIn, onSignOut }: { signIn: SignInView; onSignIn: () => void; onSignOut: () => void }) {
  switch (signIn.kind) {
    case "unavailable":
      return <p className="judges-unavailable">Sign-in is not available right now.</p>;
    case "booting":
    case "signedOut":
      return (
        <button type="button" className="judges-secondary" disabled={signIn.kind === "booting"} onClick={onSignIn}>
          Sign in with Google or email
        </button>
      );
    case "makingWallet":
      return <p className="judges-quiet">Making your wallet</p>;
    case "signedIn":
      return (
        <p className="judges-who">
          <span>
            {signIn.who === null ? "Signed in" : `Signed in as ${signIn.who}`}
            {" · wallet "}
            <span className="judges-nowrap">{shortAddress(signIn.address)}</span>
          </span>
          <button type="button" className="judges-link judges-link-small" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      );
  }
}

type StepsProps = {
  signIn: SignInView;
  onSignIn: () => void;
  onSignOut: () => void;
  code: string;
  onCode: (code: string) => void;
  declared: boolean;
  onDeclared: (declared: boolean) => void;
  locked: boolean;
};

/** The three numbered steps. While a claim runs they fade to 40 percent and stop taking input. */
function Steps({ signIn, onSignIn, onSignOut, code, onCode, declared, onDeclared, locked }: StepsProps) {
  return (
    <ol className="judges-steps-list" data-locked={locked} inert={locked}>
      <li className="judges-step" style={{ "--first-h": "44px" } as CSSProperties}>
        <span className="judges-step-number">1</span>
        <div className="judges-step-body">
          <SignInStep signIn={signIn} onSignIn={onSignIn} onSignOut={onSignOut} />
        </div>
      </li>
      <li className="judges-step" style={{ "--first-h": "48px" } as CSSProperties}>
        <span className="judges-step-number">2</span>
        <div className="judges-step-body">
          <input
            className="judges-input"
            type="text"
            value={code}
            onChange={(event) => onCode(event.target.value)}
            placeholder="From our submission"
            aria-label="Judge code"
            aria-describedby="judges-code-hint"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={64}
          />
          <p className="judges-hint" id="judges-code-hint">
            It is in the judging instructions of our submission.
          </p>
        </div>
      </li>
      <li className="judges-step" style={{ "--first-h": "20px" } as CSSProperties}>
        <span className="judges-step-number">3</span>
        <div className="judges-step-body">
          <label className="judges-check">
            <input className="judges-check-input" type="checkbox" checked={declared} onChange={(event) => onDeclared(event.target.checked)} />
            <span className="judges-check-box" aria-hidden="true">
              <svg viewBox="0 0 12 10" width="12" height="10" fill="none">
                <path d="M1 5.2 L4.4 8.4 L11 1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="judges-check-text">I am not a US person, and I am not in the US or a restricted region.</span>
          </label>
        </div>
      </li>
    </ol>
  );
}

/** The ways a claim can be at rest or on its way. */
type Phase =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "done"; owned: Owned; address: Address }
  | { kind: "error"; error: unknown };

// For these, trying the same claim again can work.
const RETRY_CODES = new Set(["server_unreachable", "chain_unavailable", "unconfirmed", "declined"]);
const UNKNOWN_ERROR = "Something went wrong on our side. Try again in a minute.";
const CHAIN_DOWN = "Moi could not reach the blockchain just now. Try again in a minute.";
const STILL_WAITING_AFTER_SECONDS = 20;
const GIFT_TIMEOUT_MS = 15_000;
const GIFT_TRIES = 3;
const GIFT_RETRY_MS = 2_000;
const SHARES_TEXT = /^[0-9]+(\.[0-9]+)?$/;
const MAX_NAME_CHARS = 64;
const MAX_SHARES_CHARS = 160;

const PREVIEW_NAMES = ["ready", "claiming", "done", "error", "retry"] as const;
type PreviewName = (typeof PREVIEW_NAMES)[number];

/** Development only: which made-up screen the address asks for with ?judgePreview=. Every call is behind a NODE_ENV check, so a production build holds none of this. */
function readPreview(search: string): PreviewName | null {
  const name = new URLSearchParams(search).get("judgePreview");
  return PREVIEW_NAMES.find((candidate) => candidate === name) ?? null;
}

/** Development only, and all of it made up: a signed-in judge with the form filled in, and the screen the name asks for. */
function previewState(name: PreviewName) {
  const address: Address = "0x1234567890abcdef1234567890abcdef12345678";
  const owned: Owned = { shares: "0.0042", name: "NVIDIA", txHash: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" };
  const refused = new ClaimFlowError("refused", "That judge code is not right. It is in the submission's instructions for judges.", "bad_judge_code");
  const unreachable = new ClaimFlowError("server_unreachable", "Moi's server could not be reached. Try again in a minute.");
  const phase: Phase =
    name === "claiming"
      ? { kind: "claiming" }
      : name === "done"
        ? { kind: "done", owned, address }
        : name === "error"
          ? { kind: "error", error: refused }
          : name === "retry"
            ? { kind: "error", error: unreachable }
            : { kind: "idle" };
  return { who: "meena@example.com", address, code: "made-up-code", declared: true, phase };
}

/** What arrived, read back from Moi's own server after the claim: the stock's name and how many shares. Null when it could not be read. */
async function readArrival(giftId: bigint): Promise<{ shares: string; name: string } | null> {
  for (let attempt = 0; attempt < GIFT_TRIES; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, GIFT_RETRY_MS));
    try {
      const reply = await callMoi({ fetch: window.fetch.bind(window), origin: window.location.origin }, "GET", `/api/gift/${giftId}`, { timeoutMs: GIFT_TIMEOUT_MS });
      if (reply.status !== 200 || typeof reply.body !== "object" || reply.body === null) continue;
      const { name, shares } = reply.body as Record<string, unknown>;
      if (typeof name !== "string" || name === "" || name.length > MAX_NAME_CHARS) continue;
      if (typeof shares !== "string" || shares.length > MAX_SHARES_CHARS || !SHARES_TEXT.test(shares)) continue;
      return { shares, name: displayName(name) };
    } catch {
      // The claim already went through, so a failed read only means trying once more.
    }
  }
  return null;
}

function ClaimingBlock() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="judges-status" role="status">
      <h3 className="judges-status-title">Claiming your share</h3>
      <p className="judges-status-body">Prove the wallet is yours in the Privy window. Then Moi delivers the share and pays the fee.</p>
      <p className="judges-timer">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</p>
      {seconds >= STILL_WAITING_AFTER_SECONDS ? <p className="judges-hint">Still waiting for BNB Chain. This can take up to two minutes.</p> : null}
    </div>
  );
}

function ErrorBlock({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const typed = error instanceof ClaimFlowError;
  return (
    <div className="judges-error" role="alert">
      {typed ? null : <h3 className="judges-error-title">{"That didn't work"}</h3>}
      <p className="judges-error-body">{typed ? error.message : UNKNOWN_ERROR}</p>
      {typed && RETRY_CODES.has(error.code) ? (
        <button type="button" className="judges-link" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function DoneBlock({ owned, address }: { owned: Owned; address: Address }) {
  const where = `in your wallet ${shortAddress(address)} on BNB Chain.`;
  return (
    <div className="judges-done" role="status">
      <h3 className="judges-done-title">{"It's yours."}</h3>
      <p className="judges-done-body">
        {owned.shares === null || owned.name === null ? `Your share is ${where}` : `${owned.shares} shares of ${owned.name} are ${where}`}
      </p>
    </div>
  );
}

function JudgesStage() {
  const signInAvailable = useSignInAvailable();
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signMessage: privySign } = useSignMessage();
  const number = useNextGiftNumber();
  const [code, setCode] = useState("");
  const [declared, setDeclared] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [fake, setFake] = useState<{ who: string; address: Address } | null>(null);
  const busy = useRef(false);

  // Development only. It waits one task so the state is set from a callback, not during the effect.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const timer = window.setTimeout(() => {
      const name = readPreview(window.location.search);
      if (name === null) return;
      const shown = previewState(name);
      setFake({ who: shown.who, address: shown.address });
      setCode(shown.code);
      setDeclared(shown.declared);
      setPhase(shown.phase);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const embedded = walletsReady ? getEmbeddedConnectedWallet(wallets) : null;
  let signIn: SignInView;
  if (process.env.NODE_ENV !== "production" && fake !== null) {
    signIn = { kind: "signedIn", who: fake.who, address: fake.address };
  } else if (!signInAvailable) {
    signIn = { kind: "unavailable" };
  } else if (!ready) {
    signIn = { kind: "booting" };
  } else if (!authenticated) {
    signIn = { kind: "signedOut" };
  } else if (embedded === null) {
    signIn = { kind: "makingWallet" };
  } else {
    signIn = { kind: "signedIn", who: user?.email?.address ?? user?.google?.email ?? null, address: embedded.address as Address };
  }
  const claiming = phase.kind === "claiming";
  const canClaim = signIn.kind === "signedIn" && code.trim() !== "" && declared && !claiming;

  const claim = async () => {
    if (busy.current) return;
    if (process.env.NODE_ENV !== "production" && fake !== null) {
      // Development only: tapping claim plays the claiming screen and then the done screen, with nothing sent anywhere.
      setPhase({ kind: "claiming" });
      window.setTimeout(() => setPhase(previewState("done").phase), 5000);
      return;
    }
    if (embedded === null) return;
    busy.current = true;
    setPhase({ kind: "claiming" });
    try {
      const recipient = embedded.address as Address;
      // The wallet proof is dated by the chain, not by this device, so a wrong clock cannot spoil it.
      let blockMs: number;
      try {
        blockMs = Number((await publicClient.getBlock()).timestamp) * 1000;
      } catch {
        throw new ClaimFlowError("chain_unavailable", CHAIN_DOWN);
      }
      const readAt = Date.now();
      let accessToken: string | null;
      try {
        accessToken = await getAccessToken();
      } catch {
        accessToken = null;
      }
      const signMessage = async (message: string): Promise<Hex> => {
        const { signature } = await privySign(
          { message },
          {
            address: recipient,
            uiOptions: { title: "Prove this wallet is yours", description: "Free. No transaction. Moi checks it before sending your share.", buttonText: "Sign" },
          },
        );
        return signature as Hex;
      };
      const { giftId, txHash } = await claimJudgeGift(
        { fetch: window.fetch.bind(window), origin: window.location.origin, publicClient, vault: VAULT },
        {
          judgeCode: code.trim(),
          // A missing token goes in as empty text, which core refuses with its own "sign in again" sentence.
          accessToken: accessToken ?? "",
          recipient,
          signMessage,
          declaration: true,
          now: () => blockMs + (Date.now() - readAt),
        },
      );
      const arrival = await readArrival(giftId);
      setPhase({ kind: "done", owned: { shares: arrival?.shares ?? null, name: arrival?.name ?? null, txHash }, address: recipient });
    } catch (error) {
      setPhase({ kind: "error", error });
    } finally {
      busy.current = false;
    }
  };

  const ticketPhase: TicketPhase = phase.kind === "done" ? "done" : phase.kind === "claiming" ? "claiming" : "idle";

  return (
    <div className="judges-grid">
      <div className="judges-text">
        <p className="judges-label">FOR JUDGES</p>
        <h2 className="judges-title" id="judges-title">
          Claim a real share.
          <br />
          <span className="judges-title-italic" style={{ fontFamily: displayItalic.style.fontFamily }}>
            On us.
          </span>
        </h2>
        <p className="judges-body">
          Sign in with Google or email, enter the judge code from our submission, and a real tokenized share lands in a wallet made for you, exactly as it would for a friend. One per judge.
        </p>
      </div>
      <div className="judges-ticket">
        <Ticket phase={ticketPhase} owned={phase.kind === "done" ? phase.owned : null} number={number} />
      </div>
      <div className="judges-steps">
        {phase.kind === "done" ? (
          <DoneBlock owned={phase.owned} address={phase.address} />
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (canClaim) void claim();
            }}
          >
            <Steps
              signIn={signIn}
              onSignIn={() => login()}
              onSignOut={() => void logout()}
              code={code}
              onCode={setCode}
              declared={declared}
              onDeclared={setDeclared}
              locked={claiming}
            />
            <button type="submit" className="judges-primary" disabled={!canClaim}>
              Claim my share
            </button>
            {phase.kind === "claiming" ? <ClaimingBlock /> : null}
            {phase.kind === "error" ? <ErrorBlock error={phase.error} onRetry={() => void claim()} /> : null}
          </form>
        )}
      </div>
    </div>
  );
}

export function ForJudges({ nonce }: { nonce: string | undefined }) {
  return (
    <section className="judges" id="judges" aria-labelledby="judges-title">
      <MoiPrivy nonce={nonce}>
        <JudgesStage />
      </MoiPrivy>
      <Grain />
    </section>
  );
}
