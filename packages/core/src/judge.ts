import { bytesToHex, getAddress, hexToBytes, recoverMessageAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { CHAIN_ID } from "./chain.js";
import { checkEligibility } from "./eligibility.js";
import { parseGiftId, signClaim } from "./gift.js";
import { PrivyTokenError, verifyPrivyAccessToken } from "./privy.js";
import {
  ClaimRefusedError,
  DailyCapReachedError,
  GasPriceTooHighError,
  RelayerBusyError,
  RelayerInputError,
  type createRelayer,
} from "./relayer.js";
import { keys, StoreError, type KvStore, type StoreKey } from "./store.js";
import { readGift } from "./vault.js";

/** Thrown for a judge seed, index or pool setting that cannot be used. Messages never carry the seed. */
export class JudgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeConfigError";
  }
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SEED_TEXT = /^0x[0-9a-fA-F]{64}$/;
const JUDGE_SALT = new TextEncoder().encode("moi-judge-v1");
/** Pool indices run 0 to 63, so one seed backs at most 64 judge gifts. */
export const MAX_JUDGE_INDEX = 63;
// One HKDF output is zero or at least the group order with odds near 2^-128, so a second try is
// already out of reach; the bound only keeps the loop finite.
const MAX_DERIVE_TRIES = 16;

/**
 * The claim key for judge gift `index`, derived from the server's 32-byte judge seed so the pool
 * needs one secret instead of one per gift (C26, C40). HKDF-SHA256 through Web Crypto over the
 * seed bytes, salt "moi-judge-v1", info "gift-<index>", 32 bytes out. If those bytes are zero or
 * not below the secp256k1 order, it derives again with info "gift-<index>-<n>" for n = 1, 2, ...
 * Returns 0x plus 64 lowercase hex characters, a key viem accepts.
 * Throws JudgeConfigError when the seed is not 0x plus 64 hex characters or is all zeros, when
 * `index` is not a whole number from 0 to 63, or when Web Crypto is missing. No message carries
 * the seed or a derived key (C19).
 */
export async function deriveJudgeKey(seedHex: `0x${string}`, index: number): Promise<`0x${string}`> {
  if (typeof seedHex !== "string" || !SEED_TEXT.test(seedHex)) throw new JudgeConfigError("The judge seed must be 0x and 64 hex characters.");
  const seed = Uint8Array.from(hexToBytes(seedHex));
  if (seed.every((b) => b === 0)) throw new JudgeConfigError("The judge seed must not be all zeros.");
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_JUDGE_INDEX) {
    throw new JudgeConfigError(`A judge gift index must be a whole number from 0 to ${MAX_JUDGE_INDEX}.`);
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new JudgeConfigError("Web Crypto is not available here.");
  const base = await subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  for (let n = 0; n < MAX_DERIVE_TRIES; n += 1) {
    const info = new TextEncoder().encode(n === 0 ? `gift-${index}` : `gift-${index}-${n}`);
    const bits = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: JUDGE_SALT, info }, base, 256));
    const key = bytesToHex(bits);
    const value = BigInt(key);
    if (value > 0n && value < SECP256K1_N) return key;
  }
  throw new JudgeConfigError("No usable judge key could be derived.");
}

const CLIENT_HASH_SALT = new TextEncoder().encode("moi-client-hash-v1");
const CLIENT_HASH_INFO = new TextEncoder().encode("client-id");
const MAX_CACHED_HASH_KEYS = 8;
const hmacKeys = new Map<string, Promise<CryptoKey>>();

/**
 * The server's client hash key, derived from a 32-byte server secret (the relayer key, in
 * server-deps.ts) by HKDF-SHA256 with salt "moi-client-hash-v1" and info "client-id" (C46). One
 * way: the key reveals nothing about the secret, and it never leaves the process. Returns 0x and
 * 64 lowercase hex. Throws JudgeConfigError, without the secret in the message, when the secret is
 * not 0x and 64 hex characters, is all zeros, or Web Crypto is missing.
 */
