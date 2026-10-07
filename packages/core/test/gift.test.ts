// Not covered here: running in a real browser (this suite runs on Node's Web Crypto, the same
// standard API, and gift.ts imports nothing Node-only), how the claim page keeps the key out of
// requests and renders the note (C12, C13, C14), and the vault's own signature checks, which the
// parity tests below tie to through packages/contracts/test/vectors/claim.json and register.json.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bytesToHex,
  concat,
  domainSeparator,
  encodeAbiParameters,
  getAddress,
  hashStruct,
  hexToBytes,
  keccak256,
  parseAbiParameters,
  parseSignature,
  recoverTypedDataAddress,
  toBytes,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  buildLink,
  CLAIM_TYPES,
  claimDigest,
  claimDomain,
  claimKeyMatches,
  LinkError,
  MAX_NOTE_BYTES,
  MAX_NOTE_PLAINTEXT_BYTES,
  newClaimKey,
  openNote,
  parseClaimKey,
  parseGiftId,
  parseLink,
  REGISTER_TYPES,
  registerDigest,
  sealNote,
  signClaim,
  signKeyProof,
} from "../src/gift.js";

const HEX64 = "ab".repeat(32);
const UINT256_MAX = (1n << 256n) - 1n;
const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const RECIPIENT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const OTHER = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const ORIGIN = "https://moi.gift";

function expectLinkError(fn: () => unknown, kind: "damaged" | "invalid") {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(LinkError);
  expect((caught as LinkError).kind).toBe(kind);
}

async function expectLinkErrorAsync(promise: Promise<unknown>, kind: "damaged" | "invalid") {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof LinkError && e.kind === kind);
}

describe("newClaimKey", () => {
  it("returns 1000 distinct keys, each with the address it derives", () => {
    const keys = new Set<string>();
    const addresses = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { privateKey, address } = newClaimKey();
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(address).toBe(privateKeyToAccount(privateKey).address);
      keys.add(privateKey);
      addresses.add(address);
    }
    expect(keys.size).toBe(1000);
    expect(addresses.size).toBe(1000);
  }, 30_000);

  it("draws from crypto.getRandomValues and never from Math.random (C11)", () => {
    const webRandom = vi.spyOn(globalThis.crypto, "getRandomValues");
    const mathRandom = vi.spyOn(Math, "random");
    try {
      newClaimKey();
      expect(webRandom).toHaveBeenCalled();
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      webRandom.mockRestore();
      mathRandom.mockRestore();
    }
  });
});

describe("parseClaimKey", () => {
  it("accepts 64 hex characters with or without 0x, in any case, and returns lowercase 0x", () => {
    expect(parseClaimKey(HEX64)).toBe(`0x${HEX64}`);
    expect(parseClaimKey(`0x${HEX64}`)).toBe(`0x${HEX64}`);
    expect(parseClaimKey(HEX64.toUpperCase())).toBe(`0x${HEX64}`);
    expect(parseClaimKey(`0x${HEX64.toUpperCase()}`)).toBe(`0x${HEX64}`);
  });

  it.each([
    ["63 characters", HEX64.slice(1)],
    ["65 characters", `${HEX64}a`],
    ["a trailing full stop", `${HEX64}.`],
    ["a trailing bracket", `${HEX64})`],
    ["an inner space", `${HEX64.slice(0, 30)} ${HEX64.slice(31)}`],
    ["g characters", `${HEX64.slice(0, 62)}gg`],
    ["an empty string", ""],
    ["a leading space", ` ${HEX64}`],
    ["a trailing newline", `${HEX64}\n`],
    ["0x alone", "0x"],
  ])("refuses %s as damaged", (_label, input) => {
    expectLinkError(() => parseClaimKey(input), "damaged");
  });
});

