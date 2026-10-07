// Covers the sender's approve and createGift builders and the gift id read from a receipt.
// Not covered here: whether the vault accepts the transaction on chain (the token list, a reused
// claim key and a key proof for the wrong sender are the vault's to refuse; prove.fork.test.ts
// sends a real one), and wallet signing.
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseAbi,
  recoverTypedDataAddress,
  zeroAddress,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  buildApproveVaultTx,
  buildCreateGiftTx,
  CreateGiftInputError,
  defaultExpiry,
  MAX_GIFT_USD,
  readGiftIdFromReceipt,
} from "../src/create.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { claimDomain, newClaimKey, REGISTER_TYPES, signKeyProof } from "../src/gift.js";

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const OTHER = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const CLAIM_KEY = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const SENDER = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const NOW = 1_791_000_000n;
const MINUTE = 60n;
const HOUR = 3_600n;
const DAY = 86_400n;
const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const base = {
  vault: VAULT,
  token: NVDAB,
  amount: 2_964_217_000_000_000n,
  claimKeyAddress: CLAIM_KEY,
  expiry: NOW + 30n * DAY,
  sealedNote: `0x01${"ab".repeat(40)}` as Hex,
  keyProof: `0x${"cd".repeat(64)}1b` as Hex,
  nowSeconds: NOW,
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof CreateGiftInputError) return err.code;
    throw err;
  }
  throw new Error("did not throw");
}

function giftCreatedLog(emitter: string, giftId: bigint) {
  return {
    address: emitter,
    topics: encodeEventTopics({ abi: giftVaultAbi, eventName: "GiftCreated", args: { giftId, token: NVDAB, sender: SENDER } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [CLAIM_KEY, 5n, NOW + DAY]),
  };
}

function tokenListedLog(emitter: string) {
  return {
    address: emitter,
    topics: encodeEventTopics({ abi: giftVaultAbi, eventName: "TokenListed", args: { token: NVDAB } }) as Hex[],
    data: encodeAbiParameters([{ type: "bool" }], [true]),
  };
}

describe("constants", () => {
  it("caps gifts at 100 dollars and defaults the expiry to 30 days", () => {
    expect(MAX_GIFT_USD).toBe("100");
    expect(defaultExpiry(NOW)).toBe(NOW + 30n * DAY);
  });
});

describe("buildCreateGiftTx", () => {
  it("encodes createGift to the vault with no value, and the calldata decodes back exactly", () => {
    const tx = buildCreateGiftTx(base);
    expect(tx.to).toBe(VAULT);
    expect(tx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: giftVaultAbi, data: tx.data });
    expect(decoded.functionName).toBe("createGift");
    expect(decoded.args).toEqual([NVDAB, base.amount, CLAIM_KEY, base.expiry, base.sealedNote, base.keyProof]);
  });

  it("carries a signKeyProof proof that still recovers to the claim key for its sender, and not for another (C32)", async () => {
    const key = newClaimKey();
    const keyProof = await signKeyProof(key.privateKey, VAULT, 56, SENDER);
    const tx = buildCreateGiftTx({ ...base, claimKeyAddress: key.address, keyProof });
    const decoded = decodeFunctionData({ abi: giftVaultAbi, data: tx.data });
    if (decoded.functionName !== "createGift") throw new Error("not createGift");
    const carried = decoded.args[5];
    const signerFor = (sender: Hex) =>
      recoverTypedDataAddress({ domain: claimDomain(VAULT, 56), types: REGISTER_TYPES, primaryType: "RegisterGift", message: { sender }, signature: carried });
    expect(await signerFor(SENDER)).toBe(key.address);
    expect(await signerFor(OTHER)).not.toBe(key.address);
  });

  it("refuses a key proof that is not exactly 65 bytes of hex", () => {
    expect(codeOf(() => buildCreateGiftTx({ ...base, keyProof: `0x${"cd".repeat(64)}` }))).toBe("bad_key_proof");
    expect(codeOf(() => buildCreateGiftTx({ ...base, keyProof: `0x${"cd".repeat(66)}` }))).toBe("bad_key_proof");
    expect(codeOf(() => buildCreateGiftTx({ ...base, keyProof: `0x${"zz".repeat(65)}` }))).toBe("bad_key_proof");
    expect(codeOf(() => buildCreateGiftTx({ ...base, keyProof: "0x" }))).toBe("bad_key_proof");
    expect(codeOf(() => buildCreateGiftTx({ ...base, keyProof: "cd".repeat(65) as Hex }))).toBe("bad_key_proof");
    expect(codeOf(() => buildCreateGiftTx({ ...base, keyProof: undefined as unknown as Hex }))).toBe("bad_key_proof");
  });

  it("accepts both ends of the 1 hour 10 minute to 90 day window and an empty note", () => {
    expect(() => buildCreateGiftTx({ ...base, expiry: NOW + HOUR + 10n * MINUTE })).not.toThrow();
    expect(() => buildCreateGiftTx({ ...base, expiry: NOW + 90n * DAY })).not.toThrow();
    expect(() => buildCreateGiftTx({ ...base, sealedNote: "0x" })).not.toThrow();
    expect(() => buildCreateGiftTx({ ...base, sealedNote: `0x${"00".repeat(512)}` })).not.toThrow();
  });

  it("refuses an expiry just outside the window, in the past, or in milliseconds", () => {
    // Exactly the vault's own 1 hour bound is refused: it would revert once the transaction lands later.
    expect(codeOf(() => buildCreateGiftTx({ ...base, expiry: NOW + HOUR }))).toBe("expiry_out_of_range");
    expect(codeOf(() => buildCreateGiftTx({ ...base, expiry: NOW + HOUR + 10n * MINUTE - 1n }))).toBe("expiry_out_of_range");
    expect(codeOf(() => buildCreateGiftTx({ ...base, expiry: NOW + 90n * DAY + 1n }))).toBe("expiry_out_of_range");
    expect(codeOf(() => buildCreateGiftTx({ ...base, expiry: NOW - DAY }))).toBe("expiry_out_of_range");
    expect(codeOf(() => buildCreateGiftTx({ ...base, expiry: (NOW + DAY) * 1000n }))).toBe("expiry_out_of_range");
    expect(codeOf(() => buildCreateGiftTx({ ...base, nowSeconds: 0n }))).toBe("expiry_out_of_range");
  });

  it("refuses a sealed note above 512 bytes or not even-length hex", () => {
    expect(codeOf(() => buildCreateGiftTx({ ...base, sealedNote: `0x${"00".repeat(513)}` }))).toBe("note_too_long");
    expect(codeOf(() => buildCreateGiftTx({ ...base, sealedNote: "0xabc" }))).toBe("bad_note");
    expect(codeOf(() => buildCreateGiftTx({ ...base, sealedNote: "hello" as Hex }))).toBe("bad_note");
    expect(codeOf(() => buildCreateGiftTx({ ...base, sealedNote: "0xzz" }))).toBe("bad_note");
  });

  it("refuses a zero amount and a zero claim key", () => {
    expect(codeOf(() => buildCreateGiftTx({ ...base, amount: 0n }))).toBe("zero_amount");
    expect(codeOf(() => buildCreateGiftTx({ ...base, amount: -1n }))).toBe("zero_amount");
    expect(codeOf(() => buildCreateGiftTx({ ...base, claimKeyAddress: zeroAddress }))).toBe("zero_claim_key");
  });

  it("refuses a malformed or zero vault, token or claim key address", () => {
    expect(codeOf(() => buildCreateGiftTx({ ...base, vault: zeroAddress }))).toBe("bad_address");
    expect(codeOf(() => buildCreateGiftTx({ ...base, token: "0x1234" }))).toBe("bad_address");
    expect(codeOf(() => buildCreateGiftTx({ ...base, claimKeyAddress: "0xnot-an-address" }))).toBe("bad_address");
  });
});

