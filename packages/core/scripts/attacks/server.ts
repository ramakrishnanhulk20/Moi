// The Moi server the attacks hit: the real route(), handlers and relayer, built by hand instead of
// createServerDeps so no .env is read and no shared store is touched. The store is an in-process
// memory store keyed to this run's fresh vault. The Binance Web3 API and b402 are fakes the
// attacks steer; every chain read and write goes to the anvil fork.
import { readFileSync } from "node:fs";
import { createWalletClient, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { clientFromHeaders, route, type MoiRequest, type ServerDeps } from "../../src/http.js";
import { deriveClientHashKey, deriveJudgeKey } from "../../src/judge.js";
import type { verifyPrivyAccessToken } from "../../src/privy.js";
import { createRelayer } from "../../src/relayer.js";
import { createStocksCache } from "../../src/stocks.js";
import { createMemoryStore, type KvStore } from "../../src/store.js";
import type { ApiPath, Web3Api } from "../../src/web3api.js";
import { NVDAB, U, type Fork, type Gift } from "./fork.js";

/** Ram's payout wallet (DECISIONS.md), the payee every wrap payment must reach. */
export const PAYOUT = getAddress("0x96e854abddc5c618ca843956d1303017b586ab75");
export const ORIGIN = "http://localhost:3000";
export const WRAP_PRICE_USD = "0.05";
// A judge code in the real format, made up for this run. The real one lives only in server secrets.
export const JUDGE_CODE = "MOI-R7KD-Q3WX";
export const FIXTURE = JSON.parse(readFileSync(new URL("../../test/fixtures/plan-buy.json", import.meta.url), "utf8")) as {
  wallet: string;
  quote: unknown[];
  approve: { data: string; dexContractAddress: string; gasLimit: string; gasPrice: string }[];
  swap: { tx: Record<string, unknown> & { from: string; data: string } } & Record<string, unknown>;
  rwaPrice: unknown[];
};

// The U eip3009 kind from b402's live /supported answer of 2026-10-07 (claim.fork.test.ts).
const U_EIP3009_KIND = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:56",
  extra: { name: "United Stables", version: "1", assetTransferMethod: "eip3009", signerAddress: "0x34F7a661160780Ce1346e6D7B96D2bE244590899" },
};

const erc20Abi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** What the fake Binance Web3 API and b402 answer. Each attack sets the field it steers. */
export type UpstreamPlan = {
  approve: unknown;
  swap: unknown;
  simulation: unknown;
  logoUrl: string | null;
  quoteFault: Error | null;
  /** "pay": settle moves the asked amount from the payer on the fork. "answer": settle names this hash. */
  settle: { mode: "pay" } | { mode: "answer"; hash: Hex };
};

export type RecordedResponse = { status: number; headers: Record<string, string>; body: string };

export type Server = {
  deps: ServerDeps;
  plan: UpstreamPlan;
  /** Every Web3 API and b402 path called, in order. */
  upstreamCalls: string[];
  /** Every response route() gave, for the C19 sweep. */
  responses: RecordedResponse[];
  /** Every refusal line route() logged, for the C19 sweep. */
  logLines: string[];
  /** Every store key and value written, for the C46 sweep. */
  storeWrites: string[];
  /** Judge user ids and client addresses this run used, for the C46 sweep. */
  identities: string[];
  judgeSeed: Hex;
  judgeGifts: Gift[];
  send(req: { method: string; path: string; body?: string | null; headers?: Record<string, string>; ip: string; country?: string | null; region?: string | null }, deps?: ServerDeps): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
    json: Record<string, unknown>;
  }>;
  routeFetch(ip: string, recorded: { url: string; method: string; headers: Record<string, string>; body: string | null }[]): typeof fetch;
};

function recordingStore(writes: string[]): KvStore {
  const inner = createMemoryStore();
  return {
    get: (k) => inner.get(k),
    del: (k) => inner.del(k),
    set: async (k, v, ttl) => {
      writes.push(k, v);
      return inner.set(k, v, ttl);
    },
    setNx: async (k, v, ttl) => {
      writes.push(k, v);
      return inner.setNx(k, v, ttl);
    },
    incrBy: async (k, n, ttl) => {
      writes.push(k);
      return inner.incrBy(k, n, ttl);
    },
  };
}

/**
 * The fake upstream. Quotes replay the recorded live 1 USDT to NVDAB answers; the stock list answers
 * NVDAB with the plan's logo URL; b402 lists the U kind, verifies every payment, and settles as the
 * plan says. It does not check the buyer's signature: the attacks target Moi's own checks.
 */
