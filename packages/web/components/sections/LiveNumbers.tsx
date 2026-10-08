"use client";

import { giftVaultAbi } from "@moi/core/src/generated/giftVaultAbi.js";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Grain } from "@/components/hero/Grain";
import { useMediaQuery } from "@/components/hero/useMediaQuery";
import { publicClient, VAULT } from "@/lib/chain";
import { addressCodeUrl, shortHex } from "@/lib/proof";
import "./sections.css";

// The order of GiftVault.State in GiftVault.sol: None, Open, Claimed, Refunded.
const STATE_OPEN = 1;
const STATE_CLAIMED = 2;
const STATE_REFUNDED = 3;
// Reading every gift ever made would grow without limit, so only the newest ones are checked.
const NEWEST_GIFTS = 200;
const LATEST_ROWS = 6;
const COUNT_UP_MS = 1200;
const VISIBLE_FRACTION = 0.4;
const STOCKS_TIMEOUT_MS = 20_000;
// One more try after a failure, because the server's first boot can take a few seconds.
const STOCKS_RETRY_MS = 5_000;

type LatestGift = { id: number; token: string; state: number };

type Counts = { made: number; opened: number; waiting: number; latest: LatestGift[] };

type CountsState = { status: "loading" } | { status: "ready"; counts: Counts } | { status: "failed" };

/** nextGiftId, then getGift for the newest ids in one multicall. Refunded gifts count in "made" and the latest list only. */
async function readCounts(): Promise<Counts> {
  const next = await publicClient.readContract({ address: VAULT, abi: giftVaultAbi, functionName: "nextGiftId" });
  const made = Number(next) - 1;
  const oldest = Math.max(1, made - NEWEST_GIFTS + 1);
  const ids: bigint[] = [];
  for (let id = made; id >= oldest; id -= 1) ids.push(BigInt(id));
  if (ids.length === 0) return { made, opened: 0, waiting: 0, latest: [] };
  const gifts = await publicClient.multicall({
    contracts: ids.map((id) => ({ address: VAULT, abi: giftVaultAbi, functionName: "getGift", args: [id] }) as const),
    allowFailure: false,
  });
  let opened = 0;
  let waiting = 0;
  for (const gift of gifts) {
    if (gift.state === STATE_CLAIMED) opened += 1;
    else if (gift.state === STATE_OPEN) waiting += 1;
  }
  // The ids run newest first, so the first few gifts are the latest ones.
  const latest = gifts.slice(0, LATEST_ROWS).map((gift, index) => ({ id: Number(ids[index]), token: gift.token, state: gift.state }));
  return { made, opened, waiting, latest };
}