describe("buildApproveVaultTx", () => {
  it("approves the vault for exactly the gift amount, byte for byte, on the token", () => {
    const amount = 2_964_217_000_000_000n;
    const tx = buildApproveVaultTx({ token: NVDAB, amount, vault: VAULT });
    expect(tx.to).toBe(NVDAB);
    expect(tx.value).toBe(0n);
    // The same re-encode and byte comparison checks.ts checkApproveTx uses for the router.
    const canonical = encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [VAULT, amount] });
    expect(tx.data.toLowerCase()).toBe(canonical.toLowerCase());
    const decoded = decodeFunctionData({ abi: approveAbi, data: tx.data });
    expect(decoded.args).toEqual([VAULT, amount]);
    expect(decoded.args[1]).not.toBe(maxUint256);
  });

  it("refuses a zero amount and a zero vault or token", () => {
    expect(codeOf(() => buildApproveVaultTx({ token: NVDAB, amount: 0n, vault: VAULT }))).toBe("zero_amount");
    expect(codeOf(() => buildApproveVaultTx({ token: NVDAB, amount: 1n, vault: zeroAddress }))).toBe("bad_address");
    expect(codeOf(() => buildApproveVaultTx({ token: zeroAddress, amount: 1n, vault: VAULT }))).toBe("bad_address");
  });
});

describe("readGiftIdFromReceipt", () => {
  it("reads the id from the vault's own GiftCreated log and ignores other events", () => {
    const receipt = { status: "success", logs: [tokenListedLog(VAULT), giftCreatedLog(VAULT.toLowerCase(), 7n)] };
    expect(readGiftIdFromReceipt(receipt, VAULT)).toBe(7n);
  });

  it("ignores a GiftCreated log from another address", () => {
    const receipt = { status: "success", logs: [giftCreatedLog(OTHER, 99n), giftCreatedLog(VAULT, 3n)] };
    expect(readGiftIdFromReceipt(receipt, VAULT)).toBe(3n);
    expect(() => readGiftIdFromReceipt({ status: "success", logs: [giftCreatedLog(OTHER, 99n)] }, VAULT)).toThrow(/found 0/);
  });

  it("throws on zero or two GiftCreated logs from the vault, and on a reverted receipt", () => {
    expect(() => readGiftIdFromReceipt({ status: "success", logs: [] }, VAULT)).toThrow(/found 0/);
    expect(() => readGiftIdFromReceipt({ status: "success", logs: [giftCreatedLog(VAULT, 1n), giftCreatedLog(VAULT, 2n)] }, VAULT)).toThrow(/found 2/);
    expect(() => readGiftIdFromReceipt({ status: "reverted", logs: [giftCreatedLog(VAULT, 1n)] }, VAULT)).toThrow(/did not succeed/);
  });
});
