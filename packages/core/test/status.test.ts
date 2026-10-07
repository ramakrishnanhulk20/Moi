// Covers the gift status handler and its exact share math, with a fake chain. Not covered here: a
// real vault and token (prove.fork.test.ts reads one), the claim page's C15 key check, and opening
// the sealed note (gift.test.ts).
import { getAddress, type Address, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { handleGiftStatus, sharesText } from "../src/status.js";

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const SENDER = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const CLAIM_KEY = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const MULTIPLIER = 1_000_778_223_752_807_865n;
const NOTE = `0x01${"cd".repeat(40)}` as const;

type GiftFake = { state: number; amount: bigint };

function fakeClient(gifts: Record<string, GiftFake>, opts: { name?: string; compliant?: boolean; broken?: boolean } = {}) {
  return {
    async getChainId() {
      return 56;
    },
    async readContract({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) {
      if (opts.broken) throw new Error("node is down: secret detail");
      if (getAddress(address) === VAULT) {
        const id = String(args?.[0]);
        if (functionName === "getGift") {
          const g = gifts[id] ?? { state: 0, amount: 0n };
          const empty = g.state === 0;
          return {
            token: empty ? "0x0000000000000000000000000000000000000000" : NVDAB,
            sender: empty ? "0x0000000000000000000000000000000000000000" : SENDER,
            claimKey: empty ? "0x0000000000000000000000000000000000000000" : CLAIM_KEY,
            expiry: empty ? 0n : 1_793_600_000n,
            state: g.state,
            amount: g.amount,
            sealedNote: empty ? "0x" : NOTE,
          };
        }
        if (functionName === "senderIsCompliant") return opts.compliant ?? true;
        throw new Error(`unexpected vault call ${functionName}`);
      }
      if (getAddress(address) !== NVDAB) throw new Error("unexpected token");
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return "NVDAB";
      if (functionName === "name") return opts.name ?? "NVIDIA (bStocks)";
      if (functionName === "uiMultiplier") return MULTIPLIER;
      throw new Error(`unexpected token call ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("sharesText", () => {
  it("is exact for a multiplier of 1000778223752807865, with no rounding at the last raw unit", () => {
    expect(sharesText(2_964_217_000_000_000n, MULTIPLIER, 18)).toBe("0.002966523824077876871166705");
    expect(sharesText(10n ** 18n, MULTIPLIER, 18)).toBe("1.000778223752807865");
    expect(sharesText(1n, MULTIPLIER, 18)).toBe("0.000000000000000001000778223752807865");
    expect(sharesText(5n * 10n ** 18n, null, 18)).toBe("5");
  });
});

describe("handleGiftStatus", () => {
  it("answers 404 not_found for an id the vault never created", async () => {
    expect(await handleGiftStatus({ client: fakeClient({}), vault: VAULT }, "42")).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
  });

  it("answers 400 for an id that does not parse, without reading the chain", async () => {
    const client = fakeClient({}, { broken: true });
    for (const bad of ["0", "01", "-1", "0x1", "1.0", "", "1 ", (1n << 256n).toString()]) {
      expect(await handleGiftStatus({ client, vault: VAULT }, bad)).toEqual({ status: 400, body: { ok: false, error: "bad_gift_id" } });
    }
  });

  it("answers the gift with exact shares, chain facts, and no sender address", async () => {
    const client = fakeClient({ "7": { state: 1, amount: 2_964_217_000_000_000n } });
    const res = await handleGiftStatus({ client, vault: VAULT }, "7");
    expect(res).toEqual({
      status: 200,
      body: {
        ok: true,
        giftId: "7",
        state: "Open",
        token: NVDAB,
        symbol: "NVDAB",
        name: "NVIDIA (bStocks)",
        decimals: 18,
        amountRaw: "2964217000000000",
        shares: "0.002966523824077876871166705",
        expiry: "1793600000",
        claimKey: CLAIM_KEY,
        sealedNote: NOTE,
        senderCompliant: true,
      },
    });
    expect(JSON.stringify(res).toLowerCase()).not.toContain(SENDER.toLowerCase());
  });

  it("reports a claimed gift, a blocked sender, and a long token name cut to 64 characters", async () => {
    const client = fakeClient({ "3": { state: 2, amount: 10n ** 18n } }, { name: "<img src=x>".repeat(30), compliant: false });
    const res = await handleGiftStatus({ client, vault: VAULT }, "3");
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    expect(res.body.state).toBe("Claimed");
    expect(res.body.senderCompliant).toBe(false);
    expect(res.body.name).toBe("<img src=x>".repeat(30).slice(0, 64));
    expect(res.body.shares).toBe("1.000778223752807865");
  });

  it("answers 502 chain_unavailable when the chain fails or returns an unknown state", async () => {
    const down = await handleGiftStatus({ client: fakeClient({}, { broken: true }), vault: VAULT }, "7");
    expect(down).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
    expect(JSON.stringify(down)).not.toContain("secret");
    const odd = await handleGiftStatus({ client: fakeClient({ "7": { state: 9, amount: 1n } }), vault: VAULT }, "7");
    expect(odd).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
  });
});
