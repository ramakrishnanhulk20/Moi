// Not covered here: a real BSC node. A fake EIP-1193 transport answers the reads, so this
// proves how we decode and fall back, not live token state. The slice run reads mainnet.
import { createPublicClient, custom, encodeAbiParameters, toFunctionSelector, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { describe, expect, it } from "vitest";
import { balanceOf, NVDAB, rawToShares, readTokenInfo, UI_MULTIPLIER_ONE, USDT } from "../src/chain.js";

const SEL = {
  decimals: toFunctionSelector("decimals()"),
  symbol: toFunctionSelector("symbol()"),
  uiMultiplier: toFunctionSelector("uiMultiplier()"),
  balanceOf: toFunctionSelector("balanceOf(address)"),
};

type Answers = { chainId?: number; decimals?: number; symbol?: string; uiMultiplier?: bigint | "revert"; balance?: bigint };

function fakeClient(a: Answers): PublicClient {
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") return `0x${(a.chainId ?? 56).toString(16)}`;
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const data = ((params as [{ data?: string; input?: string }])[0].data ??
        (params as [{ input?: string }])[0].input ??
        "") as string;
      const sel = data.slice(0, 10);
      if (sel === SEL.decimals) return encodeAbiParameters([{ type: "uint8" }], [a.decimals ?? 18]);
      if (sel === SEL.symbol) return encodeAbiParameters([{ type: "string" }], [a.symbol ?? "NVDAB"]);
      if (sel === SEL.balanceOf) return encodeAbiParameters([{ type: "uint256" }], [a.balance ?? 0n]);
      if (sel === SEL.uiMultiplier) {
        if (a.uiMultiplier === "revert" || a.uiMultiplier === undefined) {
          throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        }
        return encodeAbiParameters([{ type: "uint256" }], [a.uiMultiplier]);
      }
      throw new Error(`unknown selector ${sel}`);
    },
  }, { retryCount: 0 });
  return createPublicClient({ chain: bsc, transport }) as PublicClient;
}

describe("readTokenInfo", () => {
  it("reads decimals, symbol and the ERC-8056 multiplier", async () => {
    const info = await readTokenInfo(NVDAB, fakeClient({ decimals: 18, symbol: "NVDAB", uiMultiplier: 1_000778223752807865n }));
    expect(info).toEqual({ decimals: 18, symbol: "NVDAB", uiMultiplier: 1_000778223752807865n });
  });

  it("returns a null multiplier when uiMultiplier() reverts", async () => {
    const info = await readTokenInfo(USDT, fakeClient({ decimals: 18, symbol: "USDT", uiMultiplier: "revert" }));
    expect(info.uiMultiplier).toBeNull();
    expect(info.symbol).toBe("USDT");
  });

  it("refuses a node that is not on chain 56", async () => {
    await expect(readTokenInfo(NVDAB, fakeClient({ chainId: 1 }))).rejects.toThrow(/expected 56/);
  });

  it("refuses a malformed token address before any network call", async () => {
    await expect(readTokenInfo("0x1234", fakeClient({}))).rejects.toThrow();
  });
});

describe("balanceOf", () => {
  it("returns the raw integer balance", async () => {
    expect(await balanceOf(USDT, "0x69F1Cc47f7969dC8E2B0b1369059591A674FB15f", fakeClient({ balance: 123n * 10n ** 18n }))).toBe(123n * 10n ** 18n);
  });
});

describe("rawToShares", () => {
  it("applies the multiplier with integer math and rounds down", () => {
    expect(rawToShares(10n ** 18n, 1_000778223752807865n)).toBe(1_000778223752807865n);
    expect(rawToShares(3n, 1_500000000000000000n)).toBe(4n);
    expect(rawToShares(5n, null)).toBe(5n);
    expect(rawToShares(7n, UI_MULTIPLIER_ONE)).toBe(7n);
  });
});
