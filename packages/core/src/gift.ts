import { bytesToHex, getAddress, hashTypedData, hexToBytes, isHex } from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/**
 * Thrown for any part of a gift link that cannot be trusted. The claim page turns `kind` into its
 * copy: "damaged" means the text is not a well-formed link part (often a chat app cut the link or
 * added a character to it), "invalid" means it is well-formed but wrong.
 */
export class LinkError extends Error {
  readonly kind: "damaged" | "invalid";

  constructor(kind: "damaged" | "invalid", message: string) {
    super(message);
    this.name = "LinkError";
    this.kind = kind;
  }
}

/**
 * Makes a fresh one-time claim key and the address the vault stores for it (C11). viem
 * generatePrivateKey draws 48 bytes from globalThis.crypto.getRandomValues, the Web Crypto source
 * in both the browser and Node, and throws when that source is missing, so there is no silent
 * fallback to a weaker one. The key is passed back through parseClaimKey so the value that goes
 * into a link has already been through the parser that will read it.
 */
export function newClaimKey(): { privateKey: `0x${string}`; address: `0x${string}` } {
  const privateKey = parseClaimKey(generatePrivateKey());
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

const CLAIM_KEY_TEXT = /^(?:0[xX])?([0-9a-fA-F]{64})$/;

/**
 * The one parser for a claim key (standard 2). The link parser, the address check (C15), signing
 * and the sealed note all call it. Accepts exactly 64 hex characters with an optional 0x prefix
 * in any letter case, with nothing before or after, and returns them lowercase with 0x.
 * Throws LinkError "damaged" for anything else: 63 or 65 characters, a full stop or bracket a chat
 * app added, a space, a non-hex letter, an empty string or a non-string.
 * Does not check that the key is a usable secp256k1 key; signClaim and claimKeyMatches refuse
 * one that is not.
 */
export function parseClaimKey(input: string): `0x${string}` {
  const match = typeof input === "string" ? CLAIM_KEY_TEXT.exec(input) : null;
  const hex = match?.[1];
  if (hex === undefined) throw new LinkError("damaged", "The claim key in this gift link is damaged.");
  return `0x${hex.toLowerCase()}`;
}

// 2^256 - 1 has 78 digits, so the length bound keeps BigInt away from huge strings. It cannot
// tell 2^256 from 2^256 - 1 (both have 78 digits); the comparison below does that.
const GIFT_ID_TEXT = /^[1-9][0-9]{0,77}$/;
const UINT256_LIMIT = 1n << 256n;

/**
 * The one parser for a gift id (standard 2), for the claim page, every API route and every store
 * key. Accepts only the canonical decimal form of a whole number from 1 to 2^256 - 1. Throws
 * LinkError "damaged" for an empty string, zero, a leading zero, a sign, hex, a decimal point, an
 * exponent, a space, a value of 2^256 or more, or a non-string. Because only one spelling of each
 * number is accepted, "01" and "1" can never reach two different records.
 */
export function parseGiftId(input: string): bigint {
  if (typeof input !== "string" || !GIFT_ID_TEXT.test(input)) {
    throw new LinkError("damaged", "The gift number in this link is damaged.");
  }
  const id = BigInt(input);
  if (id >= UINT256_LIMIT) throw new LinkError("damaged", "The gift number in this link is damaged.");
  return id;
}

// Far longer than any real link (an origin, /g/, 78 digits, # and 66 characters of key). The cap
// keeps an oversized paste away from the URL parser.
const MAX_LINK_LENGTH = 2048;
const GIFT_PATH = /^\/g\/([^/]*)$/;

// Plain http is allowed only for localhost, which browsers treat as a secure context, so Web Crypto
// works there during development. The scheme and host come from the standard URL parser, never
// from a prefix match on the raw text.
function hasAllowedScheme(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && url.hostname === "localhost";
}

// Gift ids arrive here as bigints from code, not text from a link, but they still go through
// parseGiftId so the range rule lives in one place.
function checkGiftId(giftId: bigint): bigint {
  return parseGiftId(typeof giftId === "bigint" ? giftId.toString() : "");
}

/**
 * Builds the gift link `${origin}/g/${giftId}#${key}`, with the key as 64 lowercase hex characters
 * and no 0x. The key sits in the fragment because browsers never send the fragment to a server.
 * `origin` must parse with the standard URL parser as https, or http://localhost with an optional
 * port, and must carry no path, query, fragment, user name or password (a trailing "/" is fine).
 * Throws LinkError "damaged" when the origin is not a URL, "invalid" when it breaks those rules,
 * and whatever parseGiftId or parseClaimKey throw for the id and key. The finished link is read
 * back through parseLink before it is returned, so every link handed out is one the claim page
 * accepts.
 */
export function buildLink(origin: string, giftId: bigint, claimKey: `0x${string}`): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new LinkError("damaged", "The site address for gift links is not a valid URL.");
  }
  if (!hasAllowedScheme(url)) {
    throw new LinkError("invalid", "Gift links must use https, or http://localhost in development.");
  }
  // The URL getters report an empty "?" or "#" as "", so comparing with the parser's own rebuilt
  // form is what catches every extra part in one check.
  if (url.href !== `${url.origin}/`) {
    throw new LinkError("invalid", "The site address for gift links must be an origin only, with no path, query or fragment.");
  }
  const id = checkGiftId(giftId);
  const key = parseClaimKey(claimKey);
  const link = `${url.origin}/g/${id}#${key.slice(2)}`;
  const check = parseLink(link);
  if (check.giftId !== id || check.claimKey !== key || check.origin !== url.origin) {
    throw new LinkError("invalid", "The gift link did not read back the way it was built.");
  }
  return link;
}

