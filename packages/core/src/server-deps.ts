import { createWalletClient, getAddress, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { createBscClient, RPC_TIMEOUT_MS } from "./chain.js";
import { EnvError, loadServerEnv, type ServerEnv } from "./env.js";
import type { ServerDeps } from "./http.js";
import { deriveClientHashKey, deriveJudgeKey, parseJudgePool } from "./judge.js";
import { createRelayer } from "./relayer.js";
import { createStocksCache } from "./stocks.js";
import { createMemoryStore, createUpstashStore, type KvStore } from "./store.js";
import { readRelayer } from "./vault.js";
import { createWeb3Api } from "./web3api.js";

// b402 settle is polled for up to 25 seconds inside one wrap request, so its client may wait that
// long for one answer; the default 10 seconds stays on quotes and the stock list.
const WRAP_API_TIMEOUT_MS = 25_000;
// The same rule privy.ts applies to an app id, checked here so a bad value stops boot rather than
// failing every judge request.
const PRIVY_APP_ID_TEXT = /^[A-Za-z0-9]{1,64}$/;

/** The server cannot start safely. The message names what is wrong in plain words and never holds a key. */
export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootError";
  }
}

const set = (value: string | undefined): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

type Judge = { judge: ServerDeps["judge"]; privyAppId: string | null };

// The seed is read only when a pool is set, so a server with judge gifts closed never holds it.
// `code` is MOI_JUDGE_CODE as loadServerEnv already checked it.
async function readJudge(source: Readonly<Record<string, string | undefined>>, code: string | undefined, bad: string[]): Promise<Judge> {
  const appIdText = set(source.NEXT_PUBLIC_PRIVY_APP_ID);
  const privyAppId = appIdText !== undefined && PRIVY_APP_ID_TEXT.test(appIdText) ? appIdText : null;
  if (appIdText !== undefined && privyAppId === null) bad.push("NEXT_PUBLIC_PRIVY_APP_ID");
  const poolText = set(source.MOI_JUDGE_POOL);
  if (poolText === undefined) return { judge: null, privyAppId };

  let pool: Map<bigint, number> | null = null;
  try {
    pool = parseJudgePool(poolText);
  } catch {
    bad.push("MOI_JUDGE_POOL");
  }
  const seedText = set(source.MOI_JUDGE_SEED);
  let seed: `0x${string}` | null = null;
  try {
    if (seedText !== undefined) {
      await deriveJudgeKey(seedText as `0x${string}`, 0);
      seed = seedText as `0x${string}`;
    }
  } catch {
    // deriveJudgeKey refuses a malformed or all-zero seed; its message is dropped like any value.
  }
  if (seed === null) bad.push("MOI_JUDGE_SEED");
  // FA-9: a sign-in alone lets anyone with an account take a gift, so an open pool also needs the
  // code that only the submission form's judge instructions carry.
  if (code === undefined) bad.push("MOI_JUDGE_CODE");
  if (appIdText === undefined) bad.push("NEXT_PUBLIC_PRIVY_APP_ID");
  return { judge: pool !== null && seed !== null && code !== undefined ? { seed, pool, code } : null, privyAppId };
}

/**
 * C43: the vault accepts claim() only from its own relayer (C31), so a server whose key is not that
 * address would sign, pay for and send claims that can only revert. Reads vault.relayer() once at
 * boot. Throws BootError naming both addresses on a mismatch, and a fixed message when the chain
 * cannot be read; the RPC's own error is dropped because it can carry the RPC address and its key.
 */
async function checkRelayerMatches(client: PublicClient, vault: Address, relayer: Address): Promise<void> {
  let onChain: Address;
  try {
    onChain = await readRelayer(client, vault);
  } catch {
    throw new BootError(`Could not read the relayer of vault ${vault} from the chain, so the server will not start. Check BSC_RPC_URL and MOI_VAULT_ADDRESS.`);
  }
  if (getAddress(onChain) !== getAddress(relayer)) {
    throw new BootError(
      `The vault ${vault} only accepts claims from relayer ${getAddress(onChain)}, but RELAYER_PRIVATE_KEY belongs to ${getAddress(relayer)}. Set the matching relayer key, or have the vault owner point the vault at this relayer.`,
    );
  }
}

