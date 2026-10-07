// Covers the /api/quote handler: the place gate, the vault token list, the amount range, the
// approve-then-swap steps, the swap simulation gate (C33), the gas-free handed-out transactions
// (C34) and the mapping of every failure to a fixed code. Not covered here: the live Web3 API and
// RPC (a fake api replays the recorded live 1 USDT to NVDAB responses and a simulation built for
// the fixture wallet), what changes on chain between the simulation and the wallet's signature,
// and the HTTP layer's body cap.
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  parseAbi,
  toFunctionSelector,
  type PublicClient,
} from "viem";
import { bsc } from "viem/chains";
import { describe, expect, it } from "vitest";
import { NVDAB, USDT } from "../src/chain.js";
import { EXPECTED_ROUTER } from "../src/checks.js";
import { handleQuote } from "../src/quote.js";
import { Web3ApiError, type ApiPath, type Web3Api } from "../src/web3api.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/plan-buy.json", import.meta.url), "utf8"));
const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const STOCK = getAddress(NVDAB);
const TSLAB = getAddress("0x16cd4fe7e8880ecc3ba222795229e20489fc2c76");
const STRANGER = getAddress("0x00000000000000000000000000000000000bad01");
const IN = { country: "IN" };
const ONE_USDT = 10n ** 18n;
const EXPECTED_OUT = BigInt(fx.quote[0].toTokenAmount);
const MIN_OUT = (EXPECTED_OUT * 9_900n) / 10_000n;

const SEL = {
  decimals: toFunctionSelector("decimals()"),
  symbol: toFunctionSelector("symbol()"),
  uiMultiplier: toFunctionSelector("uiMultiplier()"),
  allowance: toFunctionSelector("allowance(address,address)"),
  listedTokens: toFunctionSelector("listedTokens()"),
};

function fakeClient(opts: { listed?: string[]; broken?: boolean; allowance?: bigint } = {}) {
  const counter = { requests: 0 };
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        counter.requests += 1;
        if (opts.broken) throw new Error("node is down");
        if (method === "eth_chainId") return "0x38";
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const call = (params as [{ to?: string; data?: string; input?: string }])[0];
        const sel = (call.data ?? call.input ?? "").slice(0, 10);
        if (sel === SEL.listedTokens && getAddress(call.to ?? "") === VAULT) {
          return encodeAbiParameters([{ type: "address[]" }], [(opts.listed ?? [STOCK]) as `0x${string}`[]]);
        }
        if (sel === SEL.decimals) return encodeAbiParameters([{ type: "uint8" }], [18]);
        if (sel === SEL.symbol) return encodeAbiParameters([{ type: "string" }], ["TOKEN"]);
        if (sel === SEL.uiMultiplier) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        if (sel === SEL.allowance) return encodeAbiParameters([{ type: "uint256" }], [opts.allowance ?? 0n]);
        throw new Error(`unknown selector ${sel}`);
      },
    },
    { retryCount: 0 },
  );
  return { client: createPublicClient({ chain: bsc, transport }) as PublicClient, counter };
}

const change = (token: string, delta: bigint, owner: string) => ({ contractAddress: token, tokenType: "Erc20", change: delta.toString(), owner: owner.toLowerCase() });

/** The simulation the live endpoint returns for a clean 1 USDT swap by the fixture wallet. */
function cleanSimulation(stockOwner: string = fx.wallet) {
  return {
    status: "SUCCESS",
    failReason: "",
    balanceChanges: [change(STOCK, EXPECTED_OUT, stockOwner), change(USDT, -ONE_USDT, fx.wallet)],
    allowanceChanges: [],
  };
}

function fakeApi(opts: { fault?: Error; sim?: unknown } = {}) {
  const calls: ApiPath[] = [];
  const posts: { path: ApiPath; body: unknown }[] = [];
  const answers: Partial<Record<ApiPath, unknown>> = {
    "/api/v1/dex/aggregator/quote": fx.quote,
    "/api/v1/dex/aggregator/approve-transaction": fx.approve,
    "/api/v1/dex/aggregator/swap": fx.swap,
    "/api/v1/dex/market/rwa/price": fx.rwaPrice,
  };
  const api: Web3Api = {
    async get(path) {
      calls.push(path);
      if (opts.fault) throw opts.fault;
      if (!(path in answers)) throw new Error(`unexpected GET ${path}`);
      return structuredClone(answers[path]);
    },
    async post(path, body) {
      posts.push({ path, body });
      if (path !== "/api/v1/dex/pre-transaction/simulate") throw new Error(`unexpected POST ${path}`);
      if (opts.sim instanceof Error) throw opts.sim;
      return structuredClone(opts.sim ?? cleanSimulation());
    },
  };
  return { api, calls, posts };
}

// Every key name anywhere in a JSON body, so a gas field nested at any depth is found.
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysIn(v)]);
}

const body = (over: Record<string, unknown> = {}) => ({ stock: STOCK.toLowerCase(), usdAmount: "1", wallet: fx.wallet, ...over });
const funded = () => fakeClient({ allowance: ONE_USDT }).client;

