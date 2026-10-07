// Not covered here: the live API, the RPC, and simulate(). A fake api object replays recorded
// live responses and a fake transport answers chain reads, so this proves planBuy's decisions only.
import { readFileSync } from "node:fs";
import { createPublicClient, custom, encodeAbiParameters, maxUint256, toFunctionSelector, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { describe, expect, it } from "vitest";
import { BuyRefusedError, planBuy } from "../src/buy.js";
import { NVDAB } from "../src/chain.js";
import { EXPECTED_ROUTER } from "../src/checks.js";
import type { ApiPath, Web3Api } from "../src/web3api.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/plan-buy.json", import.meta.url), "utf8"));
const ONE = 10n ** 18n;
const OTHER = "0x1111111254EEB25477B68fb85Ed929f73A960582";

type Responses = { quote: any; approve: any; swap: any; rwaPrice: any };

function fakeApi(edit?: (r: Responses) => void) {
  const r: Responses = structuredClone({ quote: fx.quote, approve: fx.approve, swap: fx.swap, rwaPrice: fx.rwaPrice });
  edit?.(r);
  const calls: { path: ApiPath; params: Record<string, string> }[] = [];
  const answers: Partial<Record<ApiPath, unknown>> = {
    "/api/v1/dex/aggregator/quote": r.quote,
    "/api/v1/dex/aggregator/approve-transaction": r.approve,
    "/api/v1/dex/aggregator/swap": r.swap,
    "/api/v1/dex/market/rwa/price": r.rwaPrice,
  };
  const api: Web3Api = {
    async get(path, params) {
      calls.push({ path, params });
      if (!(path in answers)) throw new Error(`unexpected GET ${path}`);
      return answers[path];
    },
    async post(path) {
      throw new Error(`unexpected POST ${path}`);
    },
  };
  return { api, calls };
}

const SEL = {
  decimals: toFunctionSelector("decimals()"),
  symbol: toFunctionSelector("symbol()"),
  uiMultiplier: toFunctionSelector("uiMultiplier()"),
  allowance: toFunctionSelector("allowance(address,address)"),
};

function fakeClient(currentAllowance = 0n): PublicClient {
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") return "0x38";
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const data = ((params as [{ data?: string; input?: string }])[0].data ?? (params as [{ input?: string }])[0].input ?? "") as string;
      const sel = data.slice(0, 10);
      if (sel === SEL.decimals) return encodeAbiParameters([{ type: "uint8" }], [18]);
      if (sel === SEL.symbol) return encodeAbiParameters([{ type: "string" }], ["TOKEN"]);
      if (sel === SEL.uiMultiplier) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
      if (sel === SEL.allowance) return encodeAbiParameters([{ type: "uint256" }], [currentAllowance]);
      throw new Error(`unknown selector ${sel}`);
    },
  }, { retryCount: 0 });
  return createPublicClient({ chain: bsc, transport }) as PublicClient;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof BuyRefusedError) return err.reason;
    throw err;
  }
  throw new Error("planBuy did not refuse");
}

const plan = (api: Web3Api, allowance = 0n) => planBuy({ api, stock: NVDAB, usdtAmount: ONE, wallet: fx.wallet, client: fakeClient(allowance) });