describe("parseGiftId", () => {
  it("accepts 1 and 2^256 - 1", () => {
    expect(parseGiftId("1")).toBe(1n);
    expect(parseGiftId(UINT256_MAX.toString())).toBe(UINT256_MAX);
    expect(parseGiftId("42")).toBe(42n);
  });

  it.each(["", "0", "01", "-1", "+1", "0x1", "1.0", "1e3", (1n << 256n).toString(), " 1", "1 ", "1\n", "١", "1".repeat(200)])(
    "refuses %j as damaged",
    (input) => {
      expectLinkError(() => parseGiftId(input), "damaged");
    },
  );
});

describe("buildLink and parseLink", () => {
  it("round-trips a link and puts the key in the fragment without 0x", () => {
    const { privateKey } = newClaimKey();
    const link = buildLink(ORIGIN, 7n, privateKey);
    expect(link).toBe(`${ORIGIN}/g/7#${privateKey.slice(2)}`);
    expect(parseLink(link)).toEqual({ origin: ORIGIN, giftId: 7n, claimKey: privateKey });

    const local = buildLink("http://localhost:3000/", UINT256_MAX, privateKey);
    expect(parseLink(local)).toEqual({ origin: "http://localhost:3000", giftId: UINT256_MAX, claimKey: privateKey });
  });

  it("normalises a fragment with 0x or uppercase through parseClaimKey", () => {
    expect(parseLink(`${ORIGIN}/g/3#0x${HEX64.toUpperCase()}`).claimKey).toBe(`0x${HEX64}`);
  });

  it("refuses a non-https origin, except http on localhost", () => {
    for (const origin of ["http://moi.gift", "http://127.0.0.1:3000", "ftp://moi.gift", "javascript:alert(1)", "http://localhost.evil.com"]) {
      expectLinkError(() => buildLink(origin, 1n, `0x${HEX64}`), "invalid");
    }
    expectLinkError(() => parseLink(`http://moi.gift/g/1#${HEX64}`), "invalid");
    expectLinkError(() => parseLink(`javascript:alert(1)//#${HEX64}`), "invalid");
    expect(parseLink(`http://localhost/g/1#${HEX64}`).giftId).toBe(1n);
  });

  it("refuses an origin with a path, query, fragment or user name, and text that is not a URL", () => {
    for (const origin of [`${ORIGIN}/app`, `${ORIGIN}/g`, `${ORIGIN}?x=1`, `${ORIGIN}?`, `${ORIGIN}#x`, "https://user@moi.gift"]) {
      expectLinkError(() => buildLink(origin, 1n, `0x${HEX64}`), "invalid");
    }
    expectLinkError(() => buildLink("moi.gift", 1n, `0x${HEX64}`), "damaged");
  });

  it("refuses a bad gift id or key when building", () => {
    expectLinkError(() => buildLink(ORIGIN, 0n, `0x${HEX64}`), "damaged");
    expectLinkError(() => buildLink(ORIGIN, -1n, `0x${HEX64}`), "damaged");
    expectLinkError(() => buildLink(ORIGIN, 1n << 256n, `0x${HEX64}`), "damaged");
    expectLinkError(() => buildLink(ORIGIN, 1n, `0x${HEX64}.`), "damaged");
  });

  it.each(["/", "/g", "/g/", "/g/1/", "/g/1/x", "/G/1", "/gift/1", "/x/g/1", "/g/01", "/g/0x1", "/g/%31"])(
    "refuses the path %s",
    (path) => {
      expectLinkError(() => parseLink(`${ORIGIN}${path}#${HEX64}`), "damaged");
    },
  );

  it("refuses a missing, empty or damaged fragment", () => {
    expectLinkError(() => parseLink(`${ORIGIN}/g/1`), "damaged");
    expectLinkError(() => parseLink(`${ORIGIN}/g/1#`), "damaged");
    expectLinkError(() => parseLink(`${ORIGIN}/g/1#${HEX64}.`), "damaged");
    expectLinkError(() => parseLink(`${ORIGIN}/g/1#${HEX64})`), "damaged");
  });

  it("refuses a query, a user name, text that is not a URL and an oversized link", () => {
    expectLinkError(() => parseLink(`${ORIGIN}/g/1?ref=x#${HEX64}`), "damaged");
    expectLinkError(() => parseLink(`${ORIGIN}/g/1?#${HEX64}`), "damaged");
    expectLinkError(() => parseLink(`https://user:pw@moi.gift/g/1#${HEX64}`), "damaged");
    expectLinkError(() => parseLink(`moi.gift/g/1#${HEX64}`), "damaged");
    expectLinkError(() => parseLink(`${ORIGIN}/g/1#${HEX64}${"a".repeat(2048)}`), "damaged");
  });
});

