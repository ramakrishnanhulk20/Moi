import { useSyncExternalStore } from "react";
import { isAddress, type Address } from "viem";

/**
 * One stock from GET /api/stocks. `market.open` is null when Binance has no market status for the
 * token, and `nextOpenTime` is a Unix time when it is known (the upstream docs do not say whether
 * seconds or milliseconds, so the picker accepts either).
 */
export type Stock = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  market: { open: boolean | null; nextOpenTime: number | null };
  logoUrl: string | null;
};

export type StocksState =
  | { status: "loading" }
  | { status: "ready"; stocks: readonly Stock[] }
  | { status: "failed" };

type ShareFigure = { state: "loading" } | { state: "ready"; text: string } | { state: "hidden" };

const LOADING: StocksState = { status: "loading" };
const FAILED: StocksState = { status: "failed" };
const REQUEST_TIMEOUT_MS = 20_000;
// One more try after a failure, because the server's first boot can take a few seconds.
const RETRY_DELAY_MS = 5_000;
const SHARE_SYMBOL = "NVDAB";
// Display only: the on-chain name with its legal suffix stripped, so "NVIDIA Corp" reads "NVIDIA".
const NAME_SUFFIXES = [" (bStocks)", " Corporation", " Platforms", " Corp", " Inc.", " Inc"];

let current: StocksState = LOADING;
let started = false;
const listeners = new Set<() => void>();

function publish(next: StocksState): void {
  current = next;
  listeners.forEach((listener) => listener());
}

// A logo is used only when it is an https address on Binance's own static host (C14).
function safeLogo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".bnbstatic.com") ? url.href : null;
  } catch {
    return null;
  }
}

// The text fields are shown as plain text only, and a price that is not a positive number is dropped.
function parseStocks(body: unknown): Stock[] | null {
  if (typeof body !== "object" || body === null) return null;
  const list = (body as { stocks?: unknown }).stocks;
  if (!Array.isArray(list)) return null;
  const stocks: Stock[] = [];
  for (const row of list as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { address, symbol, name, decimals, priceUsd, market, logoUrl } = row as Record<string, unknown>;
    if (typeof address !== "string" || !isAddress(address)) continue;
    if (typeof symbol !== "string" || typeof name !== "string") continue;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) continue;
    const price = typeof priceUsd === "string" ? Number(priceUsd) : Number.NaN;
    const { open, nextOpenTime } = (typeof market === "object" && market !== null ? market : {}) as Record<string, unknown>;
    stocks.push({
      address,
      symbol,
      name,
      decimals,
      priceUsd: Number.isFinite(price) && price > 0 ? price : null,
      market: {
        open: typeof open === "boolean" ? open : null,
        nextOpenTime: typeof nextOpenTime === "number" && Number.isFinite(nextOpenTime) && nextOpenTime > 0 ? nextOpenTime : null,
      },
      logoUrl: safeLogo(logoUrl),
    });
  }
  return stocks;
}

async function fetchStocks(): Promise<Stock[] | null> {
  try {
    const response = await fetch("/api/stocks", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return parseStocks(await response.json());
  } catch {
    return null;
  }
}

async function load(): Promise<void> {
  let stocks = await fetchStocks();
  if (stocks === null) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    stocks = await fetchStocks();
  }
  publish(stocks === null ? FAILED : { status: "ready", stocks });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void load();
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The live stock list from GET /api/stocks, fetched once and shared by every component on the page. */
export function useStocks(): StocksState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => LOADING,
  );
}

/** The on-chain name with legal suffixes removed: "Tesla, Inc." becomes "Tesla". */
export function displayName(name: string): string {
  let text = name.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of NAME_SUFFIXES) {
      if (text.endsWith(suffix) && text.length > suffix.length) {
        text = text.slice(0, -suffix.length).trimEnd();
        changed = true;
      }
    }
    // "Tesla, Inc." leaves a comma behind once the suffix is gone.
    if (text.endsWith(",") && text.length > 1) {
      text = text.slice(0, -1).trimEnd();
      changed = true;
    }
  }
  return text;
}

/** The display name uppercased for the ticker: "NVIDIA Corp" becomes "NVIDIA". */
function tickerName(name: string): string {
  return displayName(name).toUpperCase();
}

/** A price rounded to 2 decimals with thousands separators, for example 1,234.50. */
function formatPrice(price: number): string {
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type TickerEntry = { symbol: string; name: string; price: string };

/** One entry per stock that has a live price. A stock without a price is left out, never guessed. */
export function tickerEntries(stocks: readonly Stock[]): TickerEntry[] {
  const entries: TickerEntry[] = [];
  for (const stock of stocks) {
    if (stock.priceUsd === null) continue;
    entries.push({ symbol: stock.symbol, name: tickerName(stock.name), price: formatPrice(stock.priceUsd) });
  }
  return entries;
}

/** How many NVDAB shares one dollar buys at the live price: 1 / priceUsd, to four decimals. */
export function useShareFigure(): ShareFigure {
  const state = useStocks();
  if (state.status === "loading") return { state: "loading" };
  if (state.status === "failed") return { state: "hidden" };
  const price = state.stocks.find((stock) => stock.symbol === SHARE_SYMBOL)?.priceUsd ?? null;
  if (price === null) return { state: "hidden" };
  return { state: "ready", text: (1 / price).toFixed(4) };
}
