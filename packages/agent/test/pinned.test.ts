// Not covered here: whether the configured vault and payout wallet are the right ones on chain
// (the deploy record and Ram's own check cover that). This file only proves the parsing rules.
import { describe, expect, it } from "vitest";
import { loadPinned, PinnedConfigError } from "../src/pinned.js";

const GOOD = {
  MOI_VAULT_ADDRESS: "0x1111111111111111111111111111111111111111",
  MOI_PAYOUT_ADDRESS: "0x96e854abddc5c618ca843956d1303017b586ab75",
  MOI_SERVER_ORIGIN: "https://moi.example",
  MOI_PUBLIC_ORIGIN: "http://localhost:3000",
};

function failing(env: Record<string, string | undefined>): string[] {
  try {
    loadPinned(env);
  } catch (err) {
    expect(err).toBeInstanceOf(PinnedConfigError);
    return (err as PinnedConfigError).variables;
  }
  throw new Error("loadPinned accepted a bad setting");
}

describe("loadPinned", () => {
  it("returns checksummed addresses, the USDT constant, the fee ceiling and bare origins", () => {
    expect(loadPinned(GOOD)).toEqual({
      chainId: 56,
      vault: "0x1111111111111111111111111111111111111111",
      usdt: "0x55d398326f99059fF775485246999027B3197955",
      payTo: "0x96E854aBDdc5C618ca843956d1303017b586aB75",
      wrapFeeCeilingUsd: "0.10",
      serverOrigin: "https://moi.example",
      linkOrigin: "http://localhost:3000",
    });
  });

  it("names every missing or malformed variable and never echoes a value", () => {
    const names = failing({ MOI_VAULT_ADDRESS: "0x0000000000000000000000000000000000000000", MOI_PAYOUT_ADDRESS: "not-an-address" });
    expect(names.sort()).toEqual(["MOI_PAYOUT_ADDRESS", "MOI_PUBLIC_ORIGIN", "MOI_SERVER_ORIGIN", "MOI_VAULT_ADDRESS"]);
  });

  it.each([
    ["plain http off localhost", "http://moi.example"],
    ["a path", "https://moi.example/evil"],
    ["a query", "https://moi.example/?x=1"],
    ["a user name", "https://user@moi.example"],
    ["another scheme", "ftp://moi.example"],
  ])("refuses a server origin with %s", (_label, value) => {
    expect(failing({ ...GOOD, MOI_SERVER_ORIGIN: value })).toEqual(["MOI_SERVER_ORIGIN"]);
  });
});
