// Covers the optional variables parseEnv gained for the vault, the relayer limits and the
// Upstash store. Not covered here: the required variables (env.test.ts), reading the real .env
// file, and whether the configured vault or store actually answers.
import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "../src/env.js";

const good = {
  OC_API_KEY: "test-api-key-123456",
  OC_SECRET_KEY: "test-secret-abcdef",
  DEPLOYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  RELAYER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
};

const VAULT_LOWER = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const VAULT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const UPSTASH_URL = "https://eu1-example-12345.upstash.io";
const UPSTASH_TOKEN = "AYQgASQgZmFrZS10b2tlbi1mb3ItdGVzdHM";

function failureOf(source: Record<string, string | undefined>): EnvError {
  try {
    parseEnv(source);
  } catch (err) {
    if (err instanceof EnvError) return err;
    throw err;
  }
  throw new Error("parseEnv did not throw");
}

describe("parseEnv optional settings", () => {
  it("defaults the relayer limits and leaves the vault and store unset", () => {
    const env = parseEnv(good);
    expect(env.MOI_VAULT_ADDRESS).toBeUndefined();
    expect(env.MOI_RELAYER_MAX_GAS_PRICE_WEI).toBe(3_000_000_000n);
    expect(env.MOI_RELAYER_DAILY_CAP_WEI).toBe(2_000_000_000_000_000n);
    expect(env.UPSTASH_REDIS_REST_URL).toBeUndefined();
    expect(env.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
  });

  it("checksums the vault address and treats empty values as unset", () => {
    expect(parseEnv({ ...good, MOI_VAULT_ADDRESS: VAULT_LOWER }).MOI_VAULT_ADDRESS).toBe(VAULT);
    const empty = parseEnv({ ...good, MOI_VAULT_ADDRESS: "", MOI_RELAYER_DAILY_CAP_WEI: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" });
    expect(empty.MOI_VAULT_ADDRESS).toBeUndefined();
    expect(empty.MOI_RELAYER_DAILY_CAP_WEI).toBe(2_000_000_000_000_000n);
    expect(empty.UPSTASH_REDIS_REST_URL).toBeUndefined();
  });

  it("refuses a malformed or zero vault address without echoing it", () => {
    for (const bad of ["0x1234", `${VAULT_LOWER}00`, "0x0000000000000000000000000000000000000000", "not an address"]) {
      const err = failureOf({ ...good, MOI_VAULT_ADDRESS: bad });
      expect(err.variables).toEqual(["MOI_VAULT_ADDRESS"]);
      expect(err.message).not.toContain(bad);
    }
  });

  it("parses whole wei and refuses zero, signs, fractions, exponents and leading zeros", () => {
    const env = parseEnv({ ...good, MOI_RELAYER_MAX_GAS_PRICE_WEI: "5000000000", MOI_RELAYER_DAILY_CAP_WEI: "1" });
    expect(env.MOI_RELAYER_MAX_GAS_PRICE_WEI).toBe(5_000_000_000n);
    expect(env.MOI_RELAYER_DAILY_CAP_WEI).toBe(1n);
    for (const bad of ["0", "-1", "1.5", "3e9", "03000000000", " 1", "1".repeat(40)]) {
      expect(failureOf({ ...good, MOI_RELAYER_MAX_GAS_PRICE_WEI: bad }).variables).toEqual(["MOI_RELAYER_MAX_GAS_PRICE_WEI"]);
      expect(failureOf({ ...good, MOI_RELAYER_DAILY_CAP_WEI: bad }).variables).toEqual(["MOI_RELAYER_DAILY_CAP_WEI"]);
    }
  });

  it("accepts an Upstash pair and names the missing half of a partial one", () => {
    const env = parseEnv({ ...good, UPSTASH_REDIS_REST_URL: UPSTASH_URL, UPSTASH_REDIS_REST_TOKEN: UPSTASH_TOKEN });
    expect(env.UPSTASH_REDIS_REST_URL).toBe(UPSTASH_URL);
    expect(env.UPSTASH_REDIS_REST_TOKEN).toBe(UPSTASH_TOKEN);
    expect(failureOf({ ...good, UPSTASH_REDIS_REST_URL: UPSTASH_URL }).variables).toEqual(["UPSTASH_REDIS_REST_TOKEN"]);
    const err = failureOf({ ...good, UPSTASH_REDIS_REST_TOKEN: UPSTASH_TOKEN });
    expect(err.variables).toEqual(["UPSTASH_REDIS_REST_URL"]);
    expect(err.message).not.toContain(UPSTASH_TOKEN);
  });

  it("keeps the wrap settings optional for scripts, defaults the price, and still refuses a malformed one", () => {
    const env = parseEnv(good);
    expect(env.MOI_WRAP_PRICE_USD).toBe("0.05");
    expect(env.MOI_PAYOUT_ADDRESS).toBeUndefined();
    expect(env.MOI_SPONSOR_ADDRESS).toBeUndefined();
    expect(env.MOI_PUBLIC_ORIGIN).toBeUndefined();
    const set = parseEnv({ ...good, MOI_PAYOUT_ADDRESS: VAULT_LOWER, MOI_SPONSOR_ADDRESS: VAULT_LOWER, MOI_PUBLIC_ORIGIN: "http://localhost:3000" });
    expect([set.MOI_PAYOUT_ADDRESS, set.MOI_SPONSOR_ADDRESS, set.MOI_PUBLIC_ORIGIN]).toEqual([VAULT, VAULT, "http://localhost:3000"]);
    expect(failureOf({ ...good, MOI_PUBLIC_ORIGIN: "http://moi.example" }).variables).toEqual(["MOI_PUBLIC_ORIGIN"]);
    expect(failureOf({ ...good, MOI_WRAP_PRICE_USD: "five cents" }).variables).toEqual(["MOI_WRAP_PRICE_USD"]);
    expect(failureOf({ ...good, MOI_SPONSOR_ADDRESS: "0x1234" }).variables).toEqual(["MOI_SPONSOR_ADDRESS"]);
  });

  it("refuses an Upstash URL that is not an https origin, and a token with whitespace, without echoing either", () => {
    for (const bad of ["http://eu1-example-12345.upstash.io", `${UPSTASH_URL}/path`, `${UPSTASH_URL}?q=1`, "upstash.io"]) {
      const err = failureOf({ ...good, UPSTASH_REDIS_REST_URL: bad, UPSTASH_REDIS_REST_TOKEN: UPSTASH_TOKEN });
      expect(err.variables).toEqual(["UPSTASH_REDIS_REST_URL"]);
      expect(err.message).not.toContain(bad);
    }
    const spaced = "has a space in this token";
    const err = failureOf({ ...good, UPSTASH_REDIS_REST_URL: UPSTASH_URL, UPSTASH_REDIS_REST_TOKEN: spaced });
    expect(err.variables).toEqual(["UPSTASH_REDIS_REST_TOKEN"]);
    expect(err.message).not.toContain("has a space");
  });
});
