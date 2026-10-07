// Not covered here: the real Binance App settings screen, and whether a signed-in baw 1.10.0
// prints these fields (the live `npm run moi -- status` run checks the signed-out case only; the
// left-quota and dated expiresAt shapes were read from the 1.10.0 bundle, not seen live).
import { describe, expect, it } from "vitest";
import { BawError } from "../src/baw.js";
import { preflight } from "../src/preflight.js";
import { ADDRESSES, bawDate, fakeBaw, leftQuota, settings, STATUS_CONNECTED, WALLET } from "./fakes.js";

function wallet(settingsReply: unknown, quotaReply: unknown = leftQuota()) {
  return fakeBaw({
    "wallet status": STATUS_CONNECTED,
    "wallet address": ADDRESSES,
    "wallet settings": settingsReply,
    "wallet left-quota": quotaReply,
  });
}

const QUOTA_UNREAD = /could not read how much of today's limits you have left/;

describe("preflight", () => {
  it("is ready for a connected wallet with room for the gift, and only reads", async () => {
    const { runner, calls } = wallet(settings());
    expect(await preflight(runner, { giftUsd: "5" })).toEqual({ address: WALLET, ready: true, problems: [] });
    expect(calls).toEqual([
      ["wallet", "status"],
      ["wallet", "address"],
      ["wallet", "settings"],
      ["wallet", "left-quota"],
    ]);
  });

  it("lists each problem for Developer Mode off, an x402 limit of 0 and a Limited token scope", async () => {
    const { runner } = wallet(
      settings({ devMode: { enabled: false, expiresAt: null, dailyLimit: 0 }, x402DailyLimit: 0, x402QuotaLeft: 0, tradeAllTokens: false }),
    );
    const result = await preflight(runner);
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      expect.stringMatching(/Developer Mode is off/),
      expect.stringMatching(/Today you have 0 USD of x402 payments left, less than the 0\.10 USD/),
      expect.stringMatching(/token scope is Limited/),
    ]);
  });

  it("names each shortfall in what is left today: daily, x402 and Developer Mode", async () => {
    const { runner } = wallet(
      settings({ x402QuotaLeft: 0.02, developerModeQuotaUsed: 8, devMode: { enabled: true, expiresAt: bawDate(Date.now() + 3_600_000), dailyLimit: 10 } }),
      leftQuota(3),
    );
    const { ready, problems } = await preflight(runner, { giftUsd: "5" });
    expect(ready).toBe(false);
    expect(problems).toEqual([
      expect.stringMatching(/Today you have 0\.02 USD of x402 payments left, less than the 0\.10 USD gift wrapping fee/),
      expect.stringMatching(/Today you have 3 USD of your daily limit left, less than this 5 USD gift/),
      expect.stringMatching(/Today you have 2 USD of Developer Mode allowance left, less than this 5 USD gift/),
    ]);
  });

  it("falls back to the limits, plus one line, when left-quota fails or has an unknown shape", async () => {
    for (const quotaReply of [() => Promise.reject(new BawError("wallet left-quota", "UNKNOWN")), { used: 1 }]) {
      const { runner } = wallet(settings({ dailyLimit: 3 }), quotaReply);
      const { ready, problems } = await preflight(runner, { giftUsd: "5" });
      expect(ready).toBe(false);
      expect(problems).toEqual([expect.stringMatching(QUOTA_UNREAD), expect.stringMatching(/The daily limit is 3 USD, below this 5 USD gift/)]);
    }
  });

  it("reads Developer Mode expiry both as baw 1.10.0 prints it and as the docs show it", async () => {
    const past = { enabled: true, expiresAt: bawDate(Date.now() - 60_000), dailyLimit: 10000 };
    const docsFuture = { enabled: true, expiresAt: Math.floor(Date.now() / 1000) + 3_600, dailyLimit: 10000 };
    expect((await preflight(wallet(settings({ devMode: past })).runner)).problems).toEqual([expect.stringMatching(/Developer Mode has expired/)]);
    expect((await preflight(wallet(settings({ devMode: docsFuture })).runner)).ready).toBe(true);
  });

  it("stops at a signed-out wallet without asking for its address, settings or quota", async () => {
    const { runner, calls } = fakeBaw({ "wallet status": { status: "UNCONNECTED" } });
    const result = await preflight(runner);
    expect(result).toEqual({ address: null, ready: false, problems: [expect.stringMatching(/not signed in/)] });
    expect(calls).toHaveLength(1);
  });

  it("fails closed on settings it cannot read", async () => {
    const { runner } = wallet(settings({ x402DailyLimit: "lots", x402QuotaLeft: "lots", devMode: "on", dailyLimit: 1e-7 }));
    const { ready, problems } = await preflight(runner, { giftUsd: "5" });
    expect(ready).toBe(false);
    expect(problems).toEqual([
      expect.stringMatching(/could not read whether Developer Mode is on/),
      expect.stringMatching(QUOTA_UNREAD),
      expect.stringMatching(/could not read your x402 payment daily limit/),
      expect.stringMatching(/could not read your daily limit/),
    ]);
  });

  it("explains a missing baw install in plain English", async () => {
    const { runner } = fakeBaw({
      "wallet status": () => {
        throw new BawError("wallet status", "NOT_INSTALLED");
      },
    });
    const result = await preflight(runner);
    expect(result.problems).toEqual([expect.stringMatching(/baw\) is not installed/)]);
  });
});
