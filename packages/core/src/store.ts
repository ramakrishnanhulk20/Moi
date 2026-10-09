import { getAddress, zeroAddress, type Address } from "viem";
import { CHAIN_ID } from "./chain.js";
import { parseGiftId } from "./gift.js";

declare const storeKeyBrand: unique symbol;

/**
 * A key-value store key. Only `keys` below can build one, so every key is
 * "moi:v1:56:<checksummed address>:<prefix>[:<value>]" with a fixed prefix and parts that each
 * went through their one parser (C25).
 */
export type StoreKey = string & { readonly [storeKeyBrand]: true };

const NAMESPACE = "moi:v1";
const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_TEXT = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/;

function key(owner: Address, prefix: string, value?: string): StoreKey {
  const base = `${NAMESPACE}:${CHAIN_ID}:${owner}:${prefix}`;
  return (value === undefined ? base : `${base}:${value}`) as StoreKey;
}

// getAddress on every address, so two spellings of one address can never be two records.
function canonicalAddress(address: Address): Address {
  if (typeof address !== "string") throw new TypeError("An address key needs a string.");
  try {
    return getAddress(address);
  } catch {
    throw new RangeError("An address key needs a valid 20-byte address.");
  }
}

// The same parser the claim page and every route use, so "01" and "1" can never be two records.
function canonicalGiftId(giftId: bigint): string {
  if (typeof giftId !== "bigint") throw new TypeError("A gift id key needs a bigint.");
  return parseGiftId(giftId.toString()).toString();
}

// A transaction nonce: a whole number written once, in decimal, so 7 and 007 are one record.
function canonicalNonce(nonce: bigint): string {
  if (typeof nonce !== "bigint" || nonce < 0n || nonce >= 1n << 64n) throw new RangeError("A nonce key needs a bigint from 0 to 2^64 - 1.");
  return nonce.toString();
}

// A payment authorization nonce: exactly 32 bytes of hex, lowercased, so two spellings are one record.
function canonicalHex32(value: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RangeError("A payment nonce key needs 0x and 64 hex characters.");
  return value.toLowerCase();
}

// The position of a log inside one receipt: a whole number written once, in decimal.
function canonicalLogPosition(position: number): string {
  if (!Number.isSafeInteger(position) || position < 0) throw new RangeError("A log position key needs a whole number from zero up.");
  return String(position);
}

// A rate-limit window label such as "post-29345678": lowercase letters, digits and hyphens only,
// so no label can hold a colon and no letter has two spellings. The caller builds it from a whole
// minute count; this rule only guarantees the label stays inside its own key.
const WINDOW_TEXT = /^[a-z0-9][a-z0-9-]{0,31}$/;

function canonicalWindow(window: string): string {
  if (typeof window !== "string" || !WINDOW_TEXT.test(window)) {
    throw new RangeError("A rate-limit window needs 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit.");
  }
  return window;
}

// The global counter belongs to no client, so it takes an empty hash and nothing else; a client
// counter takes only a 32-byte hash, so a raw address or "unknown" can never become a key.
function rateLimitValue(scope: "global" | "client", clientHash: string, window: string): string {
  if (scope === "global") {
    if (clientHash !== "") throw new RangeError("The global rate-limit counter takes an empty client hash.");
    return `global-${canonicalWindow(window)}`;
  }
  if (scope === "client") return `client-${canonicalHex32(clientHash)}-${canonicalWindow(window)}`;
  throw new RangeError("A rate-limit scope is global or client.");
}

