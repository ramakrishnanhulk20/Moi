import {
  bytesToHex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  maxUint256,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
} from "viem";
import { z } from "zod";
import { parseAmount } from "../amounts.js";
import { assertChain, B402_PERMIT2_SPENDER, CHAIN_ID } from "../chain.js";
import { WRAP_ASSETS, WRAP_NETWORK, type PaymentRequirementsV2 } from "../wrap.js";

/** The canonical Permit2 contract, the same address on every EVM chain (b402 Permit2 signing guide). */
export const PERMIT2_ADDRESS: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

/**
 * The most the website will pay to wrap one gift, in US dollars. Moi's price is 0.05; the sender
 * agent pins the same ceiling (packages/agent/src/pinned.ts).
 */
export const WRAP_FEE_CEILING_USD = "0.10";

/**
 * The connected wallet as every browser flow uses it. `address` is the account that signs and
 * sends. `signTypedData` and `signMessage` return a 65-byte signature; `sendTransaction` returns
 * the hash of a transaction it has broadcast on chain 56. A viem WalletClient, or a Privy wallet
 * behind one, fits after a few lines of glue.
 */
export type WalletSigner = {
  address: Address;
  signTypedData: (typedData: TypedDataDefinition) => Promise<Hex>;
  signMessage: (message: string) => Promise<Hex>;
  sendTransaction: (tx: { to: Address; data: Hex; value: bigint; chainId: typeof CHAIN_ID }) => Promise<Hex>;
};

/** Thrown when a payment request cannot be read or paid. The message is fixed text a page can show. */
export class PaymentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRequestError";
  }
}

/** What the 402 answer of /api/wrap/:id carries, after one strict check. */
export type PaymentRequired = {
  x402Version: 2;
  accepts: PaymentRequirementsV2[];
  resource?: { url: string; description?: string; mimeType?: string };
  error?: string;
};

/** An ERC-20 approval of Permit2 for exactly one payment's amount (C21: never unlimited). */
export type Permit2Approval = { token: Address; spender: Address; amount: bigint };

export type BuiltPayment =
  | { headerValue: string; needsPermit2Approval: null }
  | { headerValue: ""; needsPermit2Approval: Permit2Approval };

// The server's 402 for six requirements is about 3 KB of base64; far past that is not Moi's.
const MAX_REQUIRED_HEADER_CHARS = 16 * 1024;
const MAX_RESOURCE_URL_CHARS = 2_048;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE_TEXT = /^0x[0-9a-fA-F]{130}$/;
// The token's own clock check is block.timestamp > validAfter, so a small backdate lets a payment
// signed this second settle in the next block.
const VALID_AFTER_BACKDATE_SECONDS = 5n;
const VALID_FOR_SECONDS = 600n;

const addressText = z.custom<Address>((v) => typeof v === "string" && isAddress(v));
const uintText = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const nameText = z.string().min(1).max(64);
const versionText = z.string().min(1).max(16);

// The same two "exact" methods, field for field, that wrap.ts offers. permit2-upto lets the payee
// pick the amount at settle time, so it is never accepted here.
const extraSchema = z.union([
  z.strictObject({
    name: nameText,
    version: versionText,
    assetTransferMethod: z.literal("eip3009"),
    signerAddress: addressText,
    spenderAddress: z.null().optional(),
  }),
  z.strictObject({
    name: nameText,
    version: versionText,
    assetTransferMethod: z.literal("permit2-exact"),
    signerAddress: addressText,
    spenderAddress: addressText,
  }),
]);

const requirementSchema = z.strictObject({
  scheme: z.literal("exact"),
  network: z.literal(WRAP_NETWORK),
  amount: uintText,
  asset: addressText,
  payTo: addressText,
  maxTimeoutSeconds: z.number().int().min(1).max(86_400),
  extra: extraSchema,
});

const paymentRequiredSchema = z.strictObject({
  x402Version: z.literal(2),
  // wrap.ts names why it answered 402 again ("payment_invalid") on a replay.
  error: z.string().regex(/^[a-z_]{1,48}$/).optional(),
  resource: z
    .strictObject({ url: z.string().max(MAX_RESOURCE_URL_CHARS), description: z.string().max(256).optional(), mimeType: z.string().max(128).optional() })
    .optional(),
  accepts: z.array(requirementSchema).min(1).max(16),
});

/**
 * Reads the PAYMENT-REQUIRED header of a 402 from /api/wrap/:id: standard base64 of UTF-8 JSON,
 * at most 16 KB, holding exactly {x402Version: 2, accepts, resource?, error?}. Every requirement
 * must be an "exact" payment on eip155:56 with the extra fields of eip3009 or permit2-exact, the
 * same shapes wrap.ts builds. Unknown keys anywhere are refused.
 * Throws PaymentRequestError for anything else. Checks shape only: whether a requirement pays the
 * right party for the right amount is pickRequirement's job.
 */
