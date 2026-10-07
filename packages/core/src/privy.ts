import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JWK, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { getAddress, type Address } from "viem";
import { z } from "zod";

/** Every reason a Privy identity token is refused. The message for each is fixed text. */
export type PrivyTokenErrorKind =
  | "bad_config"
  | "malformed"
  | "keys_unavailable"
  | "expired"
  | "invalid"
  | "bad_claims"
  | "guest_account";

const MESSAGES: Record<PrivyTokenErrorKind, string> = {
  bad_config: "The Privy app id or key set address is not usable.",
  malformed: "The identity token is not a well-formed token.",
  keys_unavailable: "Privy's signing keys could not be loaded.",
  expired: "The identity token has expired.",
  invalid: "The identity token did not verify.",
  bad_claims: "The identity token's user data is not readable.",
  guest_account: "Guest accounts cannot receive a judge gift.",
};

/**
 * Thrown for every refusal. The message is fixed per kind and never carries the token, its claims
 * or any text from Privy (C19), and no underlying error is attached as a cause for the same reason.
 */
export class PrivyTokenError extends Error {
  readonly kind: PrivyTokenErrorKind;
  constructor(kind: PrivyTokenErrorKind) {
    super(MESSAGES[kind]);
    this.name = "PrivyTokenError";
    this.kind = kind;
  }
}

// From Privy's docs (identity tokens, access tokens) and its own Node SDK 0.35.0 (lib/auth.mjs):
// ES256 only, issuer "privy.io", audience the app id, header typ "JWT".
const ALGORITHM = "ES256";
const ISSUER = "privy.io";
const CLOCK_SKEW_SECONDS = 60;
const KEY_CACHE_MS = 10 * 60 * 1000;
const KEY_REFETCH_MIN_MS = 60 * 1000;
const KEY_FETCH_TIMEOUT_MS = 5_000;
// Privy's key set is two P-256 keys in about 420 bytes. Anything far larger is not Privy's.
const MAX_KEY_SET_BYTES = 16_384;
const MAX_KEY_SET_URLS = 16;
// The judge route caps the token at the same length, so nothing longer reaches the parser.
const MAX_TOKEN_CHARS = 4096;
const MAX_LINKED_ACCOUNTS = 64;

const APP_ID_TEXT = /^[A-Za-z0-9]{1,64}$/;
const JWT_TEXT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const USER_ID_TEXT = /^did:privy:[A-Za-z0-9]{1,128}$/;

const keySetSchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.string().max(16),
        crv: z.string().max(16).optional(),
        x: z.string().max(128).optional(),
        y: z.string().max(128).optional(),
        kid: z.string().max(256).optional(),
        alg: z.string().max(16).optional(),
        use: z.string().max(16).optional(),
      }),
    )
    .min(1)
    .max(16),
});

/**
 * The key set Privy's own Node SDK reads (`${apiUrl}/v1/apps/${appId}/jwks.json`, apiUrl
 * https://api.privy.io). The docs pages do not print this address; the SDK and the live endpoint do.
 */
function defaultKeySetUrl(appId: string): string {
  return `https://api.privy.io/v1/apps/${appId}/jwks.json`;
}

function keySetUrl(appId: string, override: string | undefined): string {
  if (override === undefined) return defaultKeySetUrl(appId);
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new PrivyTokenError("bad_config");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new PrivyTokenError("bad_config");
  return url.href;
}

type CachedKeys = { fetchedAt: number; keys: Promise<JWTVerifyGetKey> };
const keyCache = new Map<string, CachedKeys>();

async function fetchKeySet(url: string, fetchImpl: typeof fetch): Promise<JWTVerifyGetKey> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KEY_FETCH_TIMEOUT_MS);
  let text: string;
  try {
    // WHY redirect "error" (C20): the key set host is fixed by config, so a redirect elsewhere is refused.
    const res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (res.status !== 200) throw new PrivyTokenError("keys_unavailable");
    text = await res.text();
  } catch {
    throw new PrivyTokenError("keys_unavailable");
  } finally {
    clearTimeout(timer);
  }
  if (typeof text !== "string" || text.length > MAX_KEY_SET_BYTES) throw new PrivyTokenError("keys_unavailable");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PrivyTokenError("keys_unavailable");
  }
  const parsed = keySetSchema.safeParse(json);
  if (!parsed.success) throw new PrivyTokenError("keys_unavailable");
  // Only public P-256 signing keys are rebuilt, field by field, so a private part or any other
  // field a response carries never reaches the key importer.
  const keys: JWK[] = [];
  for (const k of parsed.data.keys) {
    if (k.kty !== "EC" || k.crv !== "P-256" || k.x === undefined || k.y === undefined) continue;
    if ((k.alg !== undefined && k.alg !== ALGORITHM) || (k.use !== undefined && k.use !== "sig")) continue;
    keys.push({ kty: "EC", crv: "P-256", x: k.x, y: k.y, alg: ALGORITHM, use: "sig", ...(k.kid === undefined ? {} : { kid: k.kid }) });
  }
  if (keys.length === 0) throw new PrivyTokenError("keys_unavailable");
  try {
    return createLocalJWKSet({ keys });
  } catch {
    throw new PrivyTokenError("keys_unavailable");
  }
}

