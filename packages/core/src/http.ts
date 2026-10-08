import type { Address, PublicClient } from "viem";
import { handleClaim } from "./claim.js";
import { parseGiftId } from "./gift.js";
import { canonicalClientIp, handleJudgeClaim, hashClientId } from "./judge.js";
import type { verifyPrivyAccessToken } from "./privy.js";
import { handleQuote } from "./quote.js";
import type { createRelayer } from "./relayer.js";
import { handleGiftStatus } from "./status.js";
import { handleStocks, type GiftStock, type StocksDeps } from "./stocks.js";
import { keys, type KvStore } from "./store.js";
import type { Web3Api } from "./web3api.js";
import { handleWrap, PAYMENT_SIGNATURE_HEADER } from "./wrap.js";

/**
 * One request as every Moi endpoint sees it, whichever server received it. `path` is the path
 * only, without a query string. `clientIp`, `country` and `region` come from clientFromHeaders,
 * never from a value the caller chose.
 */
export type MoiRequest = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  clientIp: string | null;
  country: string | null;
  region: string | null;
};

export type MoiResponse = { status: number; headers: Record<string, string>; body: string };

/** Everything the dispatcher hands to the handlers. createServerDeps builds it from server config. */
export type ServerDeps = {
  client: PublicClient;
  /** Quotes and the stock list, with the Web3 API client's default 10-second timeout. */
  api: Web3Api;
  /** b402 for the wrap route only, with a 25-second timeout per call. */
  wrapApi: Web3Api;
  store: KvStore;
  /** "upstash" for the shared store; "memory" only when MOI_ALLOW_MEMORY_STORE=1 (C38). */
  storeKind: "upstash" | "memory";
  relayer: ReturnType<typeof createRelayer>;
  vault: Address;
  payTo: Address;
  sponsor: Address | null;
  origin: string;
  wrapPriceUsd: string;
  /** Null when MOI_JUDGE_POOL is unset, which closes POST /api/judge (503 judge_gifts_closed). */
  judge: { seed: `0x${string}`; pool: Map<bigint, number> } | null;
  privyAppId: string | null;
  /** The key every client address and user id is hashed under before it is stored or logged (C46). */
  clientHashKey: `0x${string}`;
  getStocks: (deps: StocksDeps) => Promise<GiftStock[]>;
  devAllowUnknownCountry: boolean;
  verifyAccessToken?: typeof verifyPrivyAccessToken;
  /** Milliseconds since the epoch, for rate-limit windows and log times. Date.now by default. */
  now?: () => number;
  /** Receives one JSON line per refusal. console.log by default. */
  log?: (line: string) => void;
};

/** The largest request body any route accepts, in UTF-8 bytes (C23). */
export const MAX_BODY_BYTES = 8 * 1024;

const WINDOW_MS = 60_000;
// Two windows, so a counter outlives its own minute and then disappears on its own.
const COUNTER_TTL_SECONDS = 120;
const CLIENT_POST_LIMIT = 30n;
const CLIENT_GET_LIMIT = 120n;
const GLOBAL_LIMIT = 600n;
// The longest path in the table is /api/wrap/ and a 78-digit id. Far longer is not one of ours.
const MAX_PATH_CHARS = 128;
// A canonical address never reads "unknown", so callers without one share this bucket and no other.
const UNKNOWN_CLIENT = "unknown";

const FIXED_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;
const FIXED_NAMES: ReadonlySet<string> = new Set(Object.keys(FIXED_HEADERS).map((n) => n.toLowerCase()));
// An RFC 9110 token for the name; printable ASCII and space for the value, so no CR or LF can ever
// start a header of its own.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,16384}$/;
const ERROR_CODE = /^[a-z_]{1,48}$/;
const INTERNAL = { ok: false, error: "internal" } as const;

/**
 * A JSON response with the fixed headers: Content-Type application/json, Cache-Control no-store
 * and X-Content-Type-Options nosniff. `extraHeaders` go out exactly as named, except that a name
 * matching a fixed header in any letter case is dropped, so no handler can override those.
 * Throws on a status outside 200 to 599, an extra header that is not a token name with a printable
 * value, the same header named twice, or a body JSON cannot write; route answers 500 for those.
 */
