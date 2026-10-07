import { getAddress, recoverTypedDataAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { CHAIN_ID } from "./chain.js";
import { checkEligibility } from "./eligibility.js";
import { CLAIM_TYPES, claimDomain, parseGiftId } from "./gift.js";
import {
  ClaimRefusedError,
  DailyCapReachedError,
  GasPriceTooHighError,
  RelayerBusyError,
  RelayerInputError,
  type createRelayer,
} from "./relayer.js";
import { StoreError, type KvStore } from "./store.js";
import { readGift, readSenderIsCompliant, type VaultErrorName } from "./vault.js";
import { isWrapped } from "./wrap.js";

/** Every error a claim request can get back. Short, fixed, and never built from upstream text (C19). */
export type ClaimErrorCode =
  | "bad_request"
  | "bad_gift_id"
  | "bad_recipient"
  | "bad_signature"
  | "no_declaration"
  | "restricted_place"
  | "unknown_place"
  | "gift_not_open"
  | "gift_not_wrapped"
  | "gift_expired"
  | "gift_expiring"
  | "sender_blocked"
  | "claims_paused"
  | "claim_refused"
  | "too_many_attempts"
  | "busy"
  | "daily_cap"
  | "gas_price_high"
  | "relayer_unavailable"
  | "store_unavailable"
  | "chain_unavailable";

export type ClaimResponse = {
  status: number;
  body: { ok: true; txHash: Hex; reused: boolean } | { ok: false; error: ClaimErrorCode };
};

const STATUS: Record<ClaimErrorCode, number> = {
  bad_request: 400,
  bad_gift_id: 400,
  bad_recipient: 400,
  bad_signature: 400,
  no_declaration: 403,
  restricted_place: 403,
  unknown_place: 403,
  gift_not_open: 409,
  gift_not_wrapped: 402,
  gift_expired: 409,
  gift_expiring: 409,
  sender_blocked: 409,
  claims_paused: 409,
  claim_refused: 409,
  too_many_attempts: 409,
  busy: 429,
  daily_cap: 429,
  gas_price_high: 502,
  relayer_unavailable: 502,
  store_unavailable: 502,
  chain_unavailable: 502,
};

// Anything the vault refuses that is not listed here (a token's own transfer error, an unknown
// revert) becomes claim_refused: the default denies.
const VAULT_ERROR_CODES: Partial<Record<VaultErrorName, ClaimErrorCode>> = {
  GiftNotOpen: "gift_not_open",
  GiftExpired: "gift_expired",
  BadRecipient: "bad_recipient",
  BadSigner: "bad_signature",
  ECDSAInvalidSignature: "bad_signature",
  ECDSAInvalidSignatureLength: "bad_signature",
  ECDSAInvalidSignatureS: "bad_signature",
  SenderNotCompliant: "sender_blocked",
  EnforcedPause: "claims_paused",
  NotRelayer: "relayer_unavailable",
};

// Lengths are the longest valid form of each field, so an oversized string fails here before any
// parser sees it. The total body size is the caller's cap.
const bodySchema = z.strictObject({
  giftId: z.string().max(78),
  recipient: z.string().max(42),
  signature: z.string().max(132),
  declaration: z.literal(true),
});

const FIELD_CODES: readonly [string, ClaimErrorCode][] = [
  ["giftId", "bad_gift_id"],
  ["recipient", "bad_recipient"],
  ["signature", "bad_signature"],
  ["declaration", "no_declaration"],
];

const SIGNATURE_TEXT = /^0x[0-9a-fA-F]{130}$/;
const TX_HASH_TEXT = /^0x[0-9a-f]{64}$/;
// Half the secp256k1 group order: the largest s OpenZeppelin ECDSA accepts.
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
// EIP-7702: an account whose code is exactly 0xef0100 followed by a 20-byte address is still an
// externally owned account whose key signs for it; the code only names a delegate.
const DELEGATION_CODE = /^0xef0100[0-9a-f]{40}$/;

const fail = (error: ClaimErrorCode): ClaimResponse => ({ status: STATUS[error], body: { ok: false, error } });

function shapeErrorCode(issues: readonly { path: readonly PropertyKey[] }[]): ClaimErrorCode {
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
 * True only when `signature` is one the vault would accept for Claim(giftId, recipient) under this
 * vault's domain on chain 56, signed by `claimKey`. The vault's own rule applies first (OpenZeppelin
 * ECDSA: v of 27 or 28, s at most half the curve order), so no signature passes here that the vault
 * refuses. Both addresses go through getAddress. `signature` is 0x plus 130 lowercase hex. Never throws.
 */
async function signedByClaimKey(vault: Address, giftId: bigint, recipient: Address, signature: Hex, claimKey: Address): Promise<boolean> {
  const v = signature.slice(130);
  if (v !== "1b" && v !== "1c") return false;
  if (BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return false;
  try {
    const signer = await recoverTypedDataAddress({
      domain: claimDomain(vault, CHAIN_ID),
      types: CLAIM_TYPES,
      primaryType: "Claim",
      message: { giftId, recipient },
      signature,
    });
    const expected = getAddress(claimKey);
    return expected !== zeroAddress && getAddress(signer) === expected;
  } catch {
    return false;
  }
}

function errorCode(err: unknown): ClaimErrorCode {
  if (err instanceof ClaimRefusedError) {
    if (err.name === "GiftExpiring") return "gift_expiring";
    if (err.name === "TooManyAttempts") return "too_many_attempts";
    return (err.vaultError && VAULT_ERROR_CODES[err.vaultError]) || "claim_refused";
  }
  if (err instanceof RelayerBusyError) return "busy";
  if (err instanceof DailyCapReachedError) return "daily_cap";
  if (err instanceof GasPriceTooHighError) return "gas_price_high";
  if (err instanceof RelayerInputError) return "bad_request";
  if (err instanceof StoreError) return "store_unavailable";
  // GasLimitError (no estimate, or a claim needing more gas than the cap), RPC timeouts and any
  // other failure: the chain could not be read or used safely, so nothing was sent.
  return "chain_unavailable";
}

/**
 * The /api/claim handler, framework free. `body` is the already-parsed JSON (the caller caps its
 * size); `ctx` is the country and ISO 3166-2 region the hosting platform reports for the caller.
 * Checks, in order, and answers with the first that fails:
 * 1. shape: exactly {giftId, recipient, signature, declaration: true} with string fields (400, or
 *    403 no_declaration when only the declaration is wrong);
 * 2. giftId through parseGiftId, recipient through getAddress and not the zero address, signature
 *    0x plus 130 hex (400);
 * 3. eligibility for the place and the declaration (403, C30);
 * 4. the gift from chain: Open or Claimed (409 gift_not_open);
 * 5. the gift's wrapping fee has settled (wrap.ts isWrapped reads a settlement record under
 *    keys.wrapped in `store`) or its sender is `sponsor`, the one wallet whose judge gifts ride
 *    free, compared through getAddress; otherwise 402 gift_not_wrapped (C24). A `sponsor` of null
 *    exempts nobody. A store that cannot answer is 502 store_unavailable;
 * 6. the signature recovers, under this vault's claim domain, to the gift's stored claim key, by
 *    the vault's own acceptance rule (400 bad_signature, C36). No lock is taken and no chain call
 *    beyond the gift read is made before this passes. A gift already Claimed then goes to the
 *    relayer, which hands back the claim it stored for it, or refuses after simulation;
 * 7. the latest block is before the gift's expiry (409 gift_expired);
 * 8. the recipient is an externally owned account: no code, or exactly an EIP-7702 delegation (400, C16);
 * 9. the vault's own compliance check on the original sender (409 sender_blocked, C7);
 * 10. the relayer (C17, C18): 200 with the hash, or its refusal mapped to a code (409, 429, 502),
 *    including 409 gift_expiring when less than 60 seconds remain before expiry (C37) and 409
 *    too_many_attempts when the gift's last claims all reverted on chain.
 * Never throws and never returns upstream, chain or store text: every failure is one of the fixed
 * ClaimErrorCode values (C19). A 200 means "submitted", not "claimed"; the page must confirm the
 * receipt with confirmClaim (C16).
 */
export async function handleClaim(
  deps: {
    client: PublicClient;
    vault: Address;
    relayer: ReturnType<typeof createRelayer>;
    store: KvStore;
    sponsor: Address | null;
    devAllowUnknownCountry?: boolean;
  },
  body: unknown,
  ctx: { country?: string | null; region?: string | null },
): Promise<ClaimResponse> {
  const shape = bodySchema.safeParse(body);
  if (!shape.success) return fail(shapeErrorCode(shape.error.issues));
  const fields = shape.data;

  let giftId: bigint;
  try {
    giftId = parseGiftId(fields.giftId);
  } catch {
    return fail("bad_gift_id");
  }
  let recipient: Address;
  try {
    recipient = getAddress(fields.recipient);
  } catch {
    return fail("bad_recipient");
  }
  if (recipient === zeroAddress) return fail("bad_recipient");
  if (!SIGNATURE_TEXT.test(fields.signature)) return fail("bad_signature");
  const signature = fields.signature.toLowerCase() as Hex;

  const eligible = checkEligibility(
    { country: ctx?.country, region: ctx?.region, devAllowUnknown: deps.devAllowUnknownCountry === true },
    fields.declaration,
  );
  if (!eligible.ok) return fail(eligible.reason);

  try {
    const submit = async (): Promise<ClaimResponse> => {
      const result = await deps.relayer.submitClaim({ giftId, recipient, signature });
      if (typeof result?.txHash !== "string" || !TX_HASH_TEXT.test(result.txHash) || typeof result.reused !== "boolean") {
        return fail("relayer_unavailable");
      }
      return { status: 200, body: { ok: true, txHash: result.txHash, reused: result.reused } };
    };

    const gift = await readGift(deps.client, deps.vault, giftId);
    if (gift.state !== "Open" && gift.state !== "Claimed") return fail("gift_not_open");
    // C24: the relayer spends Moi's gas only on gifts whose wrapping fee settled, or on the
    // sponsor's own judge gifts. Checked before the signature so an unpaid gift costs no more work.
    const sponsored = deps.sponsor !== null && getAddress(gift.sender) === getAddress(deps.sponsor);
    if (!sponsored && !(await isWrapped(deps.store, deps.vault, giftId))) return fail("gift_not_wrapped");
    // WHY (C36): checked against the stored claim key before the relayer is called, so a junk
    // signature never takes the gift's lock, a simulation, or any relayer time from the real one.
    if (!(await signedByClaimKey(deps.vault, giftId, recipient, signature, gift.claimKey))) return fail("bad_signature");
    if (gift.state === "Claimed") return await submit();
    const latest = await deps.client.getBlock({ blockTag: "latest" });
    if (latest.timestamp >= gift.expiry) return fail("gift_expired");

    if (!isExternallyOwned(await deps.client.getCode({ address: recipient }))) return fail("bad_recipient");
    if (!(await readSenderIsCompliant(deps.client, deps.vault, giftId))) return fail("sender_blocked");

    return await submit();
  } catch (err) {
    return fail(errorCode(err));
  }
}
