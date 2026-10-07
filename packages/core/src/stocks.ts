import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { z } from "zod";
import { CHAIN_ID, readTokenInfo, UI_MULTIPLIER_ONE } from "./chain.js";
import { readListedTokens } from "./vault.js";
import type { Web3Api } from "./web3api.js";

/**
 * One stock a sender can gift. Every address, decimals and multiplier is read from chain; price,
 * market status and logo come from the RWA Data API and are null when it has nothing for the token.
 * Text fields are plain text, at most 64 characters, and must be rendered as text only (C14).
 */
export type GiftStock = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  uiMultiplier: string;
  priceUsd: string | null;
  market: { open: boolean | null; reasonCode: string | null; reasonMsg: string | null; nextOpenTime: number | null };
  logoUrl: string | null;
};

export type StocksDeps = { client: PublicClient; vault: Address; api: Web3Api };

export type StocksResponse =
  | { status: 200; body: { stocks: GiftStock[]; asOf: number } }
  | { status: 502; body: { ok: false; error: "upstream_unavailable" } };

const CHAIN = String(CHAIN_ID);
const TEXT_MAX = 64;
const LOGO_URL_MAX = 512;
// The price endpoint takes at most 100 addresses in one call; the vault itself caps its list at 32.
const MAX_TOKENS = 100;
// The keyed list held 488 rows for chain 56 on 2026-10-07. Far more than that is not a real answer.
const MAX_ROWS = 5_000;
const PRICE_TEXT = /^\d{1,40}(\.\d{1,40})?$/;
const LOGO_HOST = "bnbstatic.com";

const nameAbi = parseAbi(["function name() view returns (string)"]);
const rowList = z.array(z.unknown()).max(MAX_ROWS);

type Row = Record<string, unknown>;

/** The RWA Data API answered with something other than a list of rows. */
export class StocksUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StocksUpstreamError";
  }
}

/**
 * Upstream or token-contract text cut to 64 characters and kept as plain text (C14, standard 3):
 * nothing is escaped or parsed, so the consumer must render it as text. Null for a non-string.
 */
// Cut by code points so an emoji is never split into half a surrogate pair. The first slice
// bounds the work on an oversized string before Array.from walks it.
export function clipText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Array.from(value.slice(0, TEXT_MAX * 4)).slice(0, TEXT_MAX).join("");
}

// C14: the standard URL parser decides the scheme and host, never a prefix or regex match on the
// raw text. Covers "https on bnbstatic.com or a subdomain of it". Does not cover what that host
// serves. The parser's own href is returned so the consumer gets exactly what was checked.
function safeLogoUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > LOGO_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== LOGO_HOST && !url.hostname.endsWith(`.${LOGO_HOST}`)) return null;
  return url.href;
}

function parseRows(data: unknown, what: string): Row[] {
  const parsed = rowList.safeParse(data);
  if (!parsed.success) throw new StocksUpstreamError(`${what} did not return a list`);
  return parsed.data.filter((r): r is Row => typeof r === "object" && r !== null && !Array.isArray(r));
}

// Rows are matched with getAddress on both sides (standard 2). A token listed twice for chain 56
// is ambiguous, so it gets null, the same as a token the API does not know.
function indexRows(rows: Row[], wanted: ReadonlySet<Address>): Map<Address, Row | null> {
  const found = new Map<Address, Row | null>();
  for (const row of rows) {
    if (row.binanceChainId !== CHAIN || typeof row.tokenContractAddress !== "string") continue;
    let address: Address;
    try {
      address = getAddress(row.tokenContractAddress);
    } catch {
      continue;
    }
    if (!wanted.has(address)) continue;
    found.set(address, found.has(address) ? null : row);
  }
  return found;
}

function priceOf(row: Row | null | undefined): string | null {
  const p = row?.tokenPrice;
  return typeof p === "string" && p.length <= TEXT_MAX && PRICE_TEXT.test(p) ? p : null;
}

function marketOf(row: Row | null | undefined): GiftStock["market"] {
  const s = row?.statusInfo;
  if (typeof s !== "object" || s === null) return { open: null, reasonCode: null, reasonMsg: null, nextOpenTime: null };
  const { openState, reasonCode, reasonMsg, nextOpenTime } = s as Row;
  return {
    open: typeof openState === "boolean" ? openState : null,
    reasonCode: clipText(reasonCode),
    reasonMsg: clipText(reasonMsg),
    nextOpenTime: typeof nextOpenTime === "number" && Number.isSafeInteger(nextOpenTime) && nextOpenTime >= 0 ? nextOpenTime : null,
  };
}

async function readStock(client: PublicClient, token: Address) {
  const [info, name] = await Promise.all([
    readTokenInfo(token, client),
    client.readContract({ address: token, abi: nameAbi, functionName: "name" }),
  ]);
  return { info, name };
}

