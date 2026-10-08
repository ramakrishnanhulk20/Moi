"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Fraunces } from "next/font/google";
import { useEffect, useRef, type ReactElement } from "react";
import { Certificate } from "@/components/hero/Certificate";
import { EnvelopeFallback } from "@/components/hero/EnvelopeFallback";
import { Grain } from "@/components/hero/Grain";
import { PROOF, shortHex, txUrl } from "@/lib/proof";
import { tickerEntries, useShareFigure, useStocks } from "@/lib/stocks";
import "./sections.css";

// The root layout loads Fraunces upright only, so the italic cut is loaded here, as the hero does.
const displayItalic = Fraunces({
  subsets: ["latin"],
  style: ["italic"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});

const RISE_SECONDS = 0.6;
const RISE_PIXELS = 24;
const STRIP_PIN_VIEWPORTS = 3;
const STRIP_SCRUB_SECONDS = 0.6;
const RISE_FRACTION = 0.2;
const OWN_SCENE_FRACTION = 0.5;
// On a short landscape screen a frame can be taller than the screen, so "half visible" is capped at 90 percent of the screen.
const SCREEN_CAP_FRACTION = 0.9;

const CHIPS = [
  { symbol: "NVDAB", label: "NVIDIA" },
  { symbol: "AAPLB", label: "APPLE" },
  { symbol: "SPYB", label: "SPY" },
] as const;

type ProofLineProps = { words: string; hash: string };

/** "ON CHAIN", a dot, what happened, and the transaction hash as a link to BscScan. */
export function ProofLine({ words, hash }: ProofLineProps) {
  return (
    <p className="proof">
      <span>ON CHAIN</span>
      <span aria-hidden="true">·</span>
      <span>{words}</span>
      <a className="proof-link" href={txUrl(hash)} target="_blank" rel="noopener noreferrer">
        {shortHex(hash)}
      </a>
    </p>
  );
}

function StockChips() {
  const state = useStocks();
  const entries = state.status === "ready" ? tickerEntries(state.stocks) : [];
  return (
    <div className="how-chips">
      {CHIPS.map((chip, index) => {
        const entry = entries.find((candidate) => candidate.symbol === chip.symbol);
        return (
          <div className="how-chip" data-top={index === 0 ? "true" : "false"} key={chip.symbol}>
            <span className="how-chip-name">{entry?.name ?? chip.label}</span>
            {state.status === "loading" ? (
              <span className="skeleton-line how-chip-skeleton" aria-label="Loading price" />
            ) : (
              <span className="how-chip-price">{entry ? `$${entry.price}` : "price unavailable"}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ShareMath() {
  const figure = useShareFigure();
  if (figure.state === "hidden") {
    return <p className="how-math-note">The live price could not be read just now.</p>;
  }
  return (
    <div className="how-math">
      <span className="how-math-dollar">$1.00</span>
      <svg className="how-arrow" viewBox="0 0 64 24" width={64} height={24} aria-hidden="true" focusable="false">
        <path d="M2 12H60L50 3L60 12L50 21" pathLength={1} />
      </svg>
      <span className="how-math-result">
        {figure.state === "ready" ? (
          <span className="how-math-figure">{figure.text}</span>
        ) : (
          <span className="skeleton-line how-math-skeleton" aria-label="Loading price" />
        )}
        <span className="how-math-caption">shares of NVIDIA</span>
      </span>
    </div>
  );
}

function SceneOne() {
  return (
    <div className="how-art">
      <StockChips />
      <ShareMath />
    </div>
  );
}

function SceneTwo() {
  return (
    <div className="how-art">
      <div className="how-envelope">
        <EnvelopeFallback open={false} />
      </div>
      <p className="how-caption">GIFT 1 · NVIDIA · LOCKED</p>
    </div>
  );
}

function SceneThree() {
  return (
    <div className="how-art">
      <div className="how-phone">
        <div className="how-screen how-screen-gift" aria-hidden="true">
          <p className="how-screen-label">A GIFT FOR YOU</p>
          <p className="how-screen-title">Someone sent you a share.</p>
          <div className="how-screen-button">Sign in with Google</div>
        </div>
        <div className="how-screen how-screen-cert">
          <Certificate />
        </div>
      </div>
    </div>
  );
}

type Scene = {
  number: string;
  label: string;
  heading: string;
  body: string;
  proof: ProofLineProps;
  art: () => ReactElement;
};

const SCENES: readonly Scene[] = [
  {
    number: "01",
    label: "SCENE ONE · THE BUY",
    heading: "Pick a stock. Pick an amount.",
    body: "Moi asks Binance for a live price, dry-runs the trade first, then buys the real share with your USDT. Nvidia, Apple, Tesla, the S&P 500 and more.",
    proof: { words: "the first buy, 7 Oct 2026", hash: PROOF.firstBuy },
    art: SceneOne,
  },
  {
    number: "02",
    label: "SCENE TWO · THE SEAL",
    heading: "Locked in a vault, under a key only the link holds.",
    body: "The share goes into Moi's vault on BNB Chain. Moi cannot touch it: only the link's key releases it, to the person who opens it. If nobody opens it before it expires, the sender can take it back. The 5-cent gift wrap is paid with b402.",
    proof: { words: "gift 1 locked", hash: PROOF.gift1Locked },
    art: SceneTwo,
  },
  {
    number: "03",
    label: "SCENE THREE · THE CLAIM",
    heading: "Your friend opens it with Google.",
    body: "No wallet app, no seed phrase, no gas. They sign in, tap open, and the share lands in a wallet made for them. Moi pays the network fee.",
    proof: { words: "claimed into a brand-new wallet", hash: PROOF.gift1Claimed },
    art: SceneThree,
  },
];

function clearAttributes(frames: readonly HTMLElement[]): void {
  for (const frame of frames) {
    delete frame.dataset.armed;
    delete frame.dataset.played;
  }
}

// Desktop: the strip slides sideways while the section is pinned, and each frame plays its own
// scene when its centre crosses the middle of the screen.
function setUpStrip(pin: HTMLElement, strip: HTMLElement, frames: readonly HTMLElement[]): () => void {
  const [first, , last] = frames;
  if (!first || !last) return () => undefined;
  for (const frame of frames) frame.dataset.armed = "true";
  const play = (frame: HTMLElement) => () => {
    frame.dataset.played = "true";
  };
  const slide = gsap.to(strip, {
    // Two frames and two gaps: how far the last frame sits from the first.
    x: () => -(last.offsetLeft - first.offsetLeft),
    ease: "none",
    scrollTrigger: {
      trigger: pin,
      start: "top top",
      end: () => `+=${Math.round(window.innerHeight * STRIP_PIN_VIEWPORTS)}`,
      pin: true,
      scrub: STRIP_SCRUB_SECONDS,
      anticipatePin: 1,
      invalidateOnRefresh: true,
    },
  });
  // The first frame is already past the middle sideways, so it starts when the pin catches the screen.
  ScrollTrigger.create({ trigger: pin, start: "top top", once: true, onEnter: play(first) });
  for (const frame of frames.slice(1)) {
    ScrollTrigger.create({
      trigger: frame,
      containerAnimation: slide,
      start: "center center",
      once: true,
      onEnter: play(frame),
    });
  }
  return () => {
    slide.scrollTrigger?.kill();
    slide.kill();
    gsap.set(strip, { clearProps: "transform" });
    clearAttributes(frames);
  };
}

// Phone and tablet: no pin. Each frame rises in at 20 percent visible and plays its scene at 50.
function setUpStack(frames: readonly HTMLElement[]): () => void {
  gsap.set(frames, { opacity: 0, y: RISE_PIXELS });
  for (const frame of frames) frame.dataset.armed = "true";
  const risen = new WeakSet<Element>();
  const played = new WeakSet<Element>();
  const thresholds = Array.from({ length: 21 }, (_, step) => step / 20);
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const frame = entry.target as HTMLElement;
        const fraction = entry.intersectionRatio;
        if (!risen.has(frame) && fraction >= RISE_FRACTION) {
          risen.add(frame);
          gsap.to(frame, { opacity: 1, y: 0, duration: RISE_SECONDS, ease: "power3.out", clearProps: "opacity,transform" });
        }
        const screen = entry.rootBounds?.height ?? window.innerHeight;
        const needed = Math.min(OWN_SCENE_FRACTION * entry.boundingClientRect.height, SCREEN_CAP_FRACTION * screen);
        if (!played.has(frame) && entry.intersectionRect.height >= needed) {
          played.add(frame);
          frame.dataset.played = "true";
        }
      }
    },
    { threshold: thresholds },
  );
  for (const frame of frames) observer.observe(frame);
  return () => {
    observer.disconnect();
    gsap.killTweensOf(frames);
    gsap.set(frames, { clearProps: "opacity,transform" });
    clearAttributes(frames);
  };
}

export function HowItWorks() {
  const root = useRef<HTMLElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = root.current;
    const pinElement = pin.current;
    const stripElement = strip.current;
    if (!section || !pinElement || !stripElement) return;
    gsap.registerPlugin(ScrollTrigger);
    const frames = Array.from(section.querySelectorAll<HTMLElement>(".how-frame"));
    const mediaMatcher = gsap.matchMedia();
    // Reduced motion matches neither query: every frame stays in its finished state, stacked.
    mediaMatcher.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => setUpStrip(pinElement, stripElement, frames));
    mediaMatcher.add("(max-width: 1023px) and (prefers-reduced-motion: no-preference)", () => setUpStack(frames));
    // Fonts change the height of the header, which moves where the pin starts. This runs after the
    // hero has made its own pin, so the strip is measured below the hero's pin spacer.
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) ScrollTrigger.refresh();
    });
    return () => {
      cancelled = true;
      mediaMatcher.revert();
    };
  }, []);

  return (
    <section className="how" id="how" ref={root} aria-labelledby="how-title">
      <header className="how-header">
        <p className="sec-label">HOW IT WORKS</p>
        <h2 className="how-title" id="how-title">
          One link.
          <br />
          <span className="how-title-italic" style={{ fontFamily: displayItalic.style.fontFamily }}>
            Three scenes.
          </span>
        </h2>
        <Grain />
      </header>

      <div className="how-pin" ref={pin}>
        <div className="how-strip" ref={strip}>
          {SCENES.map((scene) => (
            <article className="how-frame" key={scene.number} aria-labelledby={`how-heading-${scene.number}`}>
              <div className="how-text">
                <p className="how-number" aria-hidden="true">
                  {scene.number}
                </p>
                <p className="sec-label how-label">{scene.label}</p>
                <h3 className="how-heading" id={`how-heading-${scene.number}`}>
                  {scene.heading}
                </h3>
                <p className="how-body">{scene.body}</p>
                <ProofLine words={scene.proof.words} hash={scene.proof.hash} />
              </div>
              <scene.art />
            </article>
          ))}
        </div>
        <Grain />
      </div>
    </section>
  );
}
