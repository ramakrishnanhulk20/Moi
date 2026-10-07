import { formatUnits, getAddress, type Address } from "viem";
import { z } from "zod";
import { BawError, type BawRunner } from "./baw.js";
import { WRAP_FEE_CEILING_USD } from "./pinned.js";

export type PreflightResult = {
  /** The wallet's BNB Smart Chain address, or null when it could not be read. */
  address: Address | null;
  /** True only when `problems` is empty. */
  ready: boolean;
  /** One plain-English line per thing the sender must fix, most of them in the Binance App. */
  problems: string[];
};

const SETTINGS_PATH = "Binance App, Agentic Wallet, Settings";

const statusSchema = z.object({ status: z.string().max(32) }).loose();
const addressSchema = z
  .object({
    addresses: z
      .array(z.object({ binanceChainId: z.union([z.string().max(16), z.number()]), address: z.string().max(128) }).loose())
      .max(64),
  })
  .loose();
const settingsSchema = z
  .object({
    dailyLimit: z.unknown(),
    tradeAllTokens: z.unknown(),
    x402DailyLimit: z.unknown(),
    x402QuotaLeft: z.unknown(),
    developerModeQuotaUsed: z.unknown(),
    devMode: z.unknown(),
  })
  .loose();
type Settings = z.infer<typeof settingsSchema>;
const devModeSchema = z
  .object({ enabled: z.boolean(), expiresAt: z.union([z.number(), z.string().max(64)]).nullable().optional(), dailyLimit: z.unknown() })
  .loose();
// `wallet left-quota` is in no doc page. This shape, {quotaUsed, quotaLeft, dailyLimit, date}, is
// what the @binance/agentic-wallet 1.10.0 bundle prints with --json.
const leftQuotaSchema = z.object({ quotaLeft: z.unknown() }).loose();

const USD_TEXT = /^\d{1,20}(\.\d{1,18})?$/;

/**
 * A US dollar figure as integer units of 10^-18, so limits and amounts are compared without
 * floating-point arithmetic (C22). The wallet reports limits as JSON numbers; they are turned into
 * their decimal text first. Returns null for anything that is not a plain non-negative decimal,
 * including exponent forms such as 1e-7, so an unreadable limit counts as a problem.
 */