describe("claim signature", () => {
  it("signs a 65-byte low-s signature that recovers to the claim key's address", async () => {
    const { privateKey, address } = newClaimKey();
    const signature = await signClaim(privateKey, VAULT, 56, 9n, RECIPIENT);
    expect(hexToBytes(signature).length).toBe(65);
    const { s, v } = parseSignature(signature);
    const halfOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    expect(BigInt(s) <= halfOrder).toBe(true);
    expect([27n, 28n]).toContain(v);
    const recovered = await recoverTypedDataAddress({
      domain: claimDomain(VAULT, 56),
      types: CLAIM_TYPES,
      primaryType: "Claim",
      message: { giftId: 9n, recipient: RECIPIENT },
      signature,
    });
    expect(recovered).toBe(address);
  });

  it("normalises the recipient, so lowercase and checksummed give the same signature", async () => {
    const { privateKey } = newClaimKey();
    const lower = RECIPIENT.toLowerCase() as `0x${string}`;
    expect(await signClaim(privateKey, VAULT, 56, 9n, lower)).toBe(await signClaim(privateKey, VAULT, 56, 9n, RECIPIENT));
    expect(claimDigest(VAULT, 56, 9n, lower)).toBe(claimDigest(VAULT, 56, 9n, RECIPIENT));
  });

  it("matches a hand-built EIP-712 digest over Claim(uint256 giftId,address recipient)", () => {
    const domainTypeHash = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    const claimTypeHash = keccak256(toBytes("Claim(uint256 giftId,address recipient)"));
    const separator = keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [
        domainTypeHash,
        keccak256(toBytes("Moi")),
        keccak256(toBytes("1")),
        97n,
        VAULT,
      ]),
    );
    const structHash = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256, address"), [claimTypeHash, 12n, RECIPIENT]));
    expect(claimDigest(VAULT, 97, 12n, RECIPIENT)).toBe(keccak256(concat(["0x1901", separator, structHash])));
  });

  it("changes the digest when the vault, chain id, gift id or recipient changes", () => {
    const base = claimDigest(VAULT, 56, 9n, RECIPIENT);
    const variants = [
      claimDigest(OTHER, 56, 9n, RECIPIENT),
      claimDigest(VAULT, 97, 9n, RECIPIENT),
      claimDigest(VAULT, 56, 10n, RECIPIENT),
      claimDigest(VAULT, 56, 9n, OTHER),
    ];
    for (const digest of variants) expect(digest).not.toBe(base);
    expect(new Set(variants).size).toBe(4);
  });

  it("refuses a bad chain id, gift id or address, and a key that cannot sign", async () => {
    for (const chainId of [0, -1, 1.5, Number.NaN]) expect(() => claimDomain(VAULT, chainId)).toThrow();
    expect(() => claimDomain("0x1234", 56)).toThrow();
    expectLinkError(() => claimDigest(VAULT, 56, 0n, RECIPIENT), "damaged");
    expect(() => claimDigest(VAULT, 56, 1n, "0xnot-an-address")).toThrow();
    await expectLinkErrorAsync(signClaim(`0x${"00".repeat(32)}`, VAULT, 56, 1n, RECIPIENT), "invalid");
    await expectLinkErrorAsync(signClaim(`0x${"ff".repeat(32)}`, VAULT, 56, 1n, RECIPIENT), "invalid");
    await expectLinkErrorAsync(signClaim(`0x${HEX64}.` as `0x${string}`, VAULT, 56, 1n, RECIPIENT), "damaged");
  });
});