/**
 * Reads a gift link with the standard URL parser. The scheme must be https (or http on
 * localhost), the path exactly /g/<id>, there must be no query, user name or password, and the
 * fragment is the claim key. The id goes through parseGiftId and the key through parseClaimKey.
 * Throws LinkError "invalid" for a disallowed scheme and "damaged" for everything else, including
 * a missing or empty fragment and a link longer than 2048 characters. Returns the parser's
 * normalised origin; comparing it with the expected Moi origin is the caller's job.
 */
export function parseLink(url: string): { origin: string; giftId: bigint; claimKey: `0x${string}` } {
  if (typeof url !== "string" || url.length > MAX_LINK_LENGTH) {
    throw new LinkError("damaged", "This gift link is damaged.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LinkError("damaged", "This gift link is damaged.");
  }
  if (!hasAllowedScheme(parsed)) {
    throw new LinkError("invalid", "Gift links must use https.");
  }
  if (parsed.hash === "") {
    throw new LinkError("damaged", "This gift link is missing its claim key.");
  }
  // Only an origin, a path and a fragment may be present. If the parser's own pieces do not
  // rebuild the whole link, something else (a query, even an empty one, or a user name) is there.
  if (parsed.href !== `${parsed.origin}${parsed.pathname}${parsed.hash}`) {
    throw new LinkError("damaged", "This gift link is damaged.");
  }
  const path = GIFT_PATH.exec(parsed.pathname);
  if (path === null) {
    throw new LinkError("damaged", "This is not a gift link.");
  }
  return {
    origin: parsed.origin,
    giftId: parseGiftId(path[1] ?? ""),
    claimKey: parseClaimKey(parsed.hash.slice(1)),
  };
}

/** EIP-712 types for Claim(uint256 giftId,address recipient), the message the vault verifies. */
export const CLAIM_TYPES = {
  Claim: [
    { name: "giftId", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;

/**
 * The EIP-712 domain the vault checks: name "Moi", version "1", the chain id and the vault
 * address. Binding both stops a signature for one vault or one chain from working on another (C2).
 * Throws on a chain id that is not a positive whole number and on an address getAddress refuses.
 */
export function claimDomain(
  vault: `0x${string}`,
  chainId: number,
): { name: "Moi"; version: "1"; chainId: number; verifyingContract: `0x${string}` } {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("chainId must be a positive whole number.");
  }
  return { name: "Moi", version: "1", chainId, verifyingContract: getAddress(vault) };
}

// Built in one place so the digest and the signature can never be over different data.
function claimTypedData(vault: `0x${string}`, chainId: number, giftId: bigint, recipient: `0x${string}`) {
  return {
    domain: claimDomain(vault, chainId),
    types: CLAIM_TYPES,
    primaryType: "Claim" as const,
    message: { giftId: checkGiftId(giftId), recipient: getAddress(recipient) },
  };
}

// Both the address check and signing derive the account here, from the same parsed key
// (standard 2).
function claimAccount(claimKey: string): PrivateKeyAccount {
  const key = parseClaimKey(claimKey);
  try {
    return privateKeyToAccount(key);
  } catch {
    // 64 hex characters can still be zero or above the curve order. newClaimKey never makes one,
    // so only a crafted link carries it.
    throw new LinkError("invalid", "The claim key in this gift link is not a usable key.");
  }
}

/**
 * The EIP-712 digest of Claim(giftId, recipient) under claimDomain(vault, chainId). The vault
 * recovers the claim key's address from a signature over exactly this digest. Throws LinkError
 * "damaged" for a gift id outside 1 to 2^256 - 1, and throws on a bad vault or recipient address
 * or a bad chain id.
 */
export function claimDigest(
  vault: `0x${string}`,
  chainId: number,
  giftId: bigint,
  recipient: `0x${string}`,
): `0x${string}` {
  return hashTypedData(claimTypedData(vault, chainId, giftId, recipient));
}

/**
 * Signs Claim(giftId, recipient) with the claim key and returns the 65-byte signature (r, s, v
 * with v of 27 or 28, low s) that the vault checks. The recipient is normalised with getAddress.
 * Throws LinkError "damaged" for a malformed key or gift id, LinkError "invalid" for a key that is
 * well-formed but cannot sign, and throws on a bad address or chain id.
 */
export async function signClaim(
  claimKey: `0x${string}`,
  vault: `0x${string}`,
  chainId: number,
  giftId: bigint,
  recipient: `0x${string}`,
): Promise<`0x${string}`> {
  const account = claimAccount(claimKey);
  return account.signTypedData(claimTypedData(vault, chainId, giftId, recipient));
}

/**
 * C15: true only when the claim key produces exactly the claim-key address stored on chain for the
 * gift. The key goes through the same parser as signing, and both addresses go through getAddress.
 * Never throws. A malformed or unusable key, a malformed stored address, and the zero address (which
 * no key produces) all give false, so the page shows "not valid".
 */
// WHY synchronous: an async version returns a Promise, which is truthy, so a caller that forgot
// `await` would accept every link. A plain boolean cannot be misread that way.
export function claimKeyMatches(
  claimKey: `0x${string}`,
  storedClaimKeyAddress: `0x${string}`,
): boolean {
  try {
    return getAddress(claimAccount(claimKey).address) === getAddress(storedClaimKeyAddress);
  } catch {
    return false;
  }
}

/** EIP-712 types for RegisterGift(address sender), the key proof the vault's createGift checks (C32). */
export const REGISTER_TYPES = { RegisterGift: [{ name: "sender", type: "address" }] } as const;

// Built in one place so the digest and the proof can never be over different data.
function registerTypedData(vault: `0x${string}`, chainId: number, sender: `0x${string}`) {
  return {
    domain: claimDomain(vault, chainId),
    types: REGISTER_TYPES,
    primaryType: "RegisterGift" as const,
    message: { sender: getAddress(sender) },
  };
}

/**
 * The EIP-712 digest of RegisterGift(sender) under claimDomain(vault, chainId), the same value as
 * the vault's registerDigest(sender). Throws on a bad vault or sender address or a bad chain id.
 */
export function registerDigest(vault: `0x${string}`, chainId: number, sender: `0x${string}`): `0x${string}` {
  return hashTypedData(registerTypedData(vault, chainId, sender));
}

/**
 * Signs RegisterGift(sender) with the claim key and returns the 65-byte proof (r, s, v with v of
 * 27 or 28, low s) that createGift takes as keyProof. `sender` must be the address that will send
 * createGift, normalised here with getAddress: the vault recovers the proof against msg.sender, so
 * a copy of the transaction sent from any other address fails BadKeyProof (C32). Throws LinkError
 * "damaged" for a malformed key, LinkError "invalid" for a key that cannot sign, and throws on a
 * bad address or chain id.
 */
export async function signKeyProof(
  claimKey: `0x${string}`,
  vault: `0x${string}`,
  chainId: number,
  sender: `0x${string}`,
): Promise<`0x${string}`> {
  const account = claimAccount(claimKey);
  return account.signTypedData(registerTypedData(vault, chainId, sender));
}

const NOTE_VERSION = 0x01;
const NOTE_IV_BYTES = 12;
const NOTE_TAG_BYTES = 16;
const NOTE_OVERHEAD_BYTES = 1 + NOTE_IV_BYTES + NOTE_TAG_BYTES;

/** The largest sealed note in bytes, matching the vault's note cap (C3). */
export const MAX_NOTE_BYTES = 512;
/** The largest note text in UTF-8 bytes: 512 minus 1 version byte, a 12-byte IV and a 16-byte tag. */
export const MAX_NOTE_PLAINTEXT_BYTES = MAX_NOTE_BYTES - NOTE_OVERHEAD_BYTES;

const NOTE_SALT = new TextEncoder().encode("moi-note-v1");
const NOTE_INFO = new TextEncoder().encode("note");

// Web Crypto through globalThis keeps this file identical in the browser and in Node. Browsers
// only offer crypto.subtle on https and localhost pages, so its absence fails closed here.
function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("Web Crypto is not available here, so the note cannot be sealed or opened.");
  return subtle;
}

async function noteKey(claimKey: `0x${string}`) {
  const subtle = subtleCrypto();
  const base = await subtle.importKey("raw", Uint8Array.from(hexToBytes(claimKey)), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: NOTE_SALT, info: NOTE_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seals the sender's note so only someone holding the link can read it (C9); only this output
 * goes on chain. The AES-256-GCM key comes from HKDF-SHA256 over the 32 claim-key bytes with salt
 * "moi-note-v1" and info "note", and every seal uses a fresh 12-byte IV from
 * crypto.getRandomValues. Output is hex of [0x01][IV][ciphertext and 16-byte tag], at most
 * MAX_NOTE_BYTES. An empty note seals to "0x". Throws LinkError "damaged" for a malformed key and
 * RangeError when the UTF-8 text is longer than MAX_NOTE_PLAINTEXT_BYTES.
 */
export async function sealNote(claimKey: `0x${string}`, plaintext: string): Promise<`0x${string}`> {
  const key = parseClaimKey(claimKey);
  if (typeof plaintext !== "string") throw new TypeError("The note must be text.");
  const text = new TextEncoder().encode(plaintext);
  if (text.length > MAX_NOTE_PLAINTEXT_BYTES) {
    throw new RangeError(`The note is ${text.length} bytes; the limit is ${MAX_NOTE_PLAINTEXT_BYTES} bytes.`);
  }
  if (text.length === 0) return "0x";
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(NOTE_IV_BYTES));
  const sealed = new Uint8Array(await subtleCrypto().encrypt({ name: "AES-GCM", iv }, await noteKey(key), text));
  const out = new Uint8Array(1 + NOTE_IV_BYTES + sealed.length);
  out[0] = NOTE_VERSION;
  out.set(iv, 1);
  out.set(sealed, 1 + NOTE_IV_BYTES);
  return bytesToHex(out);
}

/**
 * Opens a note made by sealNote. "0x" opens to "". Fails closed: it returns the whole note or
 * throws, never part of one. Throws LinkError "damaged" for a malformed key and LinkError
 * "invalid" for text that is not even-length hex, a blob shorter than one sealed byte or longer
 * than MAX_NOTE_BYTES, a version byte other than 0x01, a wrong key, any changed byte, or bytes
 * that are not valid UTF-8. The returned text is the sender's own words and must be rendered as
 * plain text only (C14).
 */
export async function openNote(claimKey: `0x${string}`, sealed: `0x${string}`): Promise<string> {
  const key = parseClaimKey(claimKey);
  if (sealed === "0x") return "";
  if (
    typeof sealed !== "string" ||
    sealed.length > 2 + 2 * MAX_NOTE_BYTES ||
    sealed.length % 2 !== 0 ||
    !isHex(sealed, { strict: true })
  ) {
    throw new LinkError("invalid", "The note on this gift is not readable.");
  }
  const bytes = hexToBytes(sealed);
  // sealNote never seals an empty note into a blob, so a blob must hold at least one note byte.
  if (bytes.length < NOTE_OVERHEAD_BYTES + 1 || bytes[0] !== NOTE_VERSION) {
    throw new LinkError("invalid", "The note on this gift is not readable.");
  }
  let opened: ArrayBuffer;
  try {
    opened = await subtleCrypto().decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 1 + NOTE_IV_BYTES) },
      await noteKey(key),
      bytes.slice(1 + NOTE_IV_BYTES),
    );
  } catch {
    throw new LinkError("invalid", "The note on this gift could not be opened with this link.");
  }
  try {
    // ignoreBOM keeps a leading U+FEFF that the sender typed, so the text round-trips exactly.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(opened);
  } catch {
    throw new LinkError("invalid", "The note on this gift is not readable.");
  }
}
