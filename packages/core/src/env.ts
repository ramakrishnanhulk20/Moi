import { fileURLToPath } from "node:url";
import { getAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { JUDGE_CODE_TEXT } from "./judge.js";
import { canonicalOrigin, canonicalPayTo, checkWrapPriceUsd } from "./wrap.js";

const ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
const DEFAULT_BSC_RPC_URL = "https://bsc-dataseed.bnbchain.org";
const DEFAULT_RELAYER_MAX_GAS_PRICE_WEI = 3_000_000_000n;
// 0.002 BNB, about 330 claims a day at today's 0.05 gwei.
const DEFAULT_RELAYER_DAILY_CAP_WEI = 2_000_000_000_000_000n;

// secp256k1 group order. A 32-byte value at or above it is not a usable key, and viem's
// own error for that case is not something we want to rely on for redaction.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const credential = z.string().regex(/^[\x21-\x7e]{8,512}$/);

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .refine((k) => {
    const n = BigInt(k);
    return n > 0n && n < SECP256K1_N;
  })
  .transform((k) => k as `0x${string}`);

const httpsUrl = z.string().refine((u) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
});

// The vault address is Moi's own constant (C21), so a value getAddress refuses, or the zero
// address, stops the process instead of pointing every approval somewhere unknown.
const vaultAddress = z
  .string()
  .refine((a) => {
    try {
      return getAddress(a) !== zeroAddress;
    } catch {
      return false;
    }
  })
  .transform((a) => getAddress(a) as Address);

// Whole wei only: no sign, no decimal point, no leading zero, and above zero, because the relayer
// refuses a zero ceiling or cap at creation anyway.
const wei = z
  .string()
  .regex(/^[1-9][0-9]{0,30}$/)
  .transform((w) => BigInt(w));

// The same rule createUpstashStore applies, checked here too so a bad value stops the process at
// boot rather than at the first claim.
const httpsOrigin = z.string().refine((u) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.href === `${url.origin}/`;
  } catch {
    return false;
  }
});
const upstashToken = z.string().regex(/^[\x21-\x7e]{8,1024}$/);

const passes = (check: (value: string) => unknown) => (value: string) => {
  try {
    check(value);
    return true;
  } catch {
    return false;
  }
};

// The wrap settings go through wrap.ts's own checks, so a value accepted here is one every 402
// accepts too (standard 2).
const DEFAULT_WRAP_PRICE_USD = "0.05";
const wrapPriceUsd = z.string().refine(passes(checkWrapPriceUsd));
const payoutAddress = z.string().refine(passes(canonicalPayTo)).transform((a) => canonicalPayTo(a));
const publicOrigin = z.string().refine(passes(canonicalOrigin)).transform((o) => canonicalOrigin(o));

// Half a store config is ambiguous: falling back to memory would silently drop the once-per-gift
// record the operator meant to share, so it fails closed instead.
function upstashPair(env: { UPSTASH_REDIS_REST_URL?: string; UPSTASH_REDIS_REST_TOKEN?: string }, ctx: z.RefinementCtx): void {
  if ((env.UPSTASH_REDIS_REST_URL === undefined) !== (env.UPSTASH_REDIS_REST_TOKEN === undefined)) {
    const missing = env.UPSTASH_REDIS_REST_URL === undefined ? "UPSTASH_REDIS_REST_URL" : "UPSTASH_REDIS_REST_TOKEN";
    ctx.addIssue({ code: "custom", path: [missing], message: "set both Upstash variables or neither" });
  }
}

const schema = z
  .object({
    OC_API_KEY: credential,
    OC_SECRET_KEY: credential,
    DEPLOYER_PRIVATE_KEY: privateKey,
    RELAYER_PRIVATE_KEY: privateKey,
    BSC_RPC_URL: httpsUrl.default(DEFAULT_BSC_RPC_URL),
    MOI_VAULT_ADDRESS: vaultAddress.optional(),
    MOI_RELAYER_MAX_GAS_PRICE_WEI: wei.default(DEFAULT_RELAYER_MAX_GAS_PRICE_WEI),
    MOI_RELAYER_DAILY_CAP_WEI: wei.default(DEFAULT_RELAYER_DAILY_CAP_WEI),
    UPSTASH_REDIS_REST_URL: httpsOrigin.optional(),
    UPSTASH_REDIS_REST_TOKEN: upstashToken.optional(),
    MOI_WRAP_PRICE_USD: wrapPriceUsd.default(DEFAULT_WRAP_PRICE_USD),
    MOI_PAYOUT_ADDRESS: payoutAddress.optional(),
    // Same rule as the vault address: a malformed or zero sponsor stops the process.
    MOI_SPONSOR_ADDRESS: vaultAddress.optional(),
    MOI_PUBLIC_ORIGIN: publicOrigin.optional(),
  })
  .superRefine(upstashPair);

// WHY (C40): the hosted server never holds the deployer key. It is not in this schema and never
// read from the source, so no server code can reach it even when the host's environment has it.
const serverSchema = z
  .object({
    OC_API_KEY: credential,
    OC_SECRET_KEY: credential,
    RELAYER_PRIVATE_KEY: privateKey,
    BSC_RPC_URL: httpsUrl.default(DEFAULT_BSC_RPC_URL),
    MOI_VAULT_ADDRESS: vaultAddress,
    MOI_RELAYER_MAX_GAS_PRICE_WEI: wei.default(DEFAULT_RELAYER_MAX_GAS_PRICE_WEI),
    MOI_RELAYER_DAILY_CAP_WEI: wei.default(DEFAULT_RELAYER_DAILY_CAP_WEI),
    UPSTASH_REDIS_REST_URL: httpsOrigin.optional(),
    UPSTASH_REDIS_REST_TOKEN: upstashToken.optional(),
    MOI_WRAP_PRICE_USD: wrapPriceUsd.default(DEFAULT_WRAP_PRICE_USD),
    MOI_PAYOUT_ADDRESS: payoutAddress,
    MOI_SPONSOR_ADDRESS: vaultAddress.optional(),
    MOI_PUBLIC_ORIGIN: publicOrigin,
    // judge.ts's own rule, so a code accepted here is exactly one a judge can type back (standard 2).
    MOI_JUDGE_CODE: z.string().regex(JUDGE_CODE_TEXT).optional(),
  })
  .superRefine(upstashPair);

