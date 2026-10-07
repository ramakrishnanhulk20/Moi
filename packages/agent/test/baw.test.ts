// Not covered here: the real `baw` binary and a live Binance session (the `npm run moi -- status`
// run covers those), and the reply shape of each individual command (gift.test.ts and
// preflight.test.ts use recorded shapes from the skill's reference files).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTH_VERIFY_TIMEOUT_MS, BawError, bawTimeoutMs, createBawRunner, DEFAULT_TIMEOUT_MS, findBawEntry } from "../src/baw.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-baw.mjs", import.meta.url));
const baw = createBawRunner({ bin: FAKE, timeoutMs: 5_000 });

async function bawError(promise: Promise<unknown>): Promise<BawError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BawError);
  return err as BawError;
}

describe("createBawRunner", () => {
  it("passes the argument array through untouched, appends --json and returns data", async () => {
    // A shell would split or run this; execFile hands it over as one literal argument.
    const hostile = 'a b; echo pwned && $(whoami) | "quoted" `tick`';
    const data = await baw(["echo", "--note", hostile]);
    expect(data).toEqual({ argv: ["echo", "--note", hostile, "--json"] });
  });

  it("throws the CLI's error code and name, never its free text", async () => {
    const err = await bawError(baw(["fail"]));
    expect(err.code).toBe("351803");
    expect(err.reason).toBe("AGENT_DEV_MODE_RISK_BLOCKED");
    expect(err.message).not.toContain("server text");
  });

  it("replaces an error code or name that is not a plain constant", async () => {
    const err = await bawError(baw(["fail-odd-code"]));
    expect(err.code).toBe("UNKNOWN");
    expect(err.reason).toBeNull();
    expect(err.message).not.toContain("rm -rf");
  });

  it.each(["garbage", "no-data", "success-but-exit-1"])("refuses a reply that is not the success envelope (%s)", async (mode) => {
    expect((await bawError(baw([mode]))).code).toBe("BAD_OUTPUT");
  });

  it("stops a command that runs past its timeout", async () => {
    const quick = createBawRunner({ bin: FAKE, timeoutMs: 300 });
    expect((await bawError(quick(["slow"]))).code).toBe("TIMEOUT");
  });

  it("reports NOT_INSTALLED when the program does not exist", async () => {
    const missing = createBawRunner({ bin: path.join(tmpdir(), "no-such-dir-moi", "baw-missing") });
    expect((await bawError(missing(["wallet", "status"]))).code).toBe("NOT_INSTALLED");
  });

  it("refuses an argument with a NUL byte before starting anything", async () => {
    expect((await bawError(baw(["echo", "a\0b"]))).code).toBe("BAD_ARGS");
  });
});

describe("bawTimeoutMs", () => {
  it("gives auth verify 5 minutes and every other command 60 seconds by default", () => {
    expect(bawTimeoutMs(["auth", "verify", "--qrCodeId", "x"])).toBe(AUTH_VERIFY_TIMEOUT_MS);
    expect(AUTH_VERIFY_TIMEOUT_MS).toBe(300_000);
    expect(bawTimeoutMs(["wallet", "status"])).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });
});

describe("findBawEntry", () => {
  it("finds the package entry in npm's global layout next to a PATH directory", () => {
    const prefix = mkdtempSync(path.join(tmpdir(), "moi-baw-"));
    const pkgDir = path.join(prefix, "node_modules", "@binance", "agentic-wallet");
    mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ bin: { baw: "dist/index.js" } }));
    writeFileSync(path.join(pkgDir, "dist", "index.js"), "");
    const other = mkdtempSync(path.join(tmpdir(), "moi-empty-"));
    expect(findBawEntry([other, prefix].join(path.delimiter))).toBe(path.join(pkgDir, "dist", "index.js"));
    expect(findBawEntry(other)).toBeNull();
  });
});