// A failed fetch is dropped from the cache at once, so the next request tries again instead of
// failing for ten minutes. A refetch made because of an unknown key id passes the keys it replaces
// as `fallback`: if Privy cannot be reached, the keys that still work stay in use.
function startFetch(url: string, fetchImpl: typeof fetch, nowMs: number, fallback?: Promise<JWTVerifyGetKey>): CachedKeys {
  if (keyCache.size >= MAX_KEY_SET_URLS && !keyCache.has(url)) keyCache.clear();
  const fetched = fetchKeySet(url, fetchImpl);
  const entry: CachedKeys = { fetchedAt: nowMs, keys: fallback === undefined ? fetched : fetched.catch(() => fallback) };
  keyCache.set(url, entry);
  entry.keys.catch(() => {
    if (keyCache.get(url) === entry) keyCache.delete(url);
  });
  return entry;
}

// One fetch per key set address per ten minutes, shared by concurrent requests.
function cachedKeys(url: string, fetchImpl: typeof fetch, nowMs: number): CachedKeys {
  const cached = keyCache.get(url);
  if (cached !== undefined && nowMs >= cached.fetchedAt && nowMs - cached.fetchedAt < KEY_CACHE_MS) return cached;
  return startFetch(url, fetchImpl, nowMs);
}

/**
 * The key set to try once more after a token named a key id that `used` lacks, or null to refuse
 * now. WHY: when Privy rotates its signing key, new tokens name a key the cached set does not hold
 * yet, and waiting out the ten-minute cache would lock judges out. A fetch happens at most once per
 * 60 seconds per address, so tokens with made-up key ids cannot turn into a stream of requests to
 * Privy. A newer entry that another request already started is used instead of a second fetch.
 */
function refreshedKeys(url: string, fetchImpl: typeof fetch, nowMs: number, used: CachedKeys): CachedKeys | null {
  const current = keyCache.get(url);
  if (current !== undefined && current !== used) return current;
  if (nowMs >= used.fetchedAt && nowMs - used.fetchedAt < KEY_REFETCH_MIN_MS) return null;
  return startFetch(url, fetchImpl, nowMs, used.keys);
}

function refusalFor(err: unknown): PrivyTokenError {
  return new PrivyTokenError(err instanceof joseErrors.JWTExpired ? "expired" : "invalid");
}

async function verifyWith(token: string, getKey: JWTVerifyGetKey, appId: string, nowMs: number): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getKey, {
    algorithms: [ALGORITHM],
    issuer: ISSUER,
    audience: appId,
    typ: "JWT",
    requiredClaims: ["exp", "sub"],
    clockTolerance: CLOCK_SKEW_SECONDS,
    currentDate: new Date(nowMs),
  });
  return payload;
}

function readUserId(payload: JWTPayload): string {
  const sub = payload.sub;
  if (typeof sub !== "string" || !USER_ID_TEXT.test(sub)) throw new PrivyTokenError("bad_claims");
  return sub;
}

/**
 * The embedded Ethereum wallets in the `linked_accounts` claim, a JSON array in a string. An
 * embedded wallet is an entry with type "wallet", wallet_client_type "privy" and chain_type
 * "ethereum" (the fields Privy's SDK reads). External wallets, smart wallets and other chains are
 * left out. An embedded Ethereum entry whose address getAddress refuses fails the whole token.
 */
function readEmbeddedEthereumWallets(payload: JWTPayload): Address[] {
  const claim = payload.linked_accounts;
  if (typeof claim !== "string") throw new PrivyTokenError("bad_claims");
  let accounts: unknown;
  try {
    accounts = JSON.parse(claim);
  } catch {
    throw new PrivyTokenError("bad_claims");
  }
  if (!Array.isArray(accounts) || accounts.length > MAX_LINKED_ACCOUNTS) throw new PrivyTokenError("bad_claims");
  const wallets: Address[] = [];
  for (const account of accounts) {
    if (typeof account !== "object" || account === null) throw new PrivyTokenError("bad_claims");
    const { type, wallet_client_type: client, chain_type: chain, address } = account as Record<string, unknown>;
    if (type !== "wallet" || client !== "privy" || chain !== "ethereum") continue;
    let wallet: Address;
    try {
      wallet = getAddress(typeof address === "string" ? address : "");
    } catch {
      throw new PrivyTokenError("bad_claims");
    }
    if (!wallets.includes(wallet)) wallets.push(wallet);
  }
  return wallets;
}

