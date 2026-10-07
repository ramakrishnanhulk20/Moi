import { readFileSync } from "node:fs";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { createBscClient, DEFAULT_BSC_RPC_URL } from "@moi/core/src/chain.js";
import { z } from "zod";
import { BawError, createBawRunner } from "./baw.js";
import { GiftError, sendGift, type GiftDeps } from "./gift.js";
import { loadPinned, PinnedConfigError } from "./pinned.js";
import { listPendingKeys, resolvePendingGifts } from "./pending.js";
import { preflight } from "./preflight.js";
import { wrapSavedGift } from "./wrap.js";

const USAGE = [
  "Usage: npm run moi -- <command>",
  "  status                                      Is the Binance agent wallet signed in and set up for Moi?",
  "  signin                                      Sign the Binance agent wallet in (approve it in the Binance App).",
  "  gift <TICKER> <USD> [--note text] [--days n] [--yes]",
  "                                              Buy a stock, lock it as a gift and save the gift link to ./gifts.",
  "  wrap <GIFT_ID> [--yes]                      Pay the wrapping fee for a gift whose wrapping did not finish.",
].join("\n");

const ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
const AGENT_SETTINGS = ["MOI_VAULT_ADDRESS", "MOI_PAYOUT_ADDRESS", "MOI_SERVER_ORIGIN", "MOI_PUBLIC_ORIGIN", "BSC_RPC_URL"] as const;

/**
 * Only the agent's own settings are read from the repo-root .env, and they are not copied into
 * process.env. WHY: baw is started as a child process and inherits process.env, so loading the
 * whole file would hand the deployer and relayer keys to a third-party program. Values already in
 * the real environment win.
 */
function agentEnv(): Record<string, string | undefined> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnv(readFileSync(ROOT_ENV_FILE, "utf8")) as Record<string, string>;
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      throw new GiftError("The .env file exists but could not be read.");
    }
  }
  return Object.fromEntries(AGENT_SETTINGS.map((name) => [name, process.env[name] ?? fromFile[name]]));
}

const say = (line: string) => console.log(line);

async function status(): Promise<number> {
  const result = await preflight(createBawRunner());
  if (result.ready) {
    say(`Your Binance agent wallet ${result.address} is signed in and ready to send gifts.`);
    await checkPendingGifts();
    return 0;
  }
  say(result.address === null ? "Your Binance agent wallet is not ready yet:" : `Your Binance agent wallet ${result.address} is not ready yet:`);
  for (const problem of result.problems) say(`- ${problem}`);
  await checkPendingGifts();
  return 0;
}

// A gift held for approval in the Binance App leaves its key in a pending file; once the sender
// approves it there, this turns the file into the gift's link.
async function checkPendingGifts(): Promise<void> {
  const dir = linkDir();
  if ((await listPendingKeys(dir)).length === 0) return;
  const env = agentEnv();
  const pinned = loadPinned(env);
  await resolvePendingGifts({ client: createBscClient(env.BSC_RPC_URL ?? DEFAULT_BSC_RPC_URL), pinned, linkDir: dir, log: say });
}

const signinSchema = z.union([
  z.object({ status: z.literal("ALREADY_CONNECTED") }).loose(),
  z
    .object({
      qrCodeId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      pairingCode: z.string().regex(/^[0-9A-Za-z]{4,12}$/),
      urlForWeb: z.string().max(2_048).refine((u) => {
        try {
          return new URL(u).protocol === "https:";
        } catch {
          return false;
        }
      }),
    })
    .loose(),
]);

async function signin(): Promise<number> {
  const baw = createBawRunner();
  const started = signinSchema.safeParse(await baw(["auth", "signin"]));
  if (!started.success) throw new GiftError("Binance's sign-in reply was unreadable. Try again.");
  if ("status" in started.data) {
    say("Your Binance agent wallet is already signed in.");
    return 0;
  }
  say(`Pairing code: ${started.data.pairingCode}`);
  say(`Open this link and scan the QR code with the Binance App: ${started.data.urlForWeb}`);
  say("In the Binance App, check that the pairing code matches, then approve the sign-in. Waiting up to 5 minutes.");
  try {
    await baw(["auth", "verify", "--qrCodeId", started.data.qrCodeId]);
  } catch (err) {
    if (err instanceof BawError && (err.reason === "AUTH_REJECTED" || err.code === "TIMEOUT")) {
      throw new GiftError("The sign-in code expired or was turned down. Run `npm run moi -- signin` again for a fresh code.");
    }
    throw err;
  }
  const check = await preflight(baw);
  if (check.address === null) {
    say("The Binance App approved, but the wallet is not connected here yet. Run `npm run moi -- signin` again for a fresh code.");
    return 1;
  }
  say(`Signed in. Your Binance agent wallet is ${check.address}.`);
  for (const problem of check.problems) say(`- Still to fix: ${problem}`);
  return 0;
}

// npm runs scripts from the package folder; INIT_CWD is where the sender typed the command.
const linkDir = () => path.resolve(process.env.INIT_CWD ?? process.cwd(), "gifts");

/** What a money-moving command needs, built only from the pinned settings. Closes the prompt when done. */
async function withDeps(yes: boolean, run: (deps: GiftDeps) => Promise<number>): Promise<number> {
  const env = agentEnv();
  const pinned = loadPinned(env);
  const client = createBscClient(env.BSC_RPC_URL ?? DEFAULT_BSC_RPC_URL);
  const prompt = yes ? null : createInterface({ input: stdin, output: stdout });
  const confirm = async (summary: string) => {
    if (prompt === null) return true;
    const answer = (await prompt.question(`${summary} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
  try {
    return await run({ baw: createBawRunner(), client, pinned, fetchImpl: fetch, linkDir: linkDir(), confirm, log: say });
  } finally {
    prompt?.close();
  }
}

async function gift(positionals: string[], values: { note?: string; days?: string; yes?: boolean }): Promise<number> {
  const [ticker, usd, ...extra] = positionals;
  if (ticker === undefined || usd === undefined || extra.length > 0) {
    say(USAGE);
    return 1;
  }
  if (values.days !== undefined && !/^[0-9]{1,3}$/.test(values.days)) {
    throw new GiftError("--days must be a whole number of days, such as 30.");
  }
  const input = { ticker, usd, note: values.note ?? "", ...(values.days === undefined ? {} : { days: Number(values.days) }) };
  return withDeps(values.yes === true, async (deps) => {
    await sendGift(deps, input);
    return 0;
  });
}

async function wrap(positionals: string[], yes: boolean): Promise<number> {
  const [giftId, ...extra] = positionals;
  if (giftId === undefined || extra.length > 0) {
    say(USAGE);
    return 1;
  }
  return withDeps(yes, async (deps) => {
    await wrapSavedGift(deps, giftId);
    return 0;
  });
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { note: { type: "string" }, days: { type: "string" }, yes: { type: "boolean" } },
  });
  const [command, ...rest] = positionals;
  if (command === "status" && rest.length === 0) return status();
  if (command === "signin" && rest.length === 0) return signin();
  if (command === "gift") return gift(rest, values);
  if (command === "wrap") return wrap(rest, values.yes === true);
  say(USAGE);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // Only the message is printed. Every message Moi writes is plain English, and sendGift has
  // already replaced any error that carried the claim key (C12).
  const known = err instanceof GiftError || err instanceof PinnedConfigError || err instanceof BawError;
  console.error(known ? err.message : `Moi stopped: ${err instanceof Error ? err.message : "unexpected error"}`);
  process.exitCode = 1;
}
