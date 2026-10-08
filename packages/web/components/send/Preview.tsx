"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Certificate } from "@/components/hero/Certificate";
import { useMediaQuery } from "@/components/hero/useMediaQuery";
import { displayItalic } from "./fonts";
import { usd } from "./format";

const TWEEN_MS = 300;

/** A number that glides to its new value over 300 ms, and jumps when the visitor prefers less motion. */
function useTweened(target: number): number {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [value, setValue] = useState(target);
  const shown = useRef(target);

  useEffect(() => {
    if (reduced) return;
    const from = shown.current;
    if (from === target) return;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / TWEEN_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      shown.current = from + (target - from) * eased;
      setValue(shown.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, reduced]);

  return reduced ? target : value;
}

// The certificate's own pen is drawn by the hero's scroll progress; here it is simply fully drawn.
const DRAWN = { "--hand": 1 } as CSSProperties;

/** What the friend will see: the certificate with the estimated shares, and the note under it. */
export function Preview({ stockName, shares, amount, note }: { stockName: string | null; shares: number; amount: number; note: string }) {
  const figure = useTweened(shares);
  return (
    <div className="send-preview">
      <p className="send-label send-label-small">WHAT THEY&apos;LL SEE</p>
      <div className="send-cert" style={DRAWN}>
        <Certificate
          figure={figure.toFixed(4)}
          holding={stockName === null ? "SHARES" : `SHARES OF ${stockName.toUpperCase()}`}
          worth={`WORTH $${usd(amount)}`}
        />
      </div>
      {note.trim() === "" ? null : (
        <p className="send-preview-note" style={{ fontFamily: displayItalic.style.fontFamily }}>
          {note}
        </p>
      )}
    </div>
  );
}