/**
 * Builds everything the Moi endpoints need from server config, once per server process.
 * - `env` is loadServerEnv's result by default: never the deployer key (C40). The few settings
 *   outside that schema are read by name from `opts.source` (process.env by default):
 *   MOI_ALLOW_MEMORY_STORE, MOI_DEV_ALLOW_UNKNOWN_COUNTRY, MOI_JUDGE_POOL, MOI_JUDGE_SEED (only when
 *   a pool is set) and NEXT_PUBLIC_PRIVY_APP_ID. DEPLOYER_PRIVATE_KEY is never read.
 * - Store (C38): the shared Upstash store when both Upstash variables are set. Without them the
 *   server refuses to start, unless MOI_ALLOW_MEMORY_STORE is exactly "1", which gives a one-process
 *   memory store and prints a warning through `opts.warn` (console.warn by default).
 * - Judge gifts: an absent MOI_JUDGE_POOL closes POST /api/judge. A set pool must pass
 *   parseJudgePool, and then MOI_JUDGE_SEED (0x and 64 hex, not all zeros), MOI_JUDGE_CODE (from
 *   `env`, already in its exact form) and NEXT_PUBLIC_PRIVY_APP_ID (1 to 64 letters and digits)
 *   are required. The code goes to the judge handler as `judge.code`.
 * - devAllowUnknownCountry is true only when MOI_DEV_ALLOW_UNKNOWN_COUNTRY is exactly "1".
 * - C46: clientHashKey, the key every client address and user id is hashed under, is derived from
 *   RELAYER_PRIVATE_KEY by HKDF (judge.ts deriveClientHashKey), so every instance of the server
 *   hashes alike without a second secret to set, and nothing can be undone to the key.
 * - C43: the vault's relayer() read on chain must equal RELAYER_PRIVATE_KEY's address.
 * - The public client (createBscClient, 5 s timeout, or `opts.client`), a Web3 API client for quotes
 *   and stocks (10 s) and a dedicated one for wrap (25 s), the relayer with its own wallet client,
 *   the payee, sponsor, origin and wrap price from env, and a 60-second stocks cache.
 * Throws EnvError naming only the variables that are missing or malformed, and BootError for C43.
 * No message carries a key, a seed, a token or an RPC address.
 */
export async function createServerDeps(
  env: ServerEnv = loadServerEnv(),
  opts: { source?: Readonly<Record<string, string | undefined>>; client?: PublicClient; warn?: (line: string) => void } = {},
): Promise<ServerDeps> {
  const source = opts.source ?? process.env;
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const bad: string[] = [];

  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;
  const allowMemory = source.MOI_ALLOW_MEMORY_STORE === "1";
  if ((upstashUrl === undefined || upstashToken === undefined) && !allowMemory) bad.push("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN");
  const { judge, privyAppId } = await readJudge(source, env.MOI_JUDGE_CODE, bad);
  if (bad.length > 0) throw new EnvError(bad);

  let store: KvStore;
  let storeKind: ServerDeps["storeKind"];
  if (upstashUrl !== undefined && upstashToken !== undefined) {
    store = createUpstashStore({ url: upstashUrl, token: upstashToken });
    storeKind = "upstash";
  } else {
    store = createMemoryStore();
    storeKind = "memory";
    warn(
      "WARNING: MOI_ALLOW_MEMORY_STORE=1, so claim records, locks, the relayer's spend and nonce counters and the rate limits live in this one process only. Local runs only; a hosted server must use Upstash (C38).",
    );
  }

  const client = opts.client ?? createBscClient(env.BSC_RPC_URL);
  const vault = getAddress(env.MOI_VAULT_ADDRESS);
  const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY);
  const clientHashKey = await deriveClientHashKey(env.RELAYER_PRIVATE_KEY);
  await checkRelayerMatches(client, vault, account.address);

  const relayer = createRelayer({
    account,
    client,
    // No retries on the wallet transport: a retried send is a second broadcast attempt the relayer
    // did not decide on.
    walletClient: createWalletClient({ account, chain: bsc, transport: http(env.BSC_RPC_URL, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) }),
    vault,
    store,
    maxGasPriceWei: env.MOI_RELAYER_MAX_GAS_PRICE_WEI,
    dailyCapWei: env.MOI_RELAYER_DAILY_CAP_WEI,
    allowMemoryStore: storeKind === "memory",
  });

  return {
    client,
    api: createWeb3Api({ apiKey: env.OC_API_KEY, secretKey: env.OC_SECRET_KEY }),
    wrapApi: createWeb3Api({ apiKey: env.OC_API_KEY, secretKey: env.OC_SECRET_KEY, timeoutMs: WRAP_API_TIMEOUT_MS }),
    store,
    storeKind,
    relayer,
    vault,
    payTo: env.MOI_PAYOUT_ADDRESS,
    sponsor: env.MOI_SPONSOR_ADDRESS ?? null,
    origin: env.MOI_PUBLIC_ORIGIN,
    wrapPriceUsd: env.MOI_WRAP_PRICE_USD,
    judge,
    privyAppId,
    clientHashKey,
    getStocks: createStocksCache(),
    devAllowUnknownCountry: source.MOI_DEV_ALLOW_UNKNOWN_COUNTRY === "1",
  };
}