describe("claimKeyMatches (C15)", () => {
  it("is true for the key's own stored address, in any letter case", async () => {
    const { privateKey, address } = newClaimKey();
    expect(claimKeyMatches(privateKey, address)).toBe(true);
    expect(claimKeyMatches(privateKey, address.toLowerCase() as `0x${string}`)).toBe(true);
    expect(claimKeyMatches(privateKey.toUpperCase().replace("0X", "0x") as `0x${string}`, address)).toBe(true);
  });

  it("is false for another key, a missing gift, a malformed address and an unusable or damaged key", async () => {
    const { privateKey } = newClaimKey();
    const other = newClaimKey();
    expect(claimKeyMatches(privateKey, other.address)).toBe(false);
    expect(claimKeyMatches(privateKey, zeroAddress)).toBe(false);
    expect(claimKeyMatches(privateKey, "0x1234")).toBe(false);
    expect(claimKeyMatches(`0x${"00".repeat(32)}`, zeroAddress)).toBe(false);
    expect(claimKeyMatches(`0x${"ff".repeat(32)}`, other.address)).toBe(false);
    expect(claimKeyMatches(`${privateKey}.` as `0x${string}`, privateKeyToAccount(privateKey).address)).toBe(false);
  });
});

describe("key proof (C32)", () => {
  const SENDER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");

  it("signs a 65-byte low-s proof that recovers to the claim key's address for its sender", async () => {
    const { privateKey, address } = newClaimKey();
    const proof = await signKeyProof(privateKey, VAULT, 56, SENDER);
    expect(hexToBytes(proof).length).toBe(65);
    const { s, v } = parseSignature(proof);
    expect(BigInt(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
    expect([27n, 28n]).toContain(v);
    const recovered = await recoverTypedDataAddress({
      domain: claimDomain(VAULT, 56),
      types: REGISTER_TYPES,
      primaryType: "RegisterGift",
      message: { sender: SENDER },
      signature: proof,
    });
    expect(recovered).toBe(address);
  });

  it("does not verify for another sender: copied into a transaction from another address it names someone else", async () => {
    const { privateKey, address } = newClaimKey();
    const proof = await signKeyProof(privateKey, VAULT, 56, SENDER);
    const forOther = await recoverTypedDataAddress({
      domain: claimDomain(VAULT, 56),
      types: REGISTER_TYPES,
      primaryType: "RegisterGift",
      message: { sender: OTHER },
      signature: proof,
    });
    expect(forOther).not.toBe(address);
    expect(await signKeyProof(privateKey, VAULT, 56, OTHER)).not.toBe(proof);
  });

  it("matches a hand-built EIP-712 digest over RegisterGift(address sender) and normalises the sender", async () => {
    const domainTypeHash = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    const registerTypeHash = keccak256(toBytes("RegisterGift(address sender)"));
    const separator = keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [
        domainTypeHash,
        keccak256(toBytes("Moi")),
        keccak256(toBytes("1")),
        56n,
        VAULT,
      ]),
    );
    const structHash = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, address"), [registerTypeHash, SENDER]));
    expect(registerDigest(VAULT, 56, SENDER)).toBe(keccak256(concat(["0x1901", separator, structHash])));
    const lower = SENDER.toLowerCase() as `0x${string}`;
    expect(registerDigest(VAULT, 56, lower)).toBe(registerDigest(VAULT, 56, SENDER));
    const { privateKey } = newClaimKey();
    expect(await signKeyProof(privateKey, VAULT, 56, lower)).toBe(await signKeyProof(privateKey, VAULT, 56, SENDER));
  });

  it("changes the digest when the vault, chain id or sender changes, and never equals a claim digest", () => {
    const base = registerDigest(VAULT, 56, SENDER);
    const variants = [registerDigest(OTHER, 56, SENDER), registerDigest(VAULT, 97, SENDER), registerDigest(VAULT, 56, OTHER)];
    for (const digest of variants) expect(digest).not.toBe(base);
    expect(new Set(variants).size).toBe(3);
    expect(base).not.toBe(claimDigest(VAULT, 56, 1n, SENDER));
  });

  it("refuses a bad chain id or address, and a key that cannot sign", async () => {
    for (const chainId of [0, -1, 1.5, Number.NaN]) expect(() => registerDigest(VAULT, chainId, SENDER)).toThrow();
    expect(() => registerDigest("0x1234", 56, SENDER)).toThrow();
    expect(() => registerDigest(VAULT, 56, "0xnot-an-address")).toThrow();
    await expect(signKeyProof(newClaimKey().privateKey, VAULT, 56, "0x1234")).rejects.toThrow();
    await expectLinkErrorAsync(signKeyProof(`0x${"00".repeat(32)}`, VAULT, 56, SENDER), "invalid");
    await expectLinkErrorAsync(signKeyProof(`0x${HEX64}.` as `0x${string}`, VAULT, 56, SENDER), "damaged");
  });
});