export async function deriveClientHashKey(secretHex: `0x${string}`): Promise<`0x${string}`> {
  if (typeof secretHex !== "string" || !SEED_TEXT.test(secretHex)) throw new JudgeConfigError("The client hash secret must be 0x and 64 hex characters.");
  const secret = Uint8Array.from(hexToBytes(secretHex));
  if (secret.every((b) => b === 0)) throw new JudgeConfigError("The client hash secret must not be all zeros.");
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new JudgeConfigError("Web Crypto is not available here.");
  const base = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: CLIENT_HASH_SALT, info: CLIENT_HASH_INFO }, base, 256);
  return bytesToHex(new Uint8Array(bits));
}

/**
 * The one form in which a client identifier (an address, a Privy user id) is stored or logged:
 * HMAC-SHA256 of `text` under `keyHex`, as 0x and 64 lowercase hex (C25, C46). WHY keyed: a plain
 * SHA-256 of an IPv4 address is undone by trying all 2^32 of them, so anyone reading the store or
 * the logs could name every judge's network; under a key only the server can. Throws
 * JudgeConfigError for a key that is not 0x and 64 hex characters or when Web Crypto is missing.
 */
export async function hashClientId(keyHex: `0x${string}`, text: string): Promise<`0x${string}`> {
  if (typeof keyHex !== "string" || !SEED_TEXT.test(keyHex)) throw new JudgeConfigError("The client hash key must be 0x and 64 hex characters.");
  if (typeof text !== "string") throw new TypeError("A client id to hash must be text.");
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new JudgeConfigError("Web Crypto is not available here.");
  const cacheKey = keyHex.toLowerCase();
  let imported = hmacKeys.get(cacheKey);
  if (imported === undefined) {
    if (hmacKeys.size >= MAX_CACHED_HASH_KEYS) hmacKeys.clear();
    imported = subtle.importKey("raw", Uint8Array.from(hexToBytes(keyHex)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(cacheKey, imported);
    imported.catch(() => hmacKeys.delete(cacheKey));
  }
  return bytesToHex(new Uint8Array(await subtle.sign("HMAC", await imported, new TextEncoder().encode(text))));
}

const POOL_ENTRY_TEXT = /^([0-9]{1,78}):(0|[1-9][0-9]?)$/;
// 64 entries of a 78-digit id, a colon, two digits and a comma.
const MAX_POOL_TEXT = 64 * 82;

/**
 * Reads the MOI_JUDGE_POOL setting: "giftId:index,giftId:index" with no spaces, every gift id
 * through gift.ts parseGiftId and every index a whole number from 0 to 63 written without a
 * leading zero. Returns gift id to index. Throws JudgeConfigError for an empty or oversized text,
 * any entry in another form, a repeated gift id or a repeated index.
 */
export function parseJudgePool(text: string): Map<bigint, number> {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_POOL_TEXT) {
    throw new JudgeConfigError("The judge pool must be giftId:index pairs separated by commas.");
  }
  const pool = new Map<bigint, number>();
  const indices = new Set<number>();
  for (const entry of text.split(",")) {
    const match = POOL_ENTRY_TEXT.exec(entry);
    if (match === null) throw new JudgeConfigError("The judge pool must be giftId:index pairs separated by commas.");
    let giftId: bigint;
    try {
      giftId = parseGiftId(match[1] ?? "");
    } catch {
      throw new JudgeConfigError("A gift id in the judge pool is not valid.");
    }
    const index = Number(match[2]);
    if (index > MAX_JUDGE_INDEX) throw new JudgeConfigError(`A judge pool index is above ${MAX_JUDGE_INDEX}.`);
    if (pool.has(giftId) || indices.has(index)) throw new JudgeConfigError("The judge pool repeats a gift id or an index.");
    pool.set(giftId, index);
    indices.add(index);
  }
  return pool;
}

/** Every answer a judge claim can get back. Short, fixed, and never built from upstream text (C19). */
export type JudgeClaimErrorCode =
  | "bad_request"
  | "bad_token"
  | "bad_recipient"
  | "bad_wallet_proof"
  | "proof_expired"
  | "no_declaration"
  | "restricted_place"
  | "unknown_place"
  | "token_expired"
  | "wallet_not_verified"
  | "unknown_network"
  | "already_claimed"
  | "too_many_from_network"
  | "pool_empty"
  | "try_again"
  | "gift_expiring"
  | "claim_refused"
  | "busy"
  | "daily_cap"
  | "gas_price_high"
  | "auth_unavailable"
  | "store_unavailable"
  | "chain_unavailable"
  | "relayer_unavailable"
  | "server_misconfigured";

export type JudgeClaimResponse = {
  status: number;
  body: { ok: true; giftId: string; txHash: Hex } | { ok: false; error: JudgeClaimErrorCode };
};

const STATUS: Record<JudgeClaimErrorCode, number> = {
  bad_request: 400,
  bad_token: 401,
  bad_recipient: 400,
  bad_wallet_proof: 400,
  proof_expired: 401,
  no_declaration: 403,
  restricted_place: 403,
  unknown_place: 403,
  token_expired: 401,
  wallet_not_verified: 403,
  unknown_network: 403,
  already_claimed: 409,
  too_many_from_network: 429,
  pool_empty: 410,
  try_again: 503,
  gift_expiring: 409,
  claim_refused: 409,
  busy: 429,
  daily_cap: 429,
  gas_price_high: 502,
  auth_unavailable: 502,
  store_unavailable: 502,
  chain_unavailable: 502,
  relayer_unavailable: 502,
  server_misconfigured: 500,
};

// r, s and v of a personal_sign signature.
const WALLET_PROOF_TEXT = /^0x[0-9a-fA-F]{130}$/;
const ISSUED_AT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// A Privy id is "did:privy:" and letters and digits. Printable characters without a space or line
// break are all a user id may hold here, so no id can add a line to the signed message.
const USER_ID_TEXT = /^[\x21-\x7e]{1,256}$/;
const PROOF_MAX_AGE_MS = 5 * 60 * 1000;
const PROOF_MAX_AHEAD_MS = 60 * 1000;

// UTC to the second and a date that exists: the round trip through Date refuses 2026-02-30.
function isIssuedAtText(value: string): boolean {
  if (!ISSUED_AT_TEXT.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === `${value.slice(0, 19)}.000Z`;
}

// 4096 characters is far above a real Privy access token and keeps a pasted blob away from the
// verifier. The total body size is the route's cap.
const bodySchema = z.strictObject({
  accessToken: z.string().max(4096),
  recipient: z.string().max(42),
  walletProof: z.string().regex(WALLET_PROOF_TEXT),
  issuedAt: z.string().max(20).refine(isIssuedAtText),
  declaration: z.literal(true),
});

const FIELD_CODES: readonly [string, JudgeClaimErrorCode][] = [
  ["accessToken", "bad_token"],
  ["recipient", "bad_recipient"],
  ["walletProof", "bad_wallet_proof"],
  ["issuedAt", "bad_wallet_proof"],
  ["declaration", "no_declaration"],
];

/**
 * The exact text a judge's wallet signs with personal_sign (EIP-191) to prove it is theirs, four
 * lines joined by "\n":
 *   Moi judge gift
 *   Wallet: <checksummed recipient>
 *   Privy user: <user id>
 *   Issued at: <YYYY-MM-DDTHH:MM:SSZ>
 * The page and the server both build it here, so the two sides can never differ (standard 2). The
 * user id binds the proof to one judge and the time limits its reuse. Throws on an address
 * getAddress refuses, a user id that is not 1 to 256 printable characters without spaces, or a
 * time in any other form, so no field can add a line of its own.
 */
export function judgeWalletMessage(args: { recipient: string; userId: string; issuedAt: string }): string {
  const recipient = getAddress(args.recipient);
  if (typeof args.userId !== "string" || !USER_ID_TEXT.test(args.userId)) throw new RangeError("The user id is not one the judge message can hold.");
  if (typeof args.issuedAt !== "string" || !isIssuedAtText(args.issuedAt)) throw new RangeError("issuedAt must be written YYYY-MM-DDTHH:MM:SSZ.");
  return `Moi judge gift\nWallet: ${recipient}\nPrivy user: ${args.userId}\nIssued at: ${args.issuedAt}`;
}

const DAY_SECONDS = 24 * 60 * 60;
const USER_TTL_SECONDS = 30 * DAY_SECONDS;
const IP_TTL_SECONDS = 2 * DAY_SECONDS;
const GIFT_TTL_SECONDS = 90 * DAY_SECONDS;
// A gift handed out with less than this left could expire between the tap and inclusion.
const MIN_SECONDS_LEFT = 10n * 60n;
const TX_HASH_TEXT = /^0x[0-9a-f]{64}$/;
// The same rule as claim.ts: EIP-7702 code 0xef0100 plus a 20-byte address is still an
// externally owned account whose key signs for it.
const DELEGATION_CODE = /^0xef0100[0-9a-f]{40}$/;
// The characters an IPv4 or IPv6 address can hold, checked before the URL parser sees the text so
// a host name, a port or a user name can never be read as an address.
const IP_TEXT = /^[0-9a-fA-F:.]{2,45}$/;
const DOTTED_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAPPED_IPV4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

const fail = (error: JudgeClaimErrorCode): JudgeClaimResponse => ({ status: STATUS[error], body: { ok: false, error } });

function shapeErrorCode(issues: readonly { path: readonly PropertyKey[] }[]): JudgeClaimErrorCode {
  const fields = new Set(issues.map((i) => i.path[0]));
  if (fields.has(undefined)) return "bad_request";
  for (const [field, code] of FIELD_CODES) if (fields.has(field)) return code;
  return "bad_request";
}

function isExternallyOwned(code: Hex | undefined): boolean {
  if (code === undefined || code === "0x") return true;
  return DELEGATION_CODE.test(code.toLowerCase());
}

/**
 * The one form of a client address that the per-network limit counts (standard 2): the standard
 * URL parser's own serialisation, lowercase and compressed for IPv6, with an IPv4-mapped IPv6
 * address written as plain IPv4 so one network cannot count twice. IPv4 is accepted only already
 * in canonical dotted form. Null for anything else, including an IPv6 zone id.
 */
export function canonicalClientIp(raw: unknown): string | null {
  if (typeof raw !== "string" || !IP_TEXT.test(raw)) return null;
  try {
    if (raw.includes(":")) {
      const v6 = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
      const mapped = MAPPED_IPV4.exec(v6);
      if (mapped === null) return v6;
      const hi = Number.parseInt(mapped[1] ?? "", 16);
      const lo = Number.parseInt(mapped[2] ?? "", 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    // WHY exact match: the URL parser also reads old IPv4 spellings ("203.0.113", "010.0.0.1" as
    // octal), and a platform never sends those, so anything but the canonical form is refused.
    const v4 = new URL(`http://${raw}/`).hostname;
    return DOTTED_IPV4.test(v4) && v4 === raw ? v4 : null;
  } catch {
    return null;
  }
}

// The verifier's answer is read like input (standard 3): a custom verifier, or a future change to
// privy.ts, must still hand back a user id the signed message can hold.
function checkedUserId(value: unknown): string {
  const userId = (value as { userId?: unknown } | null)?.userId;
  if (typeof userId !== "string" || !USER_ID_TEXT.test(userId)) throw new Error("the access check returned no usable user id");
  return userId;
}

function identityErrorCode(err: unknown): JudgeClaimErrorCode {
  if (!(err instanceof PrivyTokenError)) return "auth_unavailable";
  if (err.kind === "expired") return "token_expired";
  if (err.kind === "keys_unavailable" || err.kind === "bad_config") return "auth_unavailable";
  return "bad_token";
}

function relayerErrorCode(err: unknown): JudgeClaimErrorCode {
  if (err instanceof ClaimRefusedError) return err.name === "GiftExpiring" ? "gift_expiring" : "claim_refused";
  if (err instanceof RelayerBusyError) return "busy";
  if (err instanceof DailyCapReachedError) return "daily_cap";
  if (err instanceof GasPriceTooHighError) return "gas_price_high";
  if (err instanceof RelayerInputError) return "claim_refused";
  if (err instanceof StoreError) return "store_unavailable";
  return "chain_unavailable";
}

type JudgeDeps = {
  client: PublicClient;
  vault: Address;
  relayer: ReturnType<typeof createRelayer>;
  store: KvStore;
  judgeSeed: `0x${string}`;
  pool: Map<bigint, number>;
  privyAppId: string;
  /** The server's key for hashClientId (C46), from deriveClientHashKey. */
  clientHashKey: `0x${string}`;
  verifyAccessToken?: typeof verifyPrivyAccessToken;
  now?: () => Date;
};

type JudgeCtx = { country?: string | null; region?: string | null; clientIp: string; devAllowUnknownCountry?: boolean };

/**
 * The judge-gift handler, framework free. A signed-in judge names a wallet and proves it is theirs
 * with a signed message, and the server signs the claim for one pre-paid pool gift with that
 * gift's judge key and hands it to the relayer. No key ever leaves the server, which is the stronger form of C26.
 * `body` is the already-parsed JSON (the route caps its size); `ctx` is the country, ISO 3166-2
 * region and client address the hosting platform reports. In order, answering with the first
 * that fails:
 * 1. shape: exactly {accessToken (at most 4096 characters), recipient, walletProof (0x and 130
 *    hex), issuedAt (YYYY-MM-DDTHH:MM:SSZ), declaration: true} (400 or 401, 403 no_declaration
 *    when only the declaration is wrong);
 * 2. eligibility for the place and the declaration, before any network call (403, C30);
 * 3. the recipient through getAddress and not zero (400); the Privy access token through
 *    `verifyAccessToken` (privy.ts by default; 401, 502), which gives the user id; the wallet
 *    proof: issuedAt within the last 5 minutes and at most 60 seconds ahead by server time (401
 *    proof_expired), and the personal_sign signer of judgeWalletMessage({recipient, userId,
 *    issuedAt}) equal to the recipient (400 bad_wallet_proof, 403 wallet_not_verified, C26); and
 *    the recipient an externally owned account (400, C16). The user id in the message stops another
 *    judge reusing a proof; the per-user mark in step 4 stops the same judge reusing it;
 * 4. the client address in one canonical form (403 unknown_network, before any store write), then
 *    one gift per Privy user for 30 days (409 already_claimed) and one per network per UTC day
 *    (429 too_many_from_network, the user's mark released first). Only keyed hashes (hashClientId
 *    under `clientHashKey`) of the user id and the address are stored (C25, C46);
 * 5. pool gifts in ascending id order, each taken atomically for 90 days so no two judges ever
 *    get the same one; a taken gift that is not Open, has under 10 minutes left by the latest
 *    block, or whose stored claim key is not its pool index's key stays taken and is skipped.
 *    None left: the user and network marks are released and the answer is 410 pool_empty;
 * 6. the claim is signed with deriveJudgeKey(seed, index) for (vault, 56, giftId, recipient) and
 *    sent through the relayer. On any refusal or error the gift, user and network marks are
 *    released so the judge can retry. A relayer answer that reuses an earlier claim belongs to
 *    another request: the gift stays taken, the judge's marks are released, and the answer is
 *    503 try_again;
 * 7. 200 {ok: true, giftId (decimal text), txHash}. A 200 means "submitted"; the page confirms the
 *    receipt with relayer.ts confirmClaim before it says "claimed" (C16).
 * Never throws. Every refusal is a fixed code, and the seed, every derived key and the access
 * token are never in a response, an error or a thrown message (C12, C19). Fails closed: a store,
 * chain or verifier failure is a refusal, never a handout.
 */
export async function handleJudgeClaim(deps: JudgeDeps, body: unknown, ctx: JudgeCtx): Promise<JudgeClaimResponse> {
  try {
    return await judgeClaim(deps, body, ctx);
  } catch {
    // Every step below answers its own failures; reaching here means a dependency broke its own
    // contract, so nothing is handed out.
    return fail("server_misconfigured");
  }
}

async function judgeClaim(deps: JudgeDeps, body: unknown, ctx: JudgeCtx): Promise<JudgeClaimResponse> {
  const shape = bodySchema.safeParse(body);
  if (!shape.success) return fail(shapeErrorCode(shape.error.issues));
  const fields = shape.data;

  const eligible = checkEligibility(
    { country: ctx?.country, region: ctx?.region, devAllowUnknown: ctx?.devAllowUnknownCountry === true },
    fields.declaration,
  );
  if (!eligible.ok) return fail(eligible.reason);

  let recipient: Address;
  try {
    recipient = getAddress(fields.recipient);
  } catch {
    return fail("bad_recipient");
  }
  if (recipient === zeroAddress) return fail("bad_recipient");
  const vault = getAddress(deps.vault);
  const now = deps.now ?? (() => new Date());
  const verify = deps.verifyAccessToken ?? verifyPrivyAccessToken;
  let userId: string;
  try {
    userId = checkedUserId(await verify(fields.accessToken, { appId: deps.privyAppId, now: () => now().getTime() }));
  } catch (err) {
    return fail(identityErrorCode(err));
  }
  // WHY (C26): an access token proves who the judge is but names no wallet, so the wallet proves
  // itself by signing a message that names this judge and a recent time.
  const issuedMs = Date.parse(fields.issuedAt);
  const nowMs = now().getTime();
  if (!(issuedMs >= nowMs - PROOF_MAX_AGE_MS && issuedMs <= nowMs + PROOF_MAX_AHEAD_MS)) return fail("proof_expired");
  let signer: Address;
  try {
    const message = judgeWalletMessage({ recipient, userId, issuedAt: fields.issuedAt });
    signer = await recoverMessageAddress({ message, signature: fields.walletProof as Hex });
  } catch {
    return fail("bad_wallet_proof");
  }
  if (getAddress(signer) !== recipient) return fail("wallet_not_verified");
  try {
    if (!isExternallyOwned(await deps.client.getCode({ address: recipient }))) return fail("bad_recipient");
  } catch {
    return fail("chain_unavailable");
  }

  let giftIds: bigint[];
  try {
    giftIds = poolGiftIds(deps.pool);
  } catch {
    return fail("server_misconfigured");
  }
  const ip = canonicalClientIp(ctx?.clientIp);
  if (ip === null) return fail("unknown_network");
  const day = now().toISOString().slice(0, 10);
  const [userHash, ipHash] = await Promise.all([hashClientId(deps.clientHashKey, userId), hashClientId(deps.clientHashKey, ip)]);
  const userKey = keys.judgeUser(vault, userHash);
  const ipKey = keys.judgeIpDay(vault, ipHash, day);
  const mark = globalThis.crypto.randomUUID();

  // Only a mark this request wrote is removed, so a release can never free another judge's mark.
  // A write that failed may still have landed, so every key this request tried is released.
  const release = async (toRelease: StoreKey[]) => {
    for (const k of toRelease) {
      try {
        if ((await deps.store.get(k)) === mark) await deps.store.del(k);
      } catch {
        // Every mark carries a TTL, so a failed release only delays this judge's retry.
      }
    }
  };

  try {
    if (!(await deps.store.setNx(userKey, mark, USER_TTL_SECONDS))) return fail("already_claimed");
  } catch {
    await release([userKey]);
    return fail("store_unavailable");
  }
  try {
    if (!(await deps.store.setNx(ipKey, mark, IP_TTL_SECONDS))) {
      await release([userKey]);
      return fail("too_many_from_network");
    }
  } catch {
    await release([userKey, ipKey]);
    return fail("store_unavailable");
  }
  const judgeMarks = [userKey, ipKey];
  // The gift this request holds and has not yet judged or claimed, released with the judge's own
  // marks if anything below throws where no step expected it.
  let inFlight: StoreKey | null = null;
  try {
    let chosen: { giftId: bigint; claimKey: `0x${string}`; taken: StoreKey } | null = null;
    let latest: bigint | null = null;
    for (const giftId of giftIds) {
      const taken = keys.judgeGiftTaken(vault, giftId);
      try {
        if (!(await deps.store.setNx(taken, mark, GIFT_TTL_SECONDS))) continue;
      } catch {
        await release([...judgeMarks, taken]);
        return fail("store_unavailable");
      }
      inFlight = taken;
      try {
        const claimKey = await deriveJudgeKey(deps.judgeSeed, deps.pool.get(giftId) ?? -1);
        const gift = await readGift(deps.client, vault, giftId);
        latest ??= (await deps.client.getBlock({ blockTag: "latest" })).timestamp;
        const usable =
          gift.state === "Open" && gift.expiry - latest >= MIN_SECONDS_LEFT && getAddress(gift.claimKey) === getAddress(privateKeyToAccount(claimKey).address);
        if (usable) {
          chosen = { giftId, claimKey, taken };
          break;
        }
        // Not usable now and never again for a judge (claimed, refunded, expiring, or a pool entry
        // that does not match its key), so it stays taken and no later judge spends a read on it.
        inFlight = null;
      } catch (err) {
        await release([...judgeMarks, taken]);
        return fail(err instanceof JudgeConfigError ? "server_misconfigured" : "chain_unavailable");
      }
    }
    if (chosen === null) {
      await release(judgeMarks);
      return fail("pool_empty");
    }

    try {
      const signature = await signClaim(chosen.claimKey, vault, CHAIN_ID, chosen.giftId, recipient);
      const result = await deps.relayer.submitClaim({ giftId: chosen.giftId, recipient, signature });
      if (typeof result?.txHash !== "string" || !TX_HASH_TEXT.test(result.txHash) || typeof result.reused !== "boolean") {
        await release([...judgeMarks, chosen.taken]);
        return fail("relayer_unavailable");
      }
      if (result.reused) {
        // WHY: a reused claim was sent by an earlier request, maybe to another wallet, so it is not
        // this judge's gift. The gift stays taken; the judge may retry and get the next one.
        await release(judgeMarks);
        return fail("try_again");
      }
      return { status: 200, body: { ok: true, giftId: chosen.giftId.toString(), txHash: result.txHash } };
    } catch (err) {
      await release([...judgeMarks, chosen.taken]);
      return fail(relayerErrorCode(err));
    }
  } catch {
    await release(inFlight === null ? judgeMarks : [...judgeMarks, inFlight]);
    return fail("server_misconfigured");
  }
}

// The pool is server config, checked like input before any mark is written: a Map of at most 64
// gift ids, each valid for parseGiftId, to distinct whole-number indices from 0 to 63. Returned in
// ascending id order, the order judges receive them in.
function poolGiftIds(pool: unknown): bigint[] {
  if (!(pool instanceof Map) || pool.size > MAX_JUDGE_INDEX + 1) throw new JudgeConfigError("The judge pool is not a usable map.");
  const indices = new Set<number>();
  const ids: bigint[] = [];
  for (const [giftId, index] of pool as Map<unknown, unknown>) {
    if (typeof giftId !== "bigint" || parseGiftId(giftId.toString()) !== giftId) throw new JudgeConfigError("The judge pool holds a bad gift id.");
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > MAX_JUDGE_INDEX || indices.has(index)) {
      throw new JudgeConfigError("The judge pool holds a bad index.");
    }
    indices.add(index);
    ids.push(giftId);
  }
  return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