export function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): MoiResponse {
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new RangeError("A response status must be a whole number from 200 to 599.");
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || typeof value !== "string" || !HEADER_VALUE.test(value) || seen.has(lower)) {
      throw new Error("A handler returned a header that cannot be sent.");
    }
    seen.add(lower);
    if (!FIXED_NAMES.has(lower)) headers[name] = value;
  }
  const text = JSON.stringify(body);
  if (typeof text !== "string") throw new TypeError("The response body is not JSON.");
  return { status, headers: { ...headers, ...FIXED_HEADERS }, body: text };
}

// One spelling per header. Two keys that differ only in letter case are ambiguous, so neither is
// trusted (fail closed).
function headerValue(headers: Record<string, string | undefined> | undefined, name: string): string | null {
  if (typeof headers !== "object" || headers === null) return null;
  const wanted = name.toLowerCase();
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || typeof value !== "string") continue;
    if (found !== null) return null;
    found = value;
  }
  return found;
}

/**
 * The caller's address and place, from the hosting platform only (C23, C30).
 * - "vercel": the address from x-real-ip, which Vercel sets and overwrites, never from
 *   x-forwarded-for; the country from x-vercel-ip-country and the ISO 3166-2 region from
 *   x-vercel-ip-country-region.
 * - "local": the socket address `local.socketIp` and the country `local.devCountry`
 *   (MOI_DEV_COUNTRY), with no region. No request header is read.
 * The address goes through judge.ts canonicalClientIp, so one network has one spelling; anything
 * it refuses is null, which the rate limiter counts as the shared "unknown" bucket. A missing
 * country is null, which every place-gated handler refuses unless devAllowUnknownCountry is set.
 * Any other platform gets all nulls.
 */
export function clientFromHeaders(
  headers: Record<string, string | undefined>,
  platform: "vercel" | "local",
  local: { socketIp?: string | null; devCountry?: string | null } = {},
): { clientIp: string | null; country: string | null; region: string | null } {
  if (platform === "vercel") {
    return {
      clientIp: canonicalClientIp(headerValue(headers, "x-real-ip")),
      country: headerValue(headers, "x-vercel-ip-country"),
      region: headerValue(headers, "x-vercel-ip-country-region"),
    };
  }
  if (platform === "local") {
    const country = typeof local?.devCountry === "string" && local.devCountry.trim() !== "" ? local.devCountry.trim() : null;
    return { clientIp: canonicalClientIp(local?.socketIp ?? null), country, region: null };
  }
  return { clientIp: null, country: null, region: null };
}

type RouteName = "/api/stocks" | "/api/quote" | "/api/gift/:id" | "/api/claim" | "/api/wrap/:id" | "/api/judge";
type RouteSpec = { name: RouteName; method: "GET" | "POST" };

const EXACT_ROUTES: ReadonlyMap<string, RouteSpec> = new Map<string, RouteSpec>([
  ["/api/stocks", { name: "/api/stocks", method: "GET" }],
  ["/api/quote", { name: "/api/quote", method: "POST" }],
  ["/api/claim", { name: "/api/claim", method: "POST" }],
  ["/api/judge", { name: "/api/judge", method: "POST" }],
]);
const ID_ROUTES: readonly (RouteSpec & { prefix: string })[] = [
  { prefix: "/api/gift/", name: "/api/gift/:id", method: "GET" },
  { prefix: "/api/wrap/", name: "/api/wrap/:id", method: "POST" },
];

// WHY a fixed table (C20): the path picks one of six entries and nothing else. The only part of a
// path that reaches a handler is an id segment, and only after parseGiftId accepts it.
function matchRoute(path: unknown): { spec: RouteSpec; idText: string | null } | null {
  if (typeof path !== "string" || path.length > MAX_PATH_CHARS) return null;
  const exact = EXACT_ROUTES.get(path);
  if (exact !== undefined) return { spec: exact, idText: null };
  for (const r of ID_ROUTES) if (path.startsWith(r.prefix)) return { spec: r, idText: path.slice(r.prefix.length) };
  return null;
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> | undefined; publicCache?: boolean };

const refuse = (status: number, error: string, headers?: Record<string, string>): Answer => ({ status, body: { ok: false, error }, headers });

// A UTF-16 string is never fewer bytes in UTF-8 than it has code units, so an over-long string is
// refused before anything is encoded.
function tooLarge(body: string): boolean {
  return body.length > MAX_BODY_BYTES || new TextEncoder().encode(body).length > MAX_BODY_BYTES;
}