/**
 * Steps 1 to 4, shared by both token kinds, so an access token and an identity token are checked
 * by exactly the same rules and key cache:
 * 1. `opts.appId` is 1 to 64 letters and digits, and `opts.jwksUrl`, when given, is https (else
 *    "bad_config");
 * 2. the token is a string of at most 4096 characters in three base64url parts (else "malformed"),
 *    before any network call;
 * 3. Privy's key set for the app, fetched with `opts.fetchImpl` (global fetch by default), 5 s
 *    timeout, no redirects, and cached for 10 minutes by `opts.now` (else "keys_unavailable"). A
 *    token naming a key id the cached set lacks makes one refetch, at most once per 60 seconds per
 *    address, before it is refused, so a Privy key rotation does not lock users out;
 * 4. the signature is ES256 under a key in that set, header typ "JWT", issuer exactly "privy.io",
 *    audience exactly the string appId, `exp` and `sub` present, and not expired by more than 60
 *    seconds of clock skew ("expired" for the last, "invalid" for everything else).
 */
async function verifyPrivyJwt(token: string, opts: PrivyVerifyOptions): Promise<JWTPayload> {
  const appId = opts?.appId;
  if (typeof appId !== "string" || !APP_ID_TEXT.test(appId)) throw new PrivyTokenError("bad_config");
  const url = keySetUrl(appId, opts.jwksUrl);
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS || !JWT_TEXT.test(token)) throw new PrivyTokenError("malformed");
  const nowMs = (opts.now ?? Date.now)();
  if (!Number.isFinite(nowMs)) throw new PrivyTokenError("bad_config");

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const first = cachedKeys(url, fetchImpl, nowMs);
  const getKey = await first.keys;
  let payload: JWTPayload;
  try {
    payload = await verifyWith(token, getKey, appId, nowMs);
  } catch (err) {
    if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw refusalFor(err);
    const fresh = refreshedKeys(url, fetchImpl, nowMs, first);
    if (fresh === null) throw new PrivyTokenError("invalid");
    const freshKey = await fresh.keys;
    try {
      payload = await verifyWith(token, freshKey, appId, nowMs);
    } catch (again) {
      throw refusalFor(again);
    }
  }
  // jose accepts an audience array that merely contains appId. A token meant for several apps is
  // not one Privy issues for Moi, so only the exact string passes.
  if (payload.aud !== appId) throw new PrivyTokenError("invalid");
  return payload;
}

/** `now` returns milliseconds since 1970 (Date.now by default). */
export type PrivyVerifyOptions = { appId: string; jwksUrl?: string; now?: () => number; fetchImpl?: typeof fetch };

/**
 * Verifies a Privy identity token and returns the user's Privy id and the checksummed addresses of
 * their embedded Ethereum wallets (possibly none). Steps 1 to 4 as in verifyPrivyJwt, then:
 * 5. the account is not a guest: a `guest` claim, when present, must be "f" (C16; else
 *    "guest_account");
 * 6. `sub` is a Privy DID and `linked_accounts` parses (else "bad_claims").
 * Throws only PrivyTokenError.
 */
export async function verifyPrivyIdentityToken(token: string, opts: PrivyVerifyOptions): Promise<{ userId: string; wallets: Address[] }> {
  const payload = await verifyPrivyJwt(token, opts);
  if (payload.guest !== undefined && payload.guest !== "f") throw new PrivyTokenError("guest_account");
  return { userId: readUserId(payload), wallets: readEmbeddedEthereumWallets(payload) };
}

/**
 * Verifies a Privy access token, the one every signed-in session has (no dashboard setting needed),
 * and returns the user's Privy id from `sub`. Steps 1 to 4 as in verifyPrivyJwt, then the claims
 * Privy documents for access tokens: `sub` a Privy DID and `sid` a session id of 1 to 256
 * characters (else "bad_claims"). An access token names no wallets and does not say whether the
 * user is a guest, so a caller proves wallet ownership another way.
 * Throws only PrivyTokenError.
 */
export async function verifyPrivyAccessToken(token: string, opts: PrivyVerifyOptions): Promise<{ userId: string }> {
  const payload = await verifyPrivyJwt(token, opts);
  const sid = payload.sid;
  if (typeof sid !== "string" || sid.length === 0 || sid.length > 256) throw new PrivyTokenError("bad_claims");
  return { userId: readUserId(payload) };
}