describe("handleQuote", () => {
  it("answers the approval alone when the router allowance is short: no swap, no simulation", async () => {
    const { api, posts } = fakeApi();
    const res = await handleQuote({ api, client: fakeClient({ allowance: ONE_USDT - 1n }).client, vault: VAULT }, body(), IN);
    expect(res).toEqual({ status: 200, body: { ok: true, step: "approve", approveTx: { to: getAddress(USDT), data: fx.approve[0].data, value: "0" } } });
    const approve = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: fx.approve[0].data });
    expect(approve.args).toEqual([EXPECTED_ROUTER, ONE_USDT]);
    expect(posts).toHaveLength(0);
  });

  it("answers a swap that passed its simulation, with amounts as decimal strings and an exact vault approval of minOut", async () => {
    const { api, posts } = fakeApi();
    const res = await handleQuote({ api, client: funded(), vault: VAULT }, body(), IN);
    expect(res.status).toBe(200);
    if (!res.body.ok || res.body.step !== "swap") throw new Error(`not a swap: ${JSON.stringify(res.body)}`);
    const q = res.body;
    expect(Object.keys(q).sort()).toEqual(["expectedOut", "minOut", "ok", "priceUsd", "step", "stock", "swapTx", "usdAmount", "vaultApproveTx"]);
    expect(q.expectedOut).toBe(EXPECTED_OUT.toString());
    expect(q.minOut).toBe(MIN_OUT.toString());
    expect(q.priceUsd).toBe("239.27000000");
    expect(q.swapTx).toEqual({ to: EXPECTED_ROUTER, data: fx.swap.tx.data, value: "0" });
    expect(q.vaultApproveTx.to).toBe(STOCK);
    const approve = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: q.vaultApproveTx.data });
    expect(approve.args).toEqual([VAULT, MIN_OUT]);
    // The simulation ran for the sender's wallet on exactly the transaction handed out.
    expect(posts).toEqual([
      { path: "/api/v1/dex/pre-transaction/simulate", body: { binanceChainId: "56", evmTx: { from: getAddress(fx.wallet), to: EXPECTED_ROUTER, value: "0", data: fx.swap.tx.data } } },
    ]);
    expect(() => JSON.stringify(res.body)).not.toThrow();
  });

  it("carries the stock checksummed and the usdAmount exactly as given on the swap step", async () => {
    const res = await handleQuote({ api: fakeApi().api, client: funded(), vault: VAULT }, body({ stock: STOCK.toLowerCase(), usdAmount: "1.00" }), IN);
    if (!res.body.ok || res.body.step !== "swap") throw new Error(`not a swap: ${JSON.stringify(res.body)}`);
    expect(res.body.stock).toBe(STOCK);
    expect(res.body.stock).not.toBe(STOCK.toLowerCase());
    expect(res.body.usdAmount).toBe("1.00");
  });

  it("refuses a swap whose quote fields are all correct but whose simulation sends the stock to someone else", async () => {
    const { api, calls } = fakeApi({ sim: cleanSimulation(STRANGER) });
    const res = await handleQuote({ api, client: funded(), vault: VAULT }, body(), IN);
    expect(res).toEqual({ status: 422, body: { ok: false, error: "simulation_refused" } });
    // Every metadata call was made and passed; only the simulation stopped it.
    expect(calls).toContain("/api/v1/dex/aggregator/swap");
  });

  it("refuses a failed, short-paying or malformed simulation, and maps a simulation outage to upstream_unavailable", async () => {
    const run = (sim: unknown) => handleQuote({ api: fakeApi({ sim }).api, client: funded(), vault: VAULT }, body(), IN);
    const refused = { status: 422, body: { ok: false, error: "simulation_refused" } };
    expect(await run({ status: "FAILED", failReason: "execution reverted", balanceChanges: [], allowanceChanges: [] })).toEqual(refused);
    const short = cleanSimulation();
    short.balanceChanges[0] = change(STOCK, MIN_OUT - 1n, fx.wallet);
    expect(await run(short)).toEqual(refused);
    const drains = cleanSimulation();
    drains.balanceChanges.push(change(TSLAB, -1n, fx.wallet));
    expect(await run(drains)).toEqual(refused);
    const grants = { ...cleanSimulation(), allowanceChanges: [{ tokenAddress: TSLAB, owner: fx.wallet, spender: STRANGER, preAmount: "0", postAmount: "1" }] };
    expect(await run(grants)).toEqual(refused);
    expect(await run({ status: "SUCCESS" })).toEqual(refused);
    expect(await run("not an object")).toEqual(refused);
    const outage = await run(new Web3ApiError("/api/v1/dex/pre-transaction/simulate", 500, "50000", "secret detail"));
    expect(outage).toEqual({ status: 502, body: { ok: false, error: "upstream_unavailable" } });
  });

  it("hands out only to, data and value: no transaction carries a gas or gasPrice field (C34)", async () => {
    const approveStep = await handleQuote({ api: fakeApi().api, client: fakeClient().client, vault: VAULT }, body(), IN);
    const swapStep = await handleQuote({ api: fakeApi().api, client: funded(), vault: VAULT }, body(), IN);
    expect(approveStep.body).toMatchObject({ step: "approve" });
    expect(swapStep.body).toMatchObject({ step: "swap" });
    // The fixture's upstream figures exist, so their absence below is the handler's doing.
    expect(fx.approve[0].gasLimit).toBe("70000");
    expect(fx.swap.tx.gas).toBeDefined();
    for (const res of [approveStep, swapStep]) {
      expect(keysIn(res.body).filter((k) => /gas/i.test(k))).toEqual([]);
      for (const tx of Object.values(res.body).filter((v) => typeof v === "object" && v !== null)) {
        expect(Object.keys(tx).sort()).toEqual(["data", "to", "value"]);
      }
    }
  });

  it("refuses a restricted or unknown place before touching the chain or the API", async () => {
    const { api, calls } = fakeApi();
    const { client, counter } = fakeClient();
    expect(await handleQuote({ api, client, vault: VAULT }, body(), { country: "US" })).toEqual({ status: 403, body: { ok: false, error: "restricted_place" } });
    expect(await handleQuote({ api, client, vault: VAULT }, body(), { country: "UA", region: "43" })).toEqual({ status: 403, body: { ok: false, error: "restricted_place" } });
    expect(await handleQuote({ api, client, vault: VAULT }, body(), {})).toEqual({ status: 403, body: { ok: false, error: "unknown_place" } });
    expect(calls).toHaveLength(0);
    expect(counter.requests).toBe(0);
  });

  it("refuses a stock that is not on the vault's list, without calling the API", async () => {
    const { api, calls } = fakeApi();
    const res = await handleQuote({ api, client: fakeClient({ listed: [TSLAB] }).client, vault: VAULT }, body(), IN);
    expect(res).toEqual({ status: 400, body: { ok: false, error: "not_listed" } });
    expect(calls).toHaveLength(0);
  });

  it("refuses 0.5 and 101 USDT, and amounts that are not plain decimals", async () => {
    const deps = { api: fakeApi().api, client: fakeClient().client, vault: VAULT };
    expect((await handleQuote(deps, body({ usdAmount: "0.5" }), IN)).body).toEqual({ ok: false, error: "amount_too_small" });
    expect((await handleQuote(deps, body({ usdAmount: "0.999999999999999999" }), IN)).body).toEqual({ ok: false, error: "amount_too_small" });
    expect((await handleQuote(deps, body({ usdAmount: "101" }), IN)).body).toEqual({ ok: false, error: "amount_too_large" });
    expect((await handleQuote(deps, body({ usdAmount: "100.000000000000000001" }), IN)).body).toEqual({ ok: false, error: "amount_too_large" });
    for (const bad of ["abc", "-1", "1e2", "0", "1.0000000000000000001", " 1"]) {
      expect((await handleQuote(deps, body({ usdAmount: bad }), IN)).body).toEqual({ ok: false, error: "bad_amount" });
    }
  });

  it("refuses a malformed body, stock or wallet", async () => {
    const deps = { api: fakeApi().api, client: fakeClient().client, vault: VAULT };
    expect((await handleQuote(deps, { ...body(), extra: 1 }, IN)).body).toEqual({ ok: false, error: "bad_request" });
    expect((await handleQuote(deps, "not json", IN)).body).toEqual({ ok: false, error: "bad_request" });
    expect((await handleQuote(deps, body({ stock: "0x1234" }), IN)).body).toEqual({ ok: false, error: "bad_stock" });
    expect((await handleQuote(deps, body({ wallet: "0x0000000000000000000000000000000000000000" }), IN)).body).toEqual({ ok: false, error: "bad_wallet" });
  });

  it("maps an upstream failure, a refused quote and a dead node to fixed codes with no upstream text", async () => {
    const upstream = await handleQuote(
      { api: fakeApi({ fault: new Web3ApiError("/api/v1/dex/aggregator/quote", 500, "50000", "secret detail") }).api, client: fakeClient().client, vault: VAULT },
      body(),
      IN,
    );
    expect(upstream).toEqual({ status: 502, body: { ok: false, error: "upstream_unavailable" } });
    // The fixture quote is for 1 USDT, so a 2 USDT request gets a quote planBuy refuses as mismatched.
    const refused = await handleQuote({ api: fakeApi().api, client: fakeClient().client, vault: VAULT }, body({ usdAmount: "2" }), IN);
    expect(refused).toEqual({ status: 422, body: { ok: false, error: "quote_refused" } });
    const dead = await handleQuote({ api: fakeApi().api, client: fakeClient({ broken: true }).client, vault: VAULT }, body(), IN);
    expect(dead).toEqual({ status: 502, body: { ok: false, error: "chain_unavailable" } });
    expect(JSON.stringify([upstream, refused, dead])).not.toContain("secret");
  });
});
