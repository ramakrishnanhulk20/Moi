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
  it("scopes payment nonces to the payee and the payer, and lowercases them", () => {
    const n = `0x${"AB".repeat(32)}`;
    const payer = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    expect(keys.paymentAuth(payTo, payer, n)).toBe(
      `moi:v1:56:0x96E854aBDdc5C618ca843956d1303017b586aB75:paymentauth:${getAddress(payer)}-0x${"ab".repeat(32)}`,
    );
    expect(keys.paymentAuth(payTo, payer, n)).not.toBe(keys.paymentAuth(payTo, relayer, n));
    expect(() => keys.paymentAuth(payTo, payer, "0x1234")).toThrow(RangeError);
    expect(() => keys.paymentAuth("0xnotanaddress" as `0x${string}`, payer, n)).toThrow(RangeError);
    expect(() => keys.paymentAuth(payTo, "0x1234" as `0x${string}`, n)).toThrow(RangeError);
  });
  it("binds one Transfer of one settlement receipt per key, under the payee", () => {
    const tx = `0x${"CD".repeat(32)}`;
    expect(keys.settlementUsed(payTo, tx, 3)).toBe(`moi:v1:56:0x96E854aBDdc5C618ca843956d1303017b586aB75:settlement:0x${"cd".repeat(32)}-3`);
    expect(keys.settlementUsed(payTo, tx, 0)).not.toBe(keys.settlementUsed(payTo, tx, 1));
    expect(() => keys.settlementUsed(payTo, "0x1234", 0)).toThrow(RangeError);
    expect(() => keys.settlementUsed(payTo, tx, -1)).toThrow(RangeError);
    expect(() => keys.settlementUsed(payTo, tx, 1.5)).toThrow(RangeError);
  });
});

describe("judge gift keys", () => {
  const h = `0x${"cd".repeat(32)}`;
  it("builds canonical judge keys scoped to the vault", () => {
    expect(keys.judgeUser(vault, h)).toBe(`moi:v1:56:${getAddress(vault)}:judgeuser:${h}`);
    expect(keys.judgeNetworkDay(vault, h, "2026-10-08")).toBe(`moi:v1:56:${getAddress(vault)}:judgeip:${h}-2026-10-08`);
    expect(keys.judgeGiftTaken(vault, 12n)).toBe(`moi:v1:56:${getAddress(vault)}:judgegift:12`);
  });
  it("refuses unhashed identities and bad days", () => {
    expect(() => keys.judgeUser(vault, "did:privy:abc")).toThrow(RangeError);
    expect(() => keys.judgeNetworkDay(vault, h, "2026-02-30")).toThrow(RangeError);
  });
});