export function decodePaymentRequired(headerValue: string): PaymentRequired {
  const unreadable = new PaymentRequestError("Moi's payment request could not be read, so nothing was paid.");
  if (typeof headerValue !== "string" || headerValue.length === 0 || headerValue.length > MAX_REQUIRED_HEADER_CHARS) throw unreadable;
  if (headerValue.length % 4 !== 0 || !BASE64_TEXT.test(headerValue)) throw unreadable;
  let json: unknown;
  try {
    const bytes = Uint8Array.from(atob(headerValue), (c) => c.charCodeAt(0));
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw unreadable;
  }
  const parsed = paymentRequiredSchema.safeParse(json);
  if (!parsed.success) throw unreadable;
  return parsed.data;
}

function methodOf(requirement: PaymentRequirementsV2): unknown {
  return requirement.extra.assetTransferMethod;
}

/**
 * Chooses the requirement to pay, or null when none qualifies. A requirement qualifies only when
 * it passes decodePaymentRequired's shape check again, pays `payTo` (getAddress on both sides),
 * is in an asset of `assets` whose EIP-712 name equals extra.name, and asks for more than zero and
 * at most `maxUsd` in that asset's decimals (the stablecoins are taken at one dollar each). Of
 * those, the first eip3009 one wins (no approval transaction), then the first permit2-exact one.
 * `payTo` and `maxUsd` must be the website's own pinned values, never ones read from the 402
 * (C24, C27). Throws on a malformed or zero `payTo`, a `maxUsd` parseAmount refuses, or any
 * `prefer` other than "eip3009-first".
 */
export function pickRequirement(
  accepts: readonly PaymentRequirementsV2[],
  opts: { payTo: Address; maxUsd: string; assets: typeof WRAP_ASSETS; prefer: "eip3009-first" },
): PaymentRequirementsV2 | null {
  const payTo = getAddress(opts.payTo);
  if (payTo === zeroAddress) throw new TypeError("The pinned payee is the zero address.");
  if (opts.prefer !== "eip3009-first") throw new TypeError("The only payment preference is eip3009-first.");
  if (!Array.isArray(accepts)) return null;
  const usable = accepts.filter((r) => {
    if (!requirementSchema.safeParse(r).success) return false;
    if (getAddress(r.payTo) !== payTo) return false;
    const asset = opts.assets.find((a) => getAddress(a.address) === getAddress(r.asset));
    if (asset === undefined || r.extra.name !== asset.name) return false;
    const amount = BigInt(r.amount);
    return amount > 0n && amount <= parseAmount(opts.maxUsd, asset.decimals);
  });
  return usable.find((r) => methodOf(r) === "eip3009") ?? usable.find((r) => methodOf(r) === "permit2-exact") ?? null;
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Field order is part of the hash. b402's guide: Witness is exactly (to, validAfter) for permit2-exact.
const PERMIT_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

// C11: payment nonces come from Web Crypto, the browser's cryptographic random source.
function randomBytes32(): Hex {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== "function") {
    throw new PaymentRequestError("This browser has no secure random source, so no payment can be signed.");
  }
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function checkResourceUrl(resourceUrl: string): string {
  const bad = new PaymentRequestError("The address of the wrap payment is not one Moi uses, so nothing was paid.");
  if (typeof resourceUrl !== "string" || resourceUrl.length > MAX_RESOURCE_URL_CHARS) throw bad;
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    throw bad;
  }
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  if (!scheme || url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") throw bad;
  return resourceUrl;
}

// Standard 3: the wallet's answer is read like input. A signature that does not recover to the
// payer over exactly this data would only fail at b402, after the page said "paying".
async function checkedSignature(typedData: TypedDataDefinition, signature: unknown, from: Address): Promise<Hex> {
  const bad = new PaymentRequestError("Your wallet's signature for the wrapping fee did not check out, so nothing was paid.");
  if (typeof signature !== "string" || !SIGNATURE_TEXT.test(signature)) throw bad;
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...typedData, signature: signature as Hex });
  } catch {
    throw bad;
  }
  if (getAddress(signer) !== from) throw bad;
  return signature as Hex;
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Signs one payment for `requirement` and returns the PAYMENT-SIGNATURE header value: base64 of
 * {x402Version: 2, resource: {url: resourceUrl}, accepted: requirement (unchanged), payload}, with
 * no extensions, the shape wrap.ts decodes.
 * - eip3009 (U, USD1): TransferWithAuthorization over the token's own EIP-712 domain (extra.name,
 *   extra.version, chain 56, the asset), from the signer to payTo for exactly the amount, valid
 *   from now minus 5 s to now plus 600 s, with a random 32-byte nonce.
 * - permit2-exact: when the signer's ERC-20 allowance to Permit2 is below the amount, signs nothing
 *   and returns needsPermit2Approval for exactly that amount (C21) with an empty header; the caller
 *   sends permit2ApprovalTx, waits for it, and calls again. Otherwise PermitWitnessTransferFrom
 *   over Permit2's three-field domain: permitted {asset, amount}, spender B402_PERMIT2_SPENDER, a
 *   random uint256 nonce, deadline now plus 600 s, witness {to: payTo, validAfter: now minus 5 s}.
 *   A requirement whose extra.spenderAddress is any other address is refused before the allowance
 *   is read, so no approval is offered for it.
 * "Now" is the latest block's timestamp from `publicClient`, after it reports chain 56, never the
 * device clock: a phone running fast would sign a payment that is not valid yet. Call
 * pickRequirement first: this function checks the requirement's shape, not who it pays. The
 * signature must recover to the signer.
 * Throws PaymentRequestError for a requirement or resource URL it will not pay, an unusable signer
 * or signature, and a node that cannot report chain 56 or its latest block (a refusal, nothing is
 * signed); throws the node's error when the allowance cannot be read.
 */
