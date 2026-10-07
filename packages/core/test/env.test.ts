// Not covered here: reading the real repo-root .env (loadEnv). Tests never open it; the
// slice run exercises that path. Only parseEnv, which loadEnv delegates to, is tested.
import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "../src/env.js";

const KEY_A = `0x${"11".repeat(32)}`;
const KEY_B = `0x${"22".repeat(32)}`;

const good = {
  OC_API_KEY: "test-api-key-123456",
  OC_SECRET_KEY: "test-secret-abcdef",
  DEPLOYER_PRIVATE_KEY: KEY_A,
  RELAYER_PRIVATE_KEY: KEY_B,
};

function failureOf(source: Record<string, string | undefined>): EnvError {
  try {
    parseEnv(source);
  } catch (err) {
    if (err instanceof EnvError) return err;
    throw err;
  }
  throw new Error("parseEnv did not throw");
}

describe("parseEnv", () => {
  it("accepts a complete set and defaults the RPC URL", () => {
    const env = parseEnv(good);
    expect(env.DEPLOYER_PRIVATE_KEY).toBe(KEY_A);
    expect(env.BSC_RPC_URL).toBe("https://bsc-dataseed.bnbchain.org");
  });

  it("treats an empty BSC_RPC_URL as unset", () => {
    expect(parseEnv({ ...good, BSC_RPC_URL: "" }).BSC_RPC_URL).toBe("https://bsc-dataseed.bnbchain.org");
  });

  it("names a missing variable", () => {
    const err = failureOf({ ...good, OC_SECRET_KEY: undefined });
    expect(err.variables).toEqual(["OC_SECRET_KEY"]);
    expect(err.message).toContain("OC_SECRET_KEY");
  });

  it("names a malformed private key without echoing it", () => {
    const bad = `0x${"ab".repeat(31)}`;
    const err = failureOf({ ...good, RELAYER_PRIVATE_KEY: bad });
    expect(err.variables).toEqual(["RELAYER_PRIVATE_KEY"]);
    expect(err.message).not.toContain(bad);
    expect(err.message).not.toContain("abab");
  });

  it("rejects a zero private key and one at or above the curve order", () => {
    expect(failureOf({ ...good, DEPLOYER_PRIVATE_KEY: `0x${"00".repeat(32)}` }).variables).toEqual(["DEPLOYER_PRIVATE_KEY"]);
    expect(failureOf({ ...good, DEPLOYER_PRIVATE_KEY: `0x${"ff".repeat(32)}` }).variables).toEqual(["DEPLOYER_PRIVATE_KEY"]);
  });

  it("rejects a plain-http RPC URL", () => {
    const err = failureOf({ ...good, BSC_RPC_URL: "http://bsc-dataseed.bnbchain.org" });
    expect(err.variables).toEqual(["BSC_RPC_URL"]);
    expect(err.message).not.toContain("http://");
  });

  it("rejects a credential with whitespace and does not echo it", () => {
    const err = failureOf({ ...good, OC_API_KEY: "has a space in it" });
    expect(err.variables).toEqual(["OC_API_KEY"]);
    expect(err.message).not.toContain("has a space");
  });
});
