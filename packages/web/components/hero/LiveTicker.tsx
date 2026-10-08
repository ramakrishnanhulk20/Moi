"use client";

import { motion, useReducedMotion } from "framer-motion";
import { tickerEntries, useStocks } from "@/lib/stocks";

// Four copies of the list: the track slides left by exactly half its width and starts over, and
// two copies are always wider than the screen, so the loop shows no gap.
const COPIES = [0, 1, 2, 3];

/**
 * The price strip pinned to the bottom of a hero. Prices come from /api/stocks. While they load
 * it shows three grey bars; if the request fails it renders nothing, so no number is ever invented.
 */
export function LiveTicker() {
  const state = useStocks();
  const reduced = Boolean(useReducedMotion());
  if (state.status === "failed") return null;
  const entries = state.status === "ready" ? tickerEntries(state.stocks) : [];
  if (state.status === "ready" && entries.length === 0) return null;

  return (
    <motion.div
      className="hero-ticker"
      role="region"
      aria-label="Live share prices"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { opacity: { duration: 0.3 }, y: { duration: 0 } } : { duration: 0.8, delay: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      {state.status === "loading" ? (
        <div className="hero-ticker-skeletons" aria-hidden="true">
          <span className="skeleton-bar" />
          <span className="skeleton-bar" />
          <span className="skeleton-bar" />
        </div>
      ) : (
        <div className="hero-ticker-track">
          {COPIES.map((copy) =>
            entries.map((entry) => (
              <span className="hero-ticker-item" key={`${copy}-${entry.symbol}`} aria-hidden={copy > 0 ? "true" : undefined}>
                {`${entry.name}  $${entry.price}`}
                <span className="hero-ticker-dot">·</span>
              </span>
            )),
          )}
        </div>
      )}
    </motion.div>
  );
}