export async function buildPayment(
  deps: { signer: WalletSigner; publicClient: PublicClient },
  requirement: PaymentRequirementsV2,
  resourceUrl: string,
): Promise<BuiltPayment> {
  const parsed = requirementSchema.safeParse(requirement);
  const unpayable = new PaymentRequestError("Moi's payment request is not one this page can pay, so nothing was paid.");
  if (!parsed.success) throw unpayable;
  const req = parsed.data;
  // WHY (C21, C27): the spender is who Permit2 lets pull this wallet's tokens, and the 402 is server
  // text. Only b402's own contract is signed for, checked before any approval is offered.
  if (req.extra.assetTransferMethod === "permit2-exact" && getAddress(req.extra.spenderAddress) !== B402_PERMIT2_SPENDER) throw unpayable;
  const url = checkResourceUrl(resourceUrl);
  let from: Address;
  try {
    from = getAddress(deps.signer.address);
  } catch {
    throw new PaymentRequestError("The connected wallet has no usable address.");
  }
  if (from === zeroAddress) throw new PaymentRequestError("The connected wallet has no usable address.");
  const noClock = new PaymentRequestError("Moi could not read the time from BNB Smart Chain, so nothing was signed. Try again in a minute.");
  let nowSeconds: bigint;
  try {
    await assertChain(deps.publicClient);
    nowSeconds = (await deps.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  } catch {
    throw noClock;
  }
  if (typeof nowSeconds !== "bigint" || nowSeconds <= 0n) throw noClock;
  const validAfter = nowSeconds - VALID_AFTER_BACKDATE_SECONDS;
  const validBefore = nowSeconds + VALID_FOR_SECONDS;
  const amount = BigInt(req.amount);
  const payTo = getAddress(req.payTo);
  const asset = getAddress(req.asset);

  let payload: unknown;
  if (req.extra.assetTransferMethod === "eip3009") {
    const nonce = randomBytes32();
    const typedData = {
      domain: { name: req.extra.name, version: req.extra.version, chainId: CHAIN_ID, verifyingContract: asset },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from, to: payTo, value: amount, validAfter, validBefore, nonce },
    } as const;
    const signature = await checkedSignature(typedData, await deps.signer.signTypedData(typedData), from);
    payload = {
      signature,
      authorization: { from, to: payTo, value: req.amount, validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce },
    };
  } else {
    const spender = B402_PERMIT2_SPENDER;
    const allowance = await deps.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [from, PERMIT2_ADDRESS] });
    if (allowance < amount) return { headerValue: "", needsPermit2Approval: { token: asset, spender: PERMIT2_ADDRESS, amount } };
    const nonce = BigInt(randomBytes32());
    const typedData = {
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS },
      types: PERMIT_WITNESS_TYPES,
      primaryType: "PermitWitnessTransferFrom",
      message: { permitted: { token: asset, amount }, spender, nonce, deadline: validBefore, witness: { to: payTo, validAfter } },
    } as const;
    const signature = await checkedSignature(typedData, await deps.signer.signTypedData(typedData), from);
    payload = {
      signature,
      permit2Authorization: {
        permitted: { token: asset, amount: req.amount },
        from,
        spender,
        nonce: nonce.toString(),
        deadline: validBefore.toString(),
        witness: { to: payTo, validAfter: validAfter.toString() },
      },
    };
  }
  const paymentPayload = { x402Version: 2, resource: { url }, accepted: structuredClone(requirement), payload };
  return { headerValue: toBase64(JSON.stringify(paymentPayload)), needsPermit2Approval: null };
}

/**
 * The approval buildPayment asks for: approve(Permit2, amount) on the token, for exactly the
 * payment's amount and never the unlimited amount b402's guide suggests (C21). Throws
 * PaymentRequestError when the token is not one of WRAP_ASSETS, the spender is not Permit2, or the
 * amount is zero or the unlimited value.
 */
export function permit2ApprovalTx(approval: Permit2Approval): { to: Address; data: Hex; value: 0n } {
  const refused = new PaymentRequestError("That approval is not the one a wrapping fee needs, so it was not sent.");
  let token: Address;
  let spender: Address;
  try {
    token = getAddress(approval.token);
    spender = getAddress(approval.spender);
  } catch {
    throw refused;
  }
  if (!WRAP_ASSETS.some((a) => a.address === token) || spender !== PERMIT2_ADDRESS) throw refused;
  if (typeof approval.amount !== "bigint" || approval.amount <= 0n || approval.amount >= maxUint256) throw refused;
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, approval.amount] }), value: 0n };
}
