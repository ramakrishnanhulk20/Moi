import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Runs one Binance Agentic Wallet command and returns the `data` part of its JSON reply.
 * `args` are the command words and flags without `--json`, for example
 * ["wallet", "status"]. Rejects with BawError for anything but a successful reply.
 */
export type BawRunner = (args: string[]) => Promise<unknown>;

/**
 * A `baw` command that did not succeed. `code` is the CLI's own error code, or one of
 * NOT_INSTALLED, TIMEOUT, BAD_OUTPUT, BAD_ARGS for failures on this side. The message names the
 * command and the code only: the CLI's free text never reaches a log or the terminal, because it
 * can echo server text.
 */
export class BawError extends Error {
  readonly code: string;
  /** The CLI's error name, such as AUTH_REJECTED, when it is a plain upper-case constant. */
  readonly reason: string | null;
  readonly command: string;

  constructor(command: string, code: string, reason: string | null = null) {
    super(`The Binance wallet command "${command}" failed (code ${code}).`);
    this.name = "BawError";
    this.command = command;
    this.code = code;
    this.reason = reason;
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000;
// `baw auth verify` blocks until the person approves in the Binance App, which the CLI itself
// gives 5 minutes.
export const AUTH_VERIFY_TIMEOUT_MS = 5 * 60_000;
// The largest reply in the docs (tx-history) is a few KB; a megabyte means something is wrong.
const MAX_OUTPUT_BYTES = 1024 * 1024;
// Windows refuses a command line above 32,767 characters; a base64 x402 requirement is ~2 KB.
const MAX_ARG_LENGTH = 16_384;
const COMMAND_WORD = /^[a-z0-9-]{1,32}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const ERROR_NAME = /^[A-Z0-9_]{1,64}$/;

/** The timeout a command gets: 5 minutes for `auth verify`, `timeoutMs` (60 s by default) otherwise. */
export function bawTimeoutMs(args: readonly string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): number {
  return args[0] === "auth" && args[1] === "verify" ? AUTH_VERIFY_TIMEOUT_MS : timeoutMs;
}

function commandName(args: readonly string[]): string {
  const words = args.slice(0, 2).filter((w) => COMMAND_WORD.test(w));
  return words.length > 0 ? words.join(" ") : "baw";
}

/**
 * Finds the JavaScript entry of a globally installed @binance/agentic-wallet by looking for
 * npm's global layout (`<dir>/node_modules/@binance/agentic-wallet`) next to each PATH entry.
 * WHY: on Windows the `baw` on PATH is a .cmd shim, and Node can only start a .cmd through a
 * shell. Running the package's own entry with Node keeps every call an argument array (C27).
 * Returns null when no install is found.
 */
export function findBawEntry(pathValue: string | undefined = process.env.PATH): string | null {
  const dirs = (pathValue ?? "").split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const pkgFile = path.join(dir, "node_modules", "@binance", "agentic-wallet", "package.json");
    if (!existsSync(pkgFile)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { bin?: unknown };
      const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as { baw?: unknown } | undefined)?.baw;
      if (typeof bin !== "string") continue;
      const entry = path.resolve(path.dirname(pkgFile), bin);
      if (existsSync(entry)) return entry;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveCommand(bin: string | undefined): { file: string; prefix: string[] } | null {
  const target = bin ?? (process.platform === "win32" ? findBawEntry() : "baw");
  if (target === null) return null;
  if (/\.(?:c|m)?js$/i.test(target)) return { file: process.execPath, prefix: [target] };
  return { file: target, prefix: [] };
}

type Outcome = { stdout: string; error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null };

function run(file: string, argv: string[], timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      argv,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false, encoding: "utf8" },
      (error, stdout) => resolve({ stdout: typeof stdout === "string" ? stdout : "", error }),
    );
  });
}

/**
 * Makes a BawRunner that starts `baw` with child_process.execFile and an argument array, never a
 * shell string (C27), so no argument can be read as a second command. Appends `--json`, parses
 * stdout as one JSON value and accepts only `{ "success": true, "data": ... }`.
 * `bin` overrides the program: a path ending in .js, .mjs or .cjs is run with this Node.
 * `timeoutMs` (default 60 s) applies to every command except `auth verify`, which gets 5 minutes.
 * Throws BawError: NOT_INSTALLED when baw cannot be found, TIMEOUT, BAD_ARGS for an argument that
 * is not a string, holds a NUL or is too long, BAD_OUTPUT for anything that is not the envelope
 * above, and the CLI's own code for `{ "success": false }`.
 */
export function createBawRunner(opts: { bin?: string; timeoutMs?: number } = {}): BawRunner {
  return async (args: string[]) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string" || a.includes("\0") || a.length > MAX_ARG_LENGTH)) {
      throw new BawError("baw", "BAD_ARGS");
    }
    const command = commandName(args);
    const resolved = resolveCommand(opts.bin);
    if (resolved === null) throw new BawError(command, "NOT_INSTALLED");

    const { stdout, error } = await run(resolved.file, [...resolved.prefix, ...args, "--json"], bawTimeoutMs(args, opts.timeoutMs));
    if (error?.code === "ENOENT") throw new BawError(command, "NOT_INSTALLED");
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new BawError(command, "BAD_OUTPUT");
    if (error?.killed === true) throw new BawError(command, "TIMEOUT");

    let reply: unknown;
    try {
      reply = JSON.parse(stdout.trim());
    } catch {
      throw new BawError(command, "BAD_OUTPUT");
    }
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) throw new BawError(command, "BAD_OUTPUT");
    const envelope = reply as { success?: unknown; data?: unknown; error?: unknown };

    if (envelope.success === true && Object.hasOwn(envelope, "data") && error === null) return envelope.data;
    if (envelope.success === false && typeof envelope.error === "object" && envelope.error !== null) {
      const { code, name } = envelope.error as { code?: unknown; name?: unknown };
      const codeText = typeof code === "number" && Number.isSafeInteger(code) ? String(code) : typeof code === "string" && ERROR_CODE.test(code) ? code : "UNKNOWN";
      const reason = typeof name === "string" && ERROR_NAME.test(name) ? name : null;
      throw new BawError(command, codeText, reason);
    }
    // A success reply with a failing exit status, or any other shape, is ambiguous: refuse it.
    throw new BawError(command, "BAD_OUTPUT");
  };
}
