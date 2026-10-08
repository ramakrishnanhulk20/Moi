"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Fraunces } from "next/font/google";
import Link from "next/link";
import { SiteNav } from "@/components/nav/SiteNav";
import { LiveTicker } from "./LiveTicker";

// The root layout loads Fraunces upright only, so the italic cut is loaded here. Without it the
// browser would slant the upright letters and the title would look faked.
const displayItalic = Fraunces({
  subsets: ["latin"],
  style: ["italic"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

type Word = { text: string; italic?: boolean };

const TITLE_LINES: readonly (readonly Word[])[] = [
  [{ text: "Give" }, { text: "someone" }],
  [{ text: "their" }, { text: "first", italic: true }, { text: "stock.", italic: true }],
];

// The rise used by the title, the subline and the buttons. Under reduced motion each one only fades.
function riseTransition(reduced: boolean, delay: number) {
  return reduced ? { opacity: { duration: 0.3 }, y: { duration: 0 } } : { duration: 0.9, delay, ease: EASE_OUT };
}

export function HeroCopy() {
  const reduced = Boolean(useReducedMotion());
  let wordIndex = 0;

  return (
    <>
      <SiteNav />

      <div className="hero-content">
        <div className="hero-inner">
          <motion.p
            className="hero-meta"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduced ? { duration: 0.3 } : { duration: 0.6, delay: 0.05 }}
          >
            <span className="hero-meta-part">A GIFT IN ONE LINK</span>
            <span className="hero-meta-gap">{"  ·  "}</span>
            <span className="hero-meta-part">REAL SHARES ON BNB CHAIN</span>
            <span className="hero-meta-gap">{"  ·  "}</span>
            <span className="hero-meta-part">CLAIMED IN 30 SECONDS</span>
          </motion.p>

          <h1 className="hero-title">
            {TITLE_LINES.map((line, lineIndex) => (
              <span className="hero-title-line" key={lineIndex}>
                {line.map((word, position) => {
                  const index = wordIndex++;
                  return (
                    <span key={word.text}>
                      {position > 0 ? " " : null}
                      <motion.span
                        className={word.italic ? "hero-word hero-word-italic" : "hero-word"}
                        style={word.italic ? { fontFamily: displayItalic.style.fontFamily } : undefined}
                        initial={{ opacity: 0, y: 32 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={riseTransition(reduced, 0.1 + index * 0.06)}
                      >
                        {word.text}
                      </motion.span>
                    </span>
                  );
                })}
              </span>
            ))}
          </h1>

          <motion.p
            className="hero-sub"
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={riseTransition(reduced, 0.45)}
          >
            Send a real share of Nvidia, Apple or the S&amp;P 500 as a link. Your friend opens it, signs in with Google, and owns it. No wallet, no
            seed phrase, no fees to pay.
          </motion.p>

          <motion.div
            className="hero-actions"
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={riseTransition(reduced, 0.6)}
          >
            <Link className="hero-btn hero-btn-primary" href="/send" prefetch={false}>
              Send a gift
            </Link>
            <a className="hero-btn hero-btn-secondary" href="#judges">
              Judges: claim a real share
            </a>
          </motion.div>
        </div>
      </div>

      <LiveTicker />
    </>
  );
}