function parseJson(body: string | null): { ok: true; value: unknown } | { ok: false } {
  if (typeof body !== "string" || body.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

/**
 * C23: fixed one-minute windows, counted in the store before any handler runs. Per client (the
 * keyed hash of its platform address, or of "unknown", C46) 30 POSTs and 120 GETs a minute, each in its own
 * counter; then 600 requests a minute across everyone. A client already over its own limit is
 * refused without touching the global counter, so one noisy caller cannot spend everyone's budget
 * on its own refusals. A store that fails or answers something other than a count refuses (502
 * store_unavailable, fail closed). Does not cover a caller with many addresses, which only the
 * global limit bounds.
 */
async function rateLimit(deps: ServerDeps, clientHash: `0x${string}`, method: "GET" | "POST"): Promise<Answer | null> {
  const nowMs = (deps.now ?? Date.now)();
  const minute = Math.floor(nowMs / WINDOW_MS);
  const retryAfter = String(Math.max(1, Math.ceil((minute * WINDOW_MS + WINDOW_MS - nowMs) / 1000)));
  const clientKey = keys.rateLimit("client", clientHash, `${method === "POST" ? "post" : "get"}-${minute}`);
  const globalKey = keys.rateLimit("global", "", String(minute));
  const limited = refuse(429, "rate_limited", { "Retry-After": retryAfter });
  const count = async (k: typeof clientKey): Promise<bigint> => {
    const total = await deps.store.incrBy(k, 1n, COUNTER_TTL_SECONDS);
    if (typeof total !== "bigint") throw new Error("the store answered a count that is not a whole number");
    return total;
  };
  try {
    if ((await count(clientKey)) > (method === "POST" ? CLIENT_POST_LIMIT : CLIENT_GET_LIMIT)) return limited;
    if ((await count(globalKey)) > GLOBAL_LIMIT) return limited;
  } catch {
    return refuse(502, "store_unavailable");
  }
  return null;
}

type Seen = { route: RouteName | "unmatched"; ipTag: string };

async function dispatch(deps: ServerDeps, req: MoiRequest, seen: Seen): Promise<Answer> {
  const ip = canonicalClientIp(req.clientIp);
  const clientHash = await hashClientId(deps.clientHashKey, ip ?? UNKNOWN_CLIENT);
  seen.ipTag = clientHash.slice(2, 10);

  const matched = matchRoute(req.path);
  if (matched === null) return refuse(404, "not_found");
  seen.route = matched.spec.name;
  if (req.method !== matched.spec.method) return refuse(405, "method_not_allowed", { Allow: matched.spec.method });
  let giftId: bigint | null = null;
  if (matched.idText !== null) {
    try {
      giftId = parseGiftId(matched.idText);
    } catch {
      return refuse(404, "not_found");
    }
  }
  const body = typeof req.body === "string" ? req.body : null;
  if (body !== null && tooLarge(body)) return refuse(413, "body_too_large");

  const limited = await rateLimit(deps, clientHash, matched.spec.method);
  if (limited !== null) return limited;

  // C30: the place every gated handler judges is the platform's, never a request field.
  const ctx = { country: req.country ?? null, region: req.region ?? null, clientIp: ip };
  const devAllowUnknownCountry = deps.devAllowUnknownCountry === true;
  const idText = giftId === null ? "" : giftId.toString();

  switch (matched.spec.name) {
    case "/api/stocks": {
      const res = await handleStocks({ client: deps.client, vault: deps.vault, api: deps.api, getStocks: deps.getStocks });
      // C23: only a good list may sit in a shared cache; an error or a refusal never does.
      return { status: res.status, body: res.body, publicCache: res.status === 200 };
    }
    case "/api/gift/:id": {
      const res = await handleGiftStatus({ client: deps.client, vault: deps.vault }, idText);
      return { status: res.status, body: res.body };
    }
    case "/api/wrap/:id": {
      const res = await handleWrap(
        { api: deps.wrapApi, client: deps.client, vault: deps.vault, store: deps.store, origin: deps.origin, payTo: deps.payTo, priceUsd: deps.wrapPriceUsd },
        idText,
        headerValue(req.headers, PAYMENT_SIGNATURE_HEADER),
      );
      return { status: res.status, body: res.body, headers: res.headers };
    }
    case "/api/quote": {
      const parsed = parseJson(body);
      if (!parsed.ok) return refuse(400, "bad_json");
      const res = await handleQuote({ api: deps.api, client: deps.client, vault: deps.vault, devAllowUnknownCountry }, parsed.value, ctx);
      return { status: res.status, body: res.body };
    }
    case "/api/claim": {
      const parsed = parseJson(body);
      if (!parsed.ok) return refuse(400, "bad_json");
      const res = await handleClaim(
        { client: deps.client, vault: deps.vault, relayer: deps.relayer, store: deps.store, sponsor: deps.sponsor, devAllowUnknownCountry },
        parsed.value,
        ctx,
      );
      return { status: res.status, body: res.body };
    }
    case "/api/judge": {
      // C26: without a pool there is nothing to hand out, so the route is closed before any work.
      if (deps.judge === null || deps.privyAppId === null) return refuse(503, "judge_gifts_closed");
      const parsed = parseJson(body);
      if (!parsed.ok) return refuse(400, "bad_json");
      const res = await handleJudgeClaim(
        {
          client: deps.client,
          vault: deps.vault,
          relayer: deps.relayer,
          store: deps.store,
          judgeSeed: deps.judge.seed,
          pool: deps.judge.pool,
          privyAppId: deps.privyAppId,
          clientHashKey: deps.clientHashKey,
          verifyAccessToken: deps.verifyAccessToken,
        },
        parsed.value,
        { ...ctx, clientIp: ip ?? "", devAllowUnknownCountry },
      );
      return { status: res.status, body: res.body };
    }
  }
}

function errorCodeOf(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && ERROR_CODE.test(error) ? error : null;
}

// C19: one line per refusal, built only from fixed route names, the status, a fixed error code and
// eight hex characters of the address hash. No body, header value, address or key ever reaches it.
function logRefusal(deps: ServerDeps, seen: Seen, status: number, error: string | null): void {
  try {
    const line = JSON.stringify({ t: new Date((deps.now ?? Date.now)()).toISOString(), route: seen.route, status, error, ip: seen.ipTag });
    (deps.log ?? ((l: string) => console.log(l)))(line);
  } catch {
    // A broken logger must not change the answer.
  }
}

/**
 * The single dispatcher for every Moi endpoint, the same for the local server and the website.
 * Fixed table, matched exactly: GET /api/stocks, POST /api/quote, GET /api/gift/<id>, POST
 * /api/claim, POST /api/wrap/<id>, POST /api/judge. In order, answering with the first that applies:
 * 1. a path not in the table, or an id that gift.ts parseGiftId refuses: 404 not_found;
 * 2. a known path with another method: 405 method_not_allowed with an Allow header;
 * 3. a body over 8 KB of UTF-8, checked before any parse: 413 body_too_large;
 * 4. the rate limits above: 429 rate_limited with Retry-After, or 502 store_unavailable;
 * 5. POST /api/judge without a judge pool: 503 judge_gifts_closed;
 * 6. a JSON body that is empty or does not parse (quote, claim, judge): 400 bad_json;
 * 7. the handler, with ctx {country, region, clientIp} from the request. The wrap route gets the
 *    PAYMENT-SIGNATURE header and its own headers go back out unchanged.
 * Every response carries the fixed headers of `json`; only a 200 from GET /api/stocks is
 * "public, max-age=30". Anything that throws becomes 500 {ok: false, error: "internal"} (C19).
 * Every status of 400 or more is logged as one JSON line {t, route, status, error, ip}, where ip
 * is eight hex characters of the keyed address hash (C46). Never throws.
 */
export async function route(deps: ServerDeps, req: MoiRequest): Promise<MoiResponse> {
  const seen: Seen = { route: "unmatched", ipTag: "none" };
  let answer: Answer;
  let response: MoiResponse;
  try {
    answer = await dispatch(deps, req, seen);
    response = json(answer.status, answer.body, answer.headers);
    if (answer.publicCache === true) response.headers["Cache-Control"] = "public, max-age=30";
  } catch {
    answer = { status: 500, body: INTERNAL };
    response = json(500, INTERNAL);
  }
  if (response.status >= 400) logRefusal(deps, seen, response.status, errorCodeOf(answer.body));
  return response;
}