function fakeUpstream(fork: Fork, plan: UpstreamPlan, calls: string[]): Web3Api {
  const payerWallet = createWalletClient({ account: fork.payer, chain: bsc, transport: http(fork.rpc) });
  return {
    async get(path: ApiPath) {
      calls.push(path);
      if (path === "/api/v1/dex/aggregator/quote") {
        if (plan.quoteFault !== null) throw plan.quoteFault;
        return structuredClone(FIXTURE.quote);
      }
      if (path === "/api/v1/dex/market/rwa/price") return structuredClone(FIXTURE.rwaPrice);
      if (path === "/api/v1/dex/aggregator/approve-transaction") return structuredClone(plan.approve);
      if (path === "/api/v1/dex/aggregator/swap") return structuredClone(plan.swap);
      if (path === "/api/v1/dex/market/rwa/tokens") {
        return [{ binanceChainId: "56", tokenContractAddress: NVDAB.toLowerCase(), tokenLogoUrl: plan.logoUrl, statusInfo: { openState: true } }];
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: ApiPath, body: unknown) {
      calls.push(path);
      if (path === "/api/v1/dex/pre-transaction/simulate") return structuredClone(plan.simulation);
      if (path === "/api/v2/b402/supported") return { kinds: [U_EIP3009_KIND] };
      if (path === "/api/v2/b402/verify") return { isValid: true, payer: fork.payer.address };
      if (path === "/api/v2/b402/settle") {
        const asked = (body as { body: { paymentRequirements: { asset: Address; payTo: Address; amount: string } } }).body.paymentRequirements;
        if (plan.settle.mode === "answer") return { success: true, transaction: plan.settle.hash, payer: fork.payer.address, network: "eip155:56", amount: asked.amount };
        if (getAddress(asked.asset) !== U) throw new Error("the fake settle pays in U only");
        const hash = await payerWallet.writeContract({ address: asked.asset, abi: erc20Abi, functionName: "transfer", args: [asked.payTo, BigInt(asked.amount)] });
        await fork.mined(hash);
        return { success: true, transaction: hash, payer: fork.payer.address, network: "eip155:56", amount: asked.amount };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  };
}

/** Builds the server on the fork. Judge pool gifts are made here, so the pool exists before boot. */
export async function startServer(fork: Fork): Promise<Server> {
  const plan: UpstreamPlan = { approve: FIXTURE.approve, swap: FIXTURE.swap, simulation: null, logoUrl: null, quoteFault: null, settle: { mode: "pay" } };
  const upstreamCalls: string[] = [];
  const responses: RecordedResponse[] = [];
  const logLines: string[] = [];
  const storeWrites: string[] = [];
  const identities: string[] = [];
  const store = recordingStore(storeWrites);

  const judgeSeed = `0x${Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex;
  fork.secrets.push(judgeSeed);
  const judgeGifts: Gift[] = [];
  const pool = new Map<bigint, number>();
  for (const index of [0, 1]) {
    const gift = await fork.makeGift(fork.sponsor, { key: await deriveJudgeKey(judgeSeed, index) });
    judgeGifts.push(gift);
    pool.set(gift.giftId, index);
  }

  const upstream = fakeUpstream(fork, plan, upstreamCalls);
  const relayer = createRelayer({
    account: fork.relayer,
    client: fork.client,
    walletClient: createWalletClient({ account: privateKeyToAccount(fork.relayerKey), chain: bsc, transport: http(fork.rpc, { retryCount: 0 }) }),
    vault: fork.vault,
    store,
    maxGasPriceWei: 5_000_000_000n,
    dailyCapWei: 10n ** 17n,
    allowMemoryStore: true,
  });
  // Stands in for Privy: the access token text is the user id. The attacks below target the judge
  // code, the wallet proof and the per-person marks, not Privy's token check (privy.test.ts).
  const verifyAccessToken = (async (token: string) => ({ userId: token })) as typeof verifyPrivyAccessToken;

  const deps: ServerDeps = {
    client: fork.client,
    api: upstream,
    wrapApi: upstream,
    store,
    storeKind: "memory",
    relayer,
    vault: fork.vault,
    payTo: PAYOUT,
    sponsor: fork.sponsor.address,
    origin: ORIGIN,
    wrapPriceUsd: WRAP_PRICE_USD,
    judge: { seed: judgeSeed, pool, code: JUDGE_CODE },
    privyAppId: "moiattackrun",
    clientHashKey: await deriveClientHashKey(fork.relayerKey),
    getStocks: createStocksCache(),
    devAllowUnknownCountry: false,
    verifyAccessToken,
    log: (line) => logLines.push(line),
  };

  const send: Server["send"] = async (req, using = deps) => {
    identities.push(req.ip);
    // The hosted adapter's own reading of a request: the platform's x-real-ip and place headers.
    const headers: Record<string, string> = { ...(req.headers ?? {}), "x-real-ip": req.ip };
    if (req.country !== null) headers["x-vercel-ip-country"] = req.country ?? "IN";
    if (req.region !== undefined && req.region !== null) headers["x-vercel-ip-country-region"] = req.region;
    const moiRequest: MoiRequest = { method: req.method, path: req.path, headers, body: req.body ?? null, ...clientFromHeaders(headers, "vercel") };
    const res = await route(using, moiRequest);
    responses.push(res);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      // route() always answers JSON; an unreadable body stays empty and fails the attack's check.
    }
    return { status: res.status, headers: res.headers, text: res.body, json };
  };

  const routeFetch: Server["routeFetch"] = (ip, recorded) => async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init?.body === "string" ? init.body : null;
    const method = init?.method ?? "GET";
    recorded.push({ url: url.href, method, headers, body });
    const res = await send({ method, path: url.pathname, body, headers, ip });
    return new Response(res.text, { status: res.status, headers: res.headers });
  };

  return { deps, plan, upstreamCalls, responses, logLines, storeWrites, identities, judgeSeed, judgeGifts, send, routeFetch };
}