/**
 * The stocks a sender can gift, in the vault's own order. The token list comes only from
 * vault.listedTokens() on chain (C22); no API row can add a token. For each token, symbol, name,
 * decimals and uiMultiplier come from the token contract (a token without uiMultiplier counts as
 * 1e18, one token per share). priceUsd is tokenPrice from one batched /rwa/price call, the same
 * figure the quote's price band uses. market and logoUrl come from /rwa/tokens for bStocks on chain
 * 56. A token missing from either API list, or listed twice, gets nulls there, never an error.
 * Logos are kept only for https on bnbstatic.com or a subdomain (C14). Text is cut to 64
 * characters. Throws when the vault, a token contract or either API call fails, or an API answer
 * is not a list; every call has a timeout (5 s RPC and 10 s API by default, C23).
 */
export async function getGiftableStocks(deps: StocksDeps): Promise<GiftStock[]> {
  const { client, vault, api } = deps;
  const tokens = await readListedTokens(client, vault);
  if (tokens.length === 0) return [];
  if (tokens.length > MAX_TOKENS) throw new StocksUpstreamError("the vault lists more tokens than one price call can carry");
  const wanted = new Set(tokens);

  const [onChain, priceData, tokenData] = await Promise.all([
    Promise.all(tokens.map((t) => readStock(client, t))),
    api.get("/api/v1/dex/market/rwa/price", { binanceChainId: CHAIN, tokenContractAddresses: tokens.join(",") }),
    api.get("/api/v1/dex/market/rwa/tokens", { binanceChainId: CHAIN, platformId: "bstock" }),
  ]);
  const prices = indexRows(parseRows(priceData, "rwa/price"), wanted);
  const listed = indexRows(parseRows(tokenData, "rwa/tokens"), wanted);

  return tokens.map((address, i) => {
    const { info, name } = onChain[i]!;
    const row = listed.get(address);
    return {
      address,
      symbol: clipText(info.symbol) ?? "",
      name: clipText(name) ?? "",
      decimals: info.decimals,
      uiMultiplier: (info.uiMultiplier ?? UI_MULTIPLIER_ONE).toString(),
      priceUsd: priceOf(prices.get(address)),
      market: marketOf(row),
      logoUrl: safeLogoUrl(row?.tokenLogoUrl),
    };
  });
}

/**
 * Wraps getGiftableStocks in a short cache (C23), so traffic to /api/stocks cannot spend the Web3
 * API quota or the RPC. Inside `ttlMs` of a successful fetch for the same vault, the stored list is
 * served from memory. Calls that arrive while a fetch is running share that one fetch, so two
 * fetches for one vault never run at once. A failed fetch is not stored; the next call tries again.
 * Throws at creation when ttlMs is not a whole number from 1 to 3,600,000.
 */
export function createStocksCache(ttlMs = 60_000): (deps: StocksDeps) => Promise<GiftStock[]> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3_600_000) {
    throw new Error("ttlMs must be a whole number of milliseconds from 1 to 3600000.");
  }
  // Keyed by the configured vault, which comes from server config and never from a request.
  const stored = new Map<Address, { stocks: GiftStock[]; at: number }>();
  const running = new Map<Address, Promise<GiftStock[]>>();

  return async (deps) => {
    const vault = getAddress(deps.vault);
    const hit = stored.get(vault);
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.stocks;
    const current = running.get(vault);
    if (current !== undefined) return current;
    const fetching = getGiftableStocks({ ...deps, vault })
      .then((stocks) => {
        stored.set(vault, { stocks, at: Date.now() });
        return stocks;
      })
      .finally(() => running.delete(vault));
    running.set(vault, fetching);
    return fetching;
  };
}

/**
 * The /api/stocks handler, framework free. `getStocks` is normally a createStocksCache function
 * made once per server process; it defaults to an uncached getGiftableStocks. asOf is when this
 * response was assembled, in milliseconds; a cached list can be up to the cache TTL older.
 * Never throws and never returns upstream or chain text (C19): any failure is 502
 * upstream_unavailable.
 */
export async function handleStocks(
  deps: StocksDeps & { getStocks?: (deps: StocksDeps) => Promise<GiftStock[]>; now?: () => number },
): Promise<StocksResponse> {
  try {
    const getStocks = deps.getStocks ?? getGiftableStocks;
    const stocks = await getStocks({ client: deps.client, vault: deps.vault, api: deps.api });
    return { status: 200, body: { stocks, asOf: (deps.now ?? Date.now)() } };
  } catch {
    return { status: 502, body: { ok: false, error: "upstream_unavailable" } };
  }
}
