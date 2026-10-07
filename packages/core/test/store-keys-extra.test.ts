import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { keys } from "../src/store.js";

const vault = "0x808e0000000000000000000000000000000c975c";
const relayer = "0x93596EBf4e4B3ACEAb8Af2B4FeA6157e3F7fb7A9";
const payTo = "0x96e854abddc5c618ca843956d1303017b586ab75";

describe("store keys added for nonce gaps and b402 wrapping", () => {
  it("builds canonical relayer transaction keys and refuses bad nonces", () => {
    expect(keys.relayerTx(relayer, 7n)).toBe("moi:v1:56:0x93596EBf4e4B3ACEAb8Af2B4FeA6157e3F7fb7A9:relayertx:7");
    expect(() => keys.relayerTx(relayer, -1n)).toThrow(RangeError);
    expect(() => keys.relayerTx(relayer, 1n << 64n)).toThrow(RangeError);
  });
  it("scopes wrapped records to the vault and parses the gift id", () => {
    expect(keys.wrapped(vault, 1n)).toBe(`moi:v1:56:${getAddress(vault)}:wrapped:1`);
    expect(() => keys.wrapped(vault, 0n)).toThrow();
  });
  it("scopes payment nonces to the payee and lowercases them", () => {
    const n = `0x${"AB".repeat(32)}`;
    expect(keys.paymentAuth(payTo, n)).toBe(`moi:v1:56:0x96E854aBDdc5C618ca843956d1303017b586aB75:paymentauth:0x${"ab".repeat(32)}`);
    expect(() => keys.paymentAuth(payTo, "0x1234")).toThrow(RangeError);
    expect(() => keys.paymentAuth("0xnotanaddress" as `0x${string}`, n)).toThrow(RangeError);
  });
});

describe("judge gift keys", () => {
  const h = `0x${"cd".repeat(32)}`;
  it("builds canonical judge keys scoped to the vault", () => {
    expect(keys.judgeUser(vault, h)).toBe(`moi:v1:56:${getAddress(vault)}:judgeuser:${h}`);
    expect(keys.judgeIpDay(vault, h, "2026-10-08")).toBe(`moi:v1:56:${getAddress(vault)}:judgeip:${h}-2026-10-08`);
    expect(keys.judgeGiftTaken(vault, 12n)).toBe(`moi:v1:56:${getAddress(vault)}:judgegift:12`);
  });
  it("refuses unhashed identities and bad days", () => {
    expect(() => keys.judgeUser(vault, "did:privy:abc")).toThrow(RangeError);
    expect(() => keys.judgeIpDay(vault, h, "2026-02-30")).toThrow(RangeError);
  });
});