function usdUnits(value: unknown): bigint | null {
  const text = typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : typeof value === "string" ? value : null;
  if (text === null || !USD_TEXT.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

const usd = (units: bigint) => formatUnits(units, 18);

// What is left can dip below zero in baw's own float subtraction; that means nothing is left.
const leftUnits = (value: unknown) => (typeof value === "number" && value < 0 ? 0n : usdUnits(value));

/**
 * When Developer Mode expires, in milliseconds. The docs give Unix seconds, but baw 1.10.0 itself
 * prints a local date such as "2026-10-08T14:00:00+05:30", so both are read. Null when neither.
 */
function expiryMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

type Remaining = { daily: bigint; x402: bigint; devMode: bigint | null };

/**
 * Today's remaining amounts, or null when any needed figure cannot be read. The daily figure comes
 * from `wallet left-quota`; the x402 figure is `x402QuotaLeft` and the Developer Mode figure is
 * devMode.dailyLimit minus developerModeQuotaUsed, both from `wallet settings`. `dev` is null when
 * Developer Mode is off, so its figure is not needed.
 */
async function readRemaining(baw: BawRunner, settings: Settings, dev: { limit: unknown } | null): Promise<Remaining | null> {
  let daily: bigint | null;
  try {
    const parsed = leftQuotaSchema.safeParse(await baw(["wallet", "left-quota"]));
    daily = parsed.success ? leftUnits(parsed.data.quotaLeft) : null;
  } catch {
    daily = null;
  }
  const x402 = leftUnits(settings.x402QuotaLeft);
  if (daily === null || x402 === null) return null;
  if (dev === null) return { daily, x402, devMode: null };
  // baw prints null for Developer Mode use when none is recorded today, so null counts as none used.
  const used = settings.developerModeQuotaUsed === null ? 0n : usdUnits(settings.developerModeQuotaUsed);
  const limit = usdUnits(dev.limit);
  if (used === null || limit === null) return null;
  return { daily, x402, devMode: limit > used ? limit - used : 0n };
}

function failureLine(what: string, err: unknown): string {
  if (err instanceof BawError && err.code === "NOT_INSTALLED") {
    return "The Binance agent wallet tool (baw) is not installed. Install it with: npm install -g @binance/agentic-wallet@1.10.0";
  }
  const code = err instanceof BawError ? ` (code ${err.code})` : "";
  return `Moi could not read your Binance agent wallet ${what}${code}. Try again in a minute.`;
}

/**
 * Reads `wallet status`, `wallet address`, `wallet settings` and `wallet left-quota` and lists, in
 * plain English, everything the sender must change or wait for before a gift can go through:
 * - the wallet is not signed in (or still being created);
 * - Developer Mode is off or expired (contract calls need it);
 * - what is left today of the x402 limit is below `need.wrapFeeUsd` (default: the 0.10 USD fee
 *   ceiling), and, when `need.giftUsd` is given, what is left of the daily limit and of the
 *   Developer Mode limit is below the gift;
 * - the token scope is Limited (tradeAllTokens false), which may refuse the stock.
 * When the remaining amounts cannot be read, it says so in one problem line and checks the limits
 * themselves instead. A field that is missing or unreadable is a problem too (fail closed). It
 * never changes a setting; the CLI cannot. Never throws for a wallet error: each becomes a line.
 */
export async function preflight(
  baw: BawRunner,
  need: { giftUsd?: string; wrapFeeUsd?: string } = {},
): Promise<PreflightResult> {
  const problems: string[] = [];
  const done = (address: Address | null): PreflightResult => ({ address, ready: problems.length === 0, problems });

  let status: string;
  try {
    const parsed = statusSchema.safeParse(await baw(["wallet", "status"]));
    if (!parsed.success) throw new BawError("wallet status", "BAD_OUTPUT");
    status = parsed.data.status;
  } catch (err) {
    problems.push(failureLine("status", err));
    return done(null);
  }
  if (status === "CREATING") {
    problems.push("Your Binance agent wallet is still being set up. Wait a minute, then run `npm run moi -- status` again.");
    return done(null);
  }
  if (status !== "CONNECTED") {
    problems.push("Your Binance agent wallet is not signed in. Run `npm run moi -- signin` and approve the code in the Binance App.");
    return done(null);
  }

  let address: Address | null = null;
  try {
    const parsed = addressSchema.safeParse(await baw(["wallet", "address"]));
    if (!parsed.success) throw new BawError("wallet address", "BAD_OUTPUT");
    const bsc = parsed.data.addresses.filter((a) => String(a.binanceChainId) === "56");
    if (bsc.length === 1 && bsc[0] !== undefined) address = getAddress(bsc[0].address);
  } catch (err) {
    problems.push(failureLine("address", err));
  }
  if (address === null && problems.length === 0) {
    problems.push("Your Binance agent wallet did not report exactly one BNB Smart Chain address.");
  }

  let settings: z.infer<typeof settingsSchema>;
  try {
    const parsed = settingsSchema.safeParse(await baw(["wallet", "settings"]));
    if (!parsed.success) throw new BawError("wallet settings", "BAD_OUTPUT");
    settings = parsed.data;
  } catch (err) {
    problems.push(failureLine("settings", err));
    return done(address);
  }

  const devMode = devModeSchema.safeParse(settings.devMode);
  let devModeOn = false;
  if (!devMode.success) {
    problems.push("Moi could not read whether Developer Mode is on. Check it in the Binance App and try again.");
  } else if (!devMode.data.enabled) {
    problems.push(`Developer Mode is off. Moi needs it to lock the gift in the vault. Turn it on in the ${SETTINGS_PATH}, Developer Mode.`);
  } else {
    // Enabled with no readable expiry is treated as lapsed rather than guessed to be fine.
    const expires = expiryMs(devMode.data.expiresAt);
    if (expires === null || expires <= Date.now()) {
      problems.push(`Developer Mode has expired. Turn it on again in the ${SETTINGS_PATH}, Developer Mode.`);
    } else {
      devModeOn = true;
    }
  }

  const feeText = need.wrapFeeUsd ?? WRAP_FEE_CEILING_USD;
  const fee = usdUnits(feeText);
  const gift = need.giftUsd === undefined ? undefined : usdUnits(need.giftUsd);
  const remaining = await readRemaining(baw, settings, devModeOn ? { limit: devMode.data?.dailyLimit } : null);

  if (remaining !== null) {
    if (fee === null || remaining.x402 < fee) {
      problems.push(
        `Today you have ${usd(remaining.x402)} USD of x402 payments left, less than the ${feeText} USD gift wrapping fee. Raise the x402 daily limit in the ${SETTINGS_PATH}, or wait for it to refill.`,
      );
    }
    if (gift !== undefined && (gift === null || remaining.daily < gift)) {
      problems.push(
        `Today you have ${usd(remaining.daily)} USD of your daily limit left, less than this ${need.giftUsd} USD gift. Raise the Daily limit in the ${SETTINGS_PATH}, or wait for it to refill.`,
      );
    }
    if (gift !== undefined && remaining.devMode !== null && (gift === null || remaining.devMode < gift)) {
      problems.push(
        `Today you have ${usd(remaining.devMode)} USD of Developer Mode allowance left, less than this ${need.giftUsd} USD gift, and locking the gift is a Developer Mode transaction. Raise the Developer Mode daily limit in the ${SETTINGS_PATH}, or wait for it to refill.`,
      );
    }
  } else {
    problems.push(
      `Moi could not read how much of today's limits you have left, so it cannot promise this gift fits. Check your remaining limits in the ${SETTINGS_PATH} and try again.`,
    );
    const x402Limit = usdUnits(settings.x402DailyLimit);
    if (x402Limit === null || fee === null) {
      problems.push(`Moi could not read your x402 payment daily limit. Check it in the ${SETTINGS_PATH}.`);
    } else if (x402Limit < fee) {
      problems.push(
        `The x402 payment daily limit is ${String(settings.x402DailyLimit)} USD, below the ${feeText} USD gift wrapping fee. Raise it in the ${SETTINGS_PATH}, x402 daily limit.`,
      );
    }
    if (gift !== undefined) {
      const dailyLimit = usdUnits(settings.dailyLimit);
      if (dailyLimit === null || gift === null) {
        problems.push(`Moi could not read your daily limit. Check it in the ${SETTINGS_PATH}.`);
      } else if (dailyLimit < gift) {
        problems.push(
          `The daily limit is ${String(settings.dailyLimit)} USD, below this ${need.giftUsd} USD gift. Raise it in the ${SETTINGS_PATH}, Daily limit.`,
        );
      }
    }
  }

  if (settings.tradeAllTokens !== true) {
    problems.push(
      `Your token scope is Limited, so the Binance App may refuse to buy the stock. In the ${SETTINGS_PATH}, allow all tokens or add the stock to the allowed list.`,
    );
  }

  return done(address);
}