describe("sealed note (C9)", () => {
  const key = newClaimKey().privateKey;

  it("round-trips ASCII, Tamil and emoji, and an empty note is 0x", async () => {
    for (const text of ["Happy birthday, Anu. Hold this one for ten years.", "இனிய பிறந்தநாள் வாழ்த்துகள்", "\u{1F381}\u{1F680} a gift for you \u{1F315}", "﻿starts with a BOM"]) {
      expect(await openNote(key, await sealNote(key, text))).toBe(text);
    }
    expect(await sealNote(key, "")).toBe("0x");
    expect(await openNote(key, "0x")).toBe("");
  });

  it("seals a 483-byte note to exactly 512 bytes and refuses 484 bytes", async () => {
    expect(MAX_NOTE_PLAINTEXT_BYTES).toBe(483);
    const longest = "a".repeat(483);
    const sealed = await sealNote(key, longest);
    expect(hexToBytes(sealed).length).toBe(MAX_NOTE_BYTES);
    expect(await openNote(key, sealed)).toBe(longest);
    await expect(sealNote(key, "a".repeat(484))).rejects.toBeInstanceOf(RangeError);

    // Tamil letters are 3 bytes each, so the cap counts bytes, not characters.
    expect(await openNote(key, await sealNote(key, "அ".repeat(161)))).toBe("அ".repeat(161));
    await expect(sealNote(key, "அ".repeat(162))).rejects.toBeInstanceOf(RangeError);
  });

  it("refuses to open with the wrong key", async () => {
    const sealed = await sealNote(key, "only for the link holder");
    await expectLinkErrorAsync(openNote(newClaimKey().privateKey, sealed), "invalid");
  });

  it("refuses a blob with any single byte flipped in the IV, ciphertext or tag", async () => {
    const bytes = hexToBytes(await sealNote(key, "tamper with me"));
    for (let i = 1; i < bytes.length; i++) {
      const copy = bytes.slice();
      copy[i] = copy[i]! ^ 0x01;
      await expectLinkErrorAsync(openNote(key, bytesToHex(copy)), "invalid");
    }
  });

  it("refuses a wrong version byte", async () => {
    const bytes = hexToBytes(await sealNote(key, "version check"));
    for (const version of [0x00, 0x02, 0xff]) {
      const copy = bytes.slice();
      copy[0] = version;
      await expectLinkErrorAsync(openNote(key, bytesToHex(copy)), "invalid");
    }
  });

  it("refuses truncated, oversized and malformed blobs", async () => {
    const sealed = await sealNote(key, "cut short");
    await expectLinkErrorAsync(openNote(key, sealed.slice(0, -2) as `0x${string}`), "invalid");
    await expectLinkErrorAsync(openNote(key, sealed.slice(0, 2 + 2 * 29) as `0x${string}`), "invalid");
    await expectLinkErrorAsync(openNote(key, "0x01"), "invalid");
    await expectLinkErrorAsync(openNote(key, bytesToHex(new Uint8Array(MAX_NOTE_BYTES + 1).fill(1))), "invalid");
    await expectLinkErrorAsync(openNote(key, `${sealed}0` as `0x${string}`), "invalid");
    await expectLinkErrorAsync(openNote(key, "0xzz" as `0x${string}`), "invalid");
  });

  it("seals the same text differently each time, because the IV is fresh", async () => {
    const a = await sealNote(key, "same words");
    const b = await sealNote(key, "same words");
    expect(a).not.toBe(b);
    expect(a.slice(4, 28)).not.toBe(b.slice(4, 28));
  });

  it("uses the stated format: HKDF-SHA256 (salt moi-note-v1, info note) into AES-256-GCM, laid out as version, IV, ciphertext, tag", async () => {
    const aesKey = Buffer.from(hkdfSync("sha256", Buffer.from(key.slice(2), "hex"), "moi-note-v1", "note", 32));
    const blob = Buffer.from((await sealNote(key, "checked by node:crypto")).slice(2), "hex");
    expect(blob[0]).toBe(0x01);
    const decipher = createDecipheriv("aes-256-gcm", aesKey, blob.subarray(1, 13));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    expect(Buffer.concat([decipher.update(blob.subarray(13, blob.length - 16)), decipher.final()]).toString("utf8")).toBe(
      "checked by node:crypto",
    );

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
    const body = Buffer.concat([cipher.update("sealed by node:crypto", "utf8"), cipher.final()]);
    const foreign = `0x${Buffer.concat([Buffer.from([0x01]), iv, body, cipher.getAuthTag()]).toString("hex")}` as `0x${string}`;
    expect(await openNote(key, foreign)).toBe("sealed by node:crypto");
  });
});

