// Shared stand-ins for the tests. Reply shapes are copied from the binance-agentic-wallet skill's
// reference files (wallet-view.md, wallet-setting.md, market-order.md, external-sign.md,
// x402-payment.md), which are the only record of what baw 1.10.0 prints.
import { BawError, type BawRunner } from "../src/baw.js";

export const WALLET = "0x2222222222222222222222222222222222222222";

type Reply = unknown | ((args: string[]) => unknown);

/** A BawRunner that records every argv array and answers from `replies`, keyed by the first two words. */
export function fakeBaw(replies: Record<string, Reply>): { runner: BawRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: BawRunner = async (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    const reply = replies[key];
    if (reply === undefined) throw new BawError(key, "NO_FAKE_REPLY");
    return typeof reply === "function" ? (reply as (a: string[]) => unknown)(args) : structuredClone(reply);
  };
  return { runner, calls };
}

export const STATUS_CONNECTED = { status: "CONNECTED" };

export const ADDRESSES = {
  addresses: [
    { binanceChainId: "CT_501", chainName: "Solana", address: "E1111111111111111111111111111111111111111S" },
    { binanceChainId: "1", chainName: "Ethereum", address: WALLET },
    { binanceChainId: "56", chainName: "BSC", address: WALLET },
  ],
};

/** A date the way baw 1.10.0 prints one: local time with its offset, such as 2026-10-08T14:00:00+05:30. */
export function bawDate(ms: number): string {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const zone = `${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

/** `wallet left-quota --json` as the 1.10.0 bundle builds it. */
export function leftQuota(quotaLeft: unknown = 50000): Record<string, unknown> {
  return { quotaUsed: 0, quotaLeft, dailyLimit: 50000, date: "2026-10-07" };
}

/**
 * wallet-setting.md's sample, with Developer Mode valid for another day. devMode.expiresAt is in
 * the form the 1.10.0 bundle prints (a dated string), not the Unix seconds the docs show.
 */
export function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxSigninDuration: "48h",
    inactiveSignoutDuration: "48h",
    dailyLimit: 50000,
    abnormalTxnHandling: "AutoReject",
    tradeAllTokens: true,
    predictionEnabled: true,
    predictionDailyLimit: 50000,
    defiDailyLimit: 5000,
    developerModeQuotaUsed: 0,
    devMode: { enabled: true, expiresAt: bawDate(Date.now() + 86_400_000), dailyLimit: 10000, balanceExceeded: false },
    x402DailyLimit: 20,
    x402QuotaUsed: 0,
    x402QuotaLeft: 20,
    quotaUsed: 0,
    quotaLeft: 50000,
    sessionExpireTime: "2026-10-09T06:32:05+08:00",
    ...overrides,
  };
}