describe("planBuy", () => {
  it("builds a checked plan from the recorded live responses", async () => {
    const { api, calls } = fakeApi();
    const p = await plan(api);
    expect(p.checks).toEqual({ approve: { ok: true }, swap: { ok: true }, price: { ok: true } });
    expect(p.expectedOut).toBe(4178308659907078n);
    expect(p.minOut).toBe(4136525573308007n);
    expect(p.referenceUsdPrice).toBe("239.27000000");
    expect(p.approveTx?.to).toBe("0x55d398326f99059fF775485246999027B3197955");
    expect(p.swapTx.to).toBe(EXPECTED_ROUTER);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/dex/aggregator/quote",
      "/api/v1/dex/market/rwa/price",
      "/api/v1/dex/aggregator/approve-transaction",
      "/api/v1/dex/aggregator/swap",
    ]);
    expect(calls[3]!.params).toMatchObject({ quoteId: fx.quote[0].quoteId, slippagePercent: "1", userWalletAddress: fx.wallet });
  });

  it("skips the approval when the on-chain allowance already covers the amount", async () => {
    const { api, calls } = fakeApi();
    const p = await plan(api, ONE);
    expect(p.approveTx).toBeNull();
    expect(p.checks.approve).toBeNull();
    expect(calls.some((c) => c.path === "/api/v1/dex/aggregator/approve-transaction")).toBe(false);
  });

  it("refuses an RFQ quote before building anything", async () => {
    const { api, calls } = fakeApi((r) => (r.quote[0].executionMode = "RFQ"));
    expect(await refusal(plan(api))).toMatch(/RFQ/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a swap that comes back as RFQ", async () => {
    const { api } = fakeApi((r) => {
      r.swap.executionMode = "RFQ";
      r.swap.tx = null;
    });
    expect(await refusal(plan(api))).toMatch(/RFQ/);
  });

  it("refuses a mismatched chain in the quote or the swap", async () => {
    expect(await refusal(plan(fakeApi((r) => (r.quote[0].binanceChainId = "1")).api))).toMatch(/another chain/);
    expect(await refusal(plan(fakeApi((r) => (r.swap.routerResult.binanceChainId = "1")).api))).toMatch(/another chain/);
  });

  it("refuses a mismatched token in the quote or the swap", async () => {
    expect(await refusal(plan(fakeApi((r) => (r.quote[0].toToken.tokenContractAddress = OTHER)).api))).toMatch(/other than the requested stock/);
    expect(await refusal(plan(fakeApi((r) => (r.quote[0].fromToken.tokenContractAddress = OTHER)).api))).toMatch(/other than USDT/);
    expect(await refusal(plan(fakeApi((r) => (r.swap.routerResult.toToken.tokenContractAddress = OTHER)).api))).toMatch(/other than the requested stock/);
  });

  it("refuses a different amount or a swap built for another wallet", async () => {
    expect(await refusal(plan(fakeApi((r) => (r.quote[0].fromTokenAmount = "2000000000000000000")).api))).toMatch(/different amount/);
    expect(await refusal(plan(fakeApi((r) => (r.swap.tx.from = OTHER)).api))).toMatch(/different wallet/);
  });

  it("refuses a missing, duplicated or out-of-band reference price", async () => {
    expect(await refusal(plan(fakeApi((r) => (r.rwaPrice = [])).api))).toMatch(/AAPLB and AMZNB/);
    expect(await refusal(plan(fakeApi((r) => r.rwaPrice.push({ ...r.rwaPrice[0] })).api))).toMatch(/more than once/);
    expect(await refusal(plan(fakeApi((r) => (r.rwaPrice[0].tokenPrice = "230")).api))).toMatch(/bps above the reference/);
  });

  it("refuses an approval to another spender or for an unlimited amount", async () => {
    expect(await refusal(plan(fakeApi((r) => (r.approve[0].dexContractAddress = OTHER)).api))).toMatch(/spender/);
    const unlimited = `0x095ea7b3${EXPECTED_ROUTER.slice(2).toLowerCase().padStart(64, "0")}${maxUint256.toString(16)}`;
    expect(await refusal(plan(fakeApi((r) => (r.approve[0].data = unlimited)).api))).toMatch(/unlimited/);
  });

  it("refuses a swap to another router or with a minimum below our floor", async () => {
    expect(await refusal(plan(fakeApi((r) => (r.swap.tx.to = OTHER)).api))).toMatch(/router/);
    expect(await refusal(plan(fakeApi((r) => (r.swap.tx.minReceiveAmount = "4136525573308006")).api))).toMatch(/below our slippage floor/);
  });

  it("refuses a malformed quote", async () => {
    expect(await refusal(plan(fakeApi((r) => (r.quote = [])).api))).toMatch(/expected shape/);
    expect(await refusal(plan(fakeApi((r) => (r.quote[0].toTokenAmount = "4.1e15")).api))).toMatch(/expected shape/);
  });
});