/** Everything a local script may need, the deployer key included. */
export type Env = z.infer<typeof schema>;

/** What the hosted server needs (C40): no deployer key, and the vault address is required. */
export type ServerEnv = z.infer<typeof serverSchema>;

export class EnvError extends Error {
  readonly variables: string[];
  constructor(variables: string[]) {
    super(`Missing or malformed environment variable(s): ${variables.join(", ")}. Check the repo-root .env against .env.example.`);
    this.name = "EnvError";
    this.variables = variables;
  }
}

const optional = (v: string | undefined) => (v === "" ? undefined : v);

// The variables both schemas share, read by name so nothing else in the source is ever looked at.
function pickShared(source: Record<string, string | undefined>) {
  return {
    OC_API_KEY: source.OC_API_KEY,
    OC_SECRET_KEY: source.OC_SECRET_KEY,
    RELAYER_PRIVATE_KEY: source.RELAYER_PRIVATE_KEY,
    BSC_RPC_URL: optional(source.BSC_RPC_URL),
    MOI_VAULT_ADDRESS: optional(source.MOI_VAULT_ADDRESS),
    MOI_RELAYER_MAX_GAS_PRICE_WEI: optional(source.MOI_RELAYER_MAX_GAS_PRICE_WEI),
    MOI_RELAYER_DAILY_CAP_WEI: optional(source.MOI_RELAYER_DAILY_CAP_WEI),
    UPSTASH_REDIS_REST_URL: optional(source.UPSTASH_REDIS_REST_URL),
    UPSTASH_REDIS_REST_TOKEN: optional(source.UPSTASH_REDIS_REST_TOKEN),
    MOI_WRAP_PRICE_USD: optional(source.MOI_WRAP_PRICE_USD),
    MOI_PAYOUT_ADDRESS: optional(source.MOI_PAYOUT_ADDRESS),
    MOI_SPONSOR_ADDRESS: optional(source.MOI_SPONSOR_ADDRESS),
    MOI_PUBLIC_ORIGIN: optional(source.MOI_PUBLIC_ORIGIN),
  };
}

function parseWith<T>(schemaToUse: z.ZodType<T>, picked: unknown): T {
  const result = schemaToUse.safeParse(picked);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? "unknown")))];
    throw new EnvError(names);
  }
  return result.data;
}

/**
 * Validates a plain record of environment values for a local script: everything, the deployer key
 * included. The thrown EnvError names the failing variables only; zod's own messages are dropped
 * because a future zod version could echo input.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  return parseWith(schema, { ...pickShared(source), DEPLOYER_PRIVATE_KEY: source.DEPLOYER_PRIVATE_KEY });
}

/**
 * Validates a plain record of environment values for the hosted server (C40): OC_API_KEY,
 * OC_SECRET_KEY, RELAYER_PRIVATE_KEY, MOI_VAULT_ADDRESS, MOI_PAYOUT_ADDRESS (the wallet wrap fees
 * settle to, checksummed, not zero) and MOI_PUBLIC_ORIGIN (an https origin, or http://localhost,
 * returned without a trailing slash) are required; the relayer limits, the Upstash pair,
 * BSC_RPC_URL, MOI_SPONSOR_ADDRESS and MOI_WRAP_PRICE_USD (default "0.05", above zero, at most $1
 * and 6 decimal places) are optional as in parseEnv. MOI_JUDGE_CODE is optional here and, when set,
 * must be exactly judge.ts JUDGE_CODE_TEXT ("MOI-" and two groups of four uppercase letters or
 * digits, with no I, O, 0 or 1); createServerDeps requires it once a judge pool is set.
 * DEPLOYER_PRIVATE_KEY is never read, so it is neither required nor returned, whatever the source
 * holds. Throws EnvError naming the failing variables only.
 */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return parseWith(serverSchema, { ...pickShared(source), MOI_JUDGE_CODE: optional(source.MOI_JUDGE_CODE) });
}

function loadEnvFileInto(file: string): void {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    // A missing file is fine when the host sets the variables itself; anything else is a
    // broken file and must stop the process. The original error is not chained because a
    // parser error could quote a line of the file.
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      throw new Error("The .env file exists but could not be read or parsed.");
    }
  }
}

/**
 * For local scripts. Loads the repo-root .env into process.env (values already set in the real
 * environment win) and returns every setting, the deployer key included.
 * Throws EnvError naming any missing or malformed variable, never its value.
 */
export function loadScriptEnv(): Env {
  loadEnvFileInto(ROOT_ENV_FILE);
  return parseEnv(process.env);
}

/** The name existing scripts import. Same as loadScriptEnv. */
export const loadEnv = loadScriptEnv;

/**
 * For the hosted server (C40). Loads `envFile` (the repo-root .env by default; a host normally
 * sets the variables itself and has no file) into process.env, values already set winning, and
 * returns parseServerEnv's settings: never the deployer key, even when the environment has one.
 * Throws EnvError naming any missing or malformed variable, never its value.
 */
export function loadServerEnv(opts: { envFile?: string } = {}): ServerEnv {
  loadEnvFileInto(opts.envFile ?? ROOT_ENV_FILE);
  return parseServerEnv(process.env);
}