function useCounts(): { state: CountsState; reload: () => void } {
  const [state, setState] = useState<CountsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    readCounts().then(
      (counts) => {
        if (!cancelled) setState({ status: "ready", counts });
      },
      () => {
        if (!cancelled) setState({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);
  return { state, reload };
}

type Symbols = ReadonlyMap<string, string>;

// Token address (lower case) to stock symbol. The symbol is shown as plain text only.
function parseSymbols(body: unknown): Symbols | null {
  const list = typeof body === "object" && body !== null ? (body as { stocks?: unknown }).stocks : null;
  if (!Array.isArray(list)) return null;
  const found = new Map<string, string>();
  for (const row of list as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { address, symbol } = row as Record<string, unknown>;
    if (typeof address === "string" && typeof symbol === "string") found.set(address.toLowerCase(), symbol.slice(0, 16));
  }
  return found;
}

async function fetchSymbols(): Promise<Symbols | null> {
  try {
    const response = await fetch("/api/stocks", { signal: AbortSignal.timeout(STOCKS_TIMEOUT_MS), headers: { accept: "application/json" } });
    return response.ok ? parseSymbols(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Null while loading. When /api/stocks cannot be reached it is an empty map, so rows show a shortened token address instead. */
function useSymbols(): Symbols | null {
  const [symbols, setSymbols] = useState<Symbols | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retry = 0;
    const settle = (found: Symbols | null) => {
      if (!cancelled) setSymbols(found ?? new Map());
    };
    void fetchSymbols().then((found) => {
      if (found !== null) {
        settle(found);
        return;
      }
      retry = window.setTimeout(() => void fetchSymbols().then(settle), STOCKS_RETRY_MS);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, []);

  return symbols;
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * One big number. The digits are written straight into the element on every animation frame, so
 * React does not re-render while it counts. Under reduced motion the final value is there at once.
 */
function Figure({ value, label, play, reduced }: { value: number; label: string; play: boolean; reduced: boolean }) {
  const digits = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = digits.current;
    if (!node) return;
    if (reduced) {
      node.textContent = String(value);
      return;
    }
    if (!play) return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      node.textContent = String(Math.round(value * easeOutCubic(progress)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, play, reduced]);

  return (
    <div className="live-item">
      <p className="live-figure">
        <span ref={digits} aria-hidden="true">
          {reduced ? value : 0}
        </span>
        <span className="sr-only">{value}</span>
      </p>
      <p className="sec-label live-caption">{label}</p>
    </div>
  );
}

function SkeletonFigure({ label }: { label: string }) {
  return (
    <div className="live-item">
      <span className="skeleton-line live-skeleton" aria-label="Loading" />
      <p className="sec-label live-caption">{label}</p>
    </div>
  );
}

const CHIPS: Readonly<Record<number, { text: string; tone: string }>> = {
  [STATE_OPEN]: { text: "WAITING", tone: "waiting" },
  [STATE_CLAIMED]: { text: "OPENED", tone: "opened" },
  [STATE_REFUNDED]: { text: "TAKEN BACK", tone: "taken-back" },
};

/** The newest gifts straight from the same chain read as the numbers, newest first. */
function LatestGifts({ state, symbols, play, reduced }: { state: CountsState; symbols: Symbols | null; play: boolean; reduced: boolean }) {
  const gifts = state.status === "ready" ? state.counts.latest.filter((gift) => CHIPS[gift.state] !== undefined) : null;
  if (gifts !== null && gifts.length === 0) return null;

  return (
    <div className="latest" data-motion={reduced ? undefined : "on"} data-play={play ? "true" : undefined}>
      <p className="sec-label" id="latest-label">
        LATEST GIFTS
      </p>
      <ol className="latest-list" aria-labelledby="latest-label" aria-busy={gifts === null || symbols === null}>
        {gifts !== null && symbols !== null
          ? gifts.map((gift, index) => {
              const chip = CHIPS[gift.state];
              return (
                <li className="latest-row latest-row-live" key={gift.id} style={{ "--i": index } as CSSProperties}>
                  <span className="latest-id">#{gift.id}</span>
                  <span className="latest-symbol">{symbols.get(gift.token.toLowerCase()) ?? shortHex(gift.token)}</span>
                  <span className={`latest-chip latest-chip-${chip?.tone}`}>{chip?.text}</span>
                </li>
              );
            })
          : Array.from({ length: LATEST_ROWS }, (_, index) => (
              <li className="latest-row" key={index}>
                <span className="skeleton-line latest-skeleton" aria-label="Loading" />
              </li>
            ))}
      </ol>
    </div>
  );
}

export function LiveNumbers() {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { state, reload } = useCounts();
  const symbols = useSymbols();
  const band = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = band.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: VISIBLE_FRACTION },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="live" ref={band} aria-labelledby="live-label">
      <div className="live-rule" aria-hidden="true" />
      <div className="live-inner">
        <p className="sec-label" id="live-label">
          LIVE ON BNB CHAIN
        </p>
        <div className="live-body">
          {state.status === "failed" ? (
            <div className="live-failed">
              <p className="live-failed-text">Could not reach BNB Chain just now.</p>
              <button type="button" className="gold-link live-retry" onClick={reload}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="live-row">
                {state.status === "ready" ? (
                  <>
                    <Figure value={state.counts.made} label="GIFTS MADE" play={visible} reduced={reduced} />
                    <Figure value={state.counts.opened} label="OPENED" play={visible} reduced={reduced} />
                    <Figure value={state.counts.waiting} label="WAITING TO BE OPENED" play={visible} reduced={reduced} />
                  </>
                ) : (
                  <>
                    <SkeletonFigure label="GIFTS MADE" />
                    <SkeletonFigure label="OPENED" />
                    <SkeletonFigure label="WAITING TO BE OPENED" />
                  </>
                )}
              </div>
              <LatestGifts state={state} symbols={symbols} play={visible} reduced={reduced} />
            </>
          )}
        </div>
        <p className="live-source">
          Read live from the Moi vault{" "}
          <a className="draw-link" href={addressCodeUrl(VAULT)} target="_blank" rel="noopener noreferrer">
            {shortHex(VAULT)}
          </a>{" "}
          · source verified
        </p>
      </div>
      <Grain />
    </section>
  );
}