const VECTOR_PATH = fileURLToPath(new URL("../../contracts/test/vectors/claim.json", import.meta.url));

describe("parity with the vault's Solidity tests", () => {
  it("claimDigest equals the contracts vector digest (skips while packages/contracts/test/vectors/claim.json is pending)", (ctx) => {
    if (!existsSync(VECTOR_PATH)) {
      ctx.skip("contracts vector pending: packages/contracts/test/vectors/claim.json does not exist yet");
    }
    const raw: unknown = JSON.parse(readFileSync(VECTOR_PATH, "utf8"));
    const vectors = Array.isArray(raw) ? raw : [raw];
    expect(vectors.length).toBeGreaterThan(0);
    for (const v of vectors) {
      expect(v, "each vector needs vault, chainId, giftId, recipient and digest").toMatchObject({
        vault: expect.any(String),
        chainId: expect.anything(),
        giftId: expect.anything(),
        recipient: expect.anything(),
        digest: expect.any(String),
      });
      const { vault, chainId, giftId, recipient, digest } = v as Record<string, string | number>;
      expect(claimDigest(String(vault) as `0x${string}`, Number(chainId), parseGiftId(String(giftId)), String(recipient) as `0x${string}`)).toBe(
        String(digest).toLowerCase(),
      );
    }
  });

  it("registerDigest, its domain separator and its struct hash equal the contracts register vector", () => {
    const path = fileURLToPath(new URL("../../contracts/test/vectors/register.json", import.meta.url));
    const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(["chainId", "digest", "domainSeparator", "sender", "structHash", "vault"]);
    const vault = String(v.vault) as `0x${string}`;
    const sender = String(v.sender) as `0x${string}`;
    const chainId = Number(v.chainId);
    expect(chainId).toBe(56);
    expect(domainSeparator({ domain: claimDomain(vault, chainId) })).toBe(String(v.domainSeparator).toLowerCase());
    expect(hashStruct({ data: { sender: getAddress(sender) }, primaryType: "RegisterGift", types: REGISTER_TYPES })).toBe(
      String(v.structHash).toLowerCase(),
    );
    expect(registerDigest(vault, chainId, sender)).toBe(String(v.digest).toLowerCase());
  });
});