function canonicalDay(dayUtc: string): string {
  const match = typeof dayUtc === "string" ? DAY_TEXT.exec(dayUtc) : null;
  if (match === null) throw new RangeError("A day key needs a date written YYYY-MM-DD.");
  // Round-tripping through Date refuses dates that do not exist, such as 2026-02-30.
  const parsed = new Date(`${dayUtc}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dayUtc) {
    throw new RangeError("A day key needs a real calendar date.");
  }
  return dayUtc;
}

// A UTC hour written YYYY-MM-DDTHH, the first 13 characters of toISOString, on a real date.
function canonicalHour(hourUtc: string): string {
  const match = typeof hourUtc === "string" ? HOUR_TEXT.exec(hourUtc) : null;
  if (match === null || Number(match[2]) > 23) throw new RangeError("An hour key needs a UTC hour written YYYY-MM-DDTHH.");
  canonicalDay(match[1] ?? "");
  return hourUtc;
}

/**
 * Every key the server may use. Claim records and their locks belong to one vault on chain 56,
 * and spend counters, the send lock and the nonce counter belong to one relayer address, so a
 * redeployed vault or a rotated relayer starts clean instead of reading another deployment's
 * records. Every part is
 * parsed first: addresses through getAddress, gift ids through gift.ts parseGiftId (1 to
 * 2^256 - 1, decimal, no leading zeros), days as real YYYY-MM-DD dates and hours as YYYY-MM-DDTHH
 * on a real date. No part holds a colon, so
 * every key splits back into exactly one chain, address, prefix and value, and no input can reach
 * another namespace. Throws on any part that fails its parser.
 */
export const keys = {
  claim(vault: Address, giftId: bigint): StoreKey {
    return key(canonicalAddress(vault), "claim", canonicalGiftId(giftId));
  },
  claimLock(vault: Address, giftId: bigint): StoreKey {
    return key(canonicalAddress(vault), "claimlock", canonicalGiftId(giftId));
  },
  relayerSpent(relayer: Address, dayUtc: string): StoreKey {
    return key(canonicalAddress(relayer), "relayerspent", canonicalDay(dayUtc));
  },
  relayerSendLock(relayer: Address): StoreKey {
    return key(canonicalAddress(relayer), "relayersendlock");
  },
  relayerNonce(relayer: Address): StoreKey {
    return key(canonicalAddress(relayer), "relayernonce");
  },
  relayerTx(relayer: Address, nonce: bigint): StoreKey {
    return key(canonicalAddress(relayer), "relayertx", canonicalNonce(nonce));
  },
  wrapped(vault: Address, giftId: bigint): StoreKey {
    return key(canonicalAddress(vault), "wrapped", canonicalGiftId(giftId));
  },
  // WHY the payer (C24): b402 spends an authorization once per (payer, nonce), and Permit2 nonces
  // are each wallet's own counter, so two senders can both sign nonce 0. A mark without the payer
  // would turn the second sender's first payment into "reused".
  paymentAuth(payTo: Address, payer: Address, nonceHex: string): StoreKey {
    return key(canonicalAddress(payTo), "paymentauth", `${canonicalAddress(payer)}-${canonicalHex32(nonceHex)}`);
  },
  // One Transfer inside one settlement receipt, the unit that marks one gift (C44).
  settlementUsed(payTo: Address, txHash: string, position: number): StoreKey {
    return key(canonicalAddress(payTo), "settlement", `${canonicalHex32(txHash)}-${canonicalLogPosition(position)}`);
  },
  // Judge identities and networks are stored as 32-byte hashes: a Privy id contains colons and an
  // address has several spellings, so the caller hashes its one canonical form and only the hash is kept.
  judgeUser(vault: Address, userHash: string): StoreKey {
    return key(canonicalAddress(vault), "judgeuser", canonicalHex32(userHash));
  },
  // WHY the "judgeip" prefix: an IPv4 network is its one address, so marks written before networks
  // were grouped are the same keys and stay in force.
  judgeNetworkDay(vault: Address, networkHash: string, dayUtc: string): StoreKey {
    return key(canonicalAddress(vault), "judgeip", `${canonicalHex32(networkHash)}-${canonicalDay(dayUtc)}`);
  },
  judgeHour(vault: Address, hourUtc: string): StoreKey {
    return key(canonicalAddress(vault), "judgehour", canonicalHour(hourUtc));
  },
  judgeGiftTaken(vault: Address, giftId: bigint): StoreKey {
    return key(canonicalAddress(vault), "judgegift", canonicalGiftId(giftId));
  },
  // WHY the zero address: request counters belong to the server, not to one vault or relayer, and
  // no vault, relayer or payee can be the zero address, so these keys share no space with theirs
  // while still splitting into chain, address, prefix and value like every other key. The client
  // is stored only as a SHA-256 hash (C25), as with the judge keys.
  rateLimit(scope: "global" | "client", clientHash: string, window: string): StoreKey {
    return key(zeroAddress, "ratelimit", rateLimitValue(scope, clientHash, window));
  },
} as const;

/**
 * The server's key-value store. Every method throws when the store cannot answer; callers treat
 * that as a refusal (fail closed), never as an empty value.
 */
export interface KvStore {
  /** The value, or null when the key is absent or expired. */
  get(k: StoreKey): Promise<string | null>;
  /** Writes the value. Without `ttlSeconds` the key never expires. */
  set(k: StoreKey, v: string, ttlSeconds?: number): Promise<void>;
  /** Writes only when the key is absent. True when this call wrote it. */
  setNx(k: StoreKey, v: string, ttlSeconds: number): Promise<boolean>;
  /** Adds `n` (may be negative) to an integer value, starting from 0, resets its expiry, returns the new total. */
  incrBy(k: StoreKey, n: bigint, ttlSeconds: number): Promise<bigint>;
  del(k: StoreKey): Promise<void>;
}

/** Thrown for every store failure: transport, timeout, HTTP status, error reply or an unexpected reply shape. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

// Every store createUpstashStore built. Membership is the whole test for "shared", so a memory
// store, a wrapper around one, or any other object fails it without being named.
const sharedStores = new WeakSet<object>();

/**
 * True only for a store createUpstashStore built: the one store whose claim records, locks, spend
 * counter and nonce counter every server instance sees (C38). False for createMemoryStore, for any
 * object wrapping a store, and for anything that is not an object.
 */
export function isSharedStore(store: unknown): boolean {
  return typeof store === "object" && store !== null && sharedStores.has(store);
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
// Ten years; anything longer is a unit mistake (milliseconds passed as seconds).
const MAX_TTL_SECONDS = 315_360_000;
const INTEGER_TEXT = /^-?\d{1,19}$/;

function checkTtl(ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new RangeError("ttlSeconds must be a whole number of seconds from 1 to ten years.");
  }
  return ttlSeconds;
}

// Redis counters are signed 64-bit, so both stores refuse what Redis would.
function checkInt64(n: bigint): bigint {
  if (typeof n !== "bigint" || n < INT64_MIN || n > INT64_MAX) {
    throw new RangeError("incrBy needs a bigint that fits a signed 64-bit integer.");
  }
  return n;
}

function checkValue(v: string): string {
  if (typeof v !== "string") throw new TypeError("Store values are strings.");
  return v;
}

/**
 * An in-process store for tests and local runs. Honours TTLs against `now` (milliseconds,
 * Date.now by default). Each call completes before the next starts, so setNx and incrBy are
 * atomic within one process. Not shared between processes or route graphs.
 */
export function createMemoryStore(now: () => number = Date.now): KvStore {
  const data = new Map<string, { value: string; expiresAt: number | null }>();

  const live = (k: string) => {
    const entry = data.get(k);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      data.delete(k);
      return undefined;
    }
    return entry;
  };

  return {
    async get(k) {
      return live(k)?.value ?? null;
    },
    async set(k, v, ttlSeconds) {
      const value = checkValue(v);
      const expiresAt = ttlSeconds === undefined ? null : now() + checkTtl(ttlSeconds) * 1000;
      data.set(k, { value, expiresAt });
    },
    async setNx(k, v, ttlSeconds) {
      const value = checkValue(v);
      const ttl = checkTtl(ttlSeconds);
      if (live(k) !== undefined) return false;
      data.set(k, { value, expiresAt: now() + ttl * 1000 });
      return true;
    },
    async incrBy(k, n, ttlSeconds) {
      const step = checkInt64(n);
      const ttl = checkTtl(ttlSeconds);
      const current = live(k)?.value ?? "0";
      if (!INTEGER_TEXT.test(current)) throw new StoreError("incrBy on a value that is not an integer");
      const total = BigInt(current) + step;
      if (total < INT64_MIN || total > INT64_MAX) throw new StoreError("incrBy would overflow a 64-bit integer");
      data.set(k, { value: total.toString(), expiresAt: now() + ttl * 1000 });
      return total;
    },
    async del(k) {
      data.delete(k);
    },
  };
}

const DEFAULT_TIMEOUT_MS = 5_000;
// Moi stores hashes, tokens and counters. A reply this large is not one of ours.
const MAX_REPLY_BYTES = 65_536;

type Command = string[];

/**
 * A store over the Upstash Redis REST API: each command is a JSON array POSTed to `url` with a
 * bearer token, and incrBy runs INCRBY, EXPIRE and GET as one MULTI/EXEC transaction at
 * `url`/multi-exec. Every argument is sent as a string, and the counter is read back with GET
 * because JSON numbers lose precision above 2^53. Fails closed: a transport error, a timeout
 * (5000 ms by default), a non-200 status, an error reply, or any reply of an unexpected shape
 * throws StoreError. Error messages never carry the token or the store's own error text.
 * `url` must be an https origin with no path, query or fragment.
 */
export function createUpstashStore(opts: { url: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }): KvStore {
  let base: URL;
  try {
    base = new URL(opts.url);
  } catch {
    throw new Error("The Upstash URL is not a valid URL.");
  }
  if (base.protocol !== "https:" || base.href !== `${base.origin}/`) {
    throw new Error("The Upstash URL must be an https origin with no path, query or fragment.");
  }
  if (typeof opts.token !== "string" || !/^[\x21-\x7e]{8,1024}$/.test(opts.token)) {
    throw new Error("The Upstash token is missing or malformed.");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("timeoutMs must be a whole number of milliseconds between 1 and 60000.");
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const token = opts.token;
  const singleUrl = base.origin;
  const multiUrl = new URL("/multi-exec", base.origin).href;

  async function post(url: string, body: Command | Command[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text: string;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status !== 200) throw new StoreError(`store answered HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError(controller.signal.aborted ? "store timed out" : "store request failed");
    } finally {
      clearTimeout(timer);
    }
    if (text.length > MAX_REPLY_BYTES) throw new StoreError("store reply is too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new StoreError("store reply is not JSON");
    }
  }

  function resultOf(reply: unknown): unknown {
    if (typeof reply !== "object" || reply === null || Array.isArray(reply) || "error" in reply || !("result" in reply)) {
      throw new StoreError("store replied with an error or an unexpected shape");
    }
    return (reply as { result: unknown }).result;
  }

  async function run(command: Command): Promise<unknown> {
    return resultOf(await post(singleUrl, command));
  }

  const store: KvStore = {
    async get(k) {
      const result = await run(["GET", k]);
      if (result === null || typeof result === "string") return result;
      throw new StoreError("store GET reply is not a string");
    },
    async set(k, v, ttlSeconds) {
      const command = ["SET", k, checkValue(v)];
      if (ttlSeconds !== undefined) command.push("EX", String(checkTtl(ttlSeconds)));
      if ((await run(command)) !== "OK") throw new StoreError("store SET was not acknowledged");
    },
    async setNx(k, v, ttlSeconds) {
      const result = await run(["SET", k, checkValue(v), "NX", "EX", String(checkTtl(ttlSeconds))]);
      if (result === "OK") return true;
      if (result === null) return false;
      throw new StoreError("store SET NX reply is not OK or null");
    },
    async incrBy(k, n, ttlSeconds) {
      const step = checkInt64(n).toString();
      const ttl = String(checkTtl(ttlSeconds));
      const reply = await post(multiUrl, [["INCRBY", k, step], ["EXPIRE", k, ttl], ["GET", k]]);
      if (!Array.isArray(reply) || reply.length !== 3) throw new StoreError("store transaction reply has the wrong shape");
      const results = reply.map(resultOf);
      const total = results[2];
      if (typeof total !== "string" || !INTEGER_TEXT.test(total)) throw new StoreError("store counter is not an integer");
      return BigInt(total);
    },
    async del(k) {
      const result = await run(["DEL", k]);
      if (typeof result !== "number") throw new StoreError("store DEL reply is not a count");
    },
  };
  sharedStores.add(store);
  return store;
}
