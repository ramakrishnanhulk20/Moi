// Covers the giftable stock list, its cache and the /api/stocks handler, with a fake chain and a
// fake Web3 API. Not covered here: the live RWA endpoints and a real RPC (prove.ts dry run and
// prove.fork.test.ts read the real vault list), and how a page renders the text it gets.
import { getAddress, type Address, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStocksCache, getGiftableStocks, handleStocks } from "../src/stocks.js";
import { Web3ApiError, type ApiPath, type Web3Api } from "../src/web3api.js";

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const AAPLB = getAddress("0x7c26a12f20507e2cee22ceebed9e88fda47f866c");
const TSLAB = getAddress("0x16cd4fe7e8880ecc3ba222795229e20489fc2c76");
const extra = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

type TokenFake = { symbol: string; name: string; decimals: number; uiMultiplier?: bigint };

const TOKENS: Record<Address, TokenFake> = {
  [NVDAB]: { symbol: "NVDAB", name: "NVIDIA (bStocks)", decimals: 18, uiMultiplier: 1_000_778_223_752_807_865n },
  [AAPLB]: { symbol: "AAPLB", name: "Apple (bStocks)", decimals: 18, uiMultiplier: 1_000_000_000_000_000_000n },
  [TSLAB]: { symbol: "TSLAB", name: "Tesla (bStocks)", decimals: 18 },
};

function fakeClient(list: Address[], tokens: Record<Address, TokenFake> = TOKENS) {
  const counter = { reads: 0 };
  const client = {
    async getChainId() {
      return 56;
    },
    async readContract({ address, functionName }: { address: Address; functionName: string }) {
      counter.reads += 1;
      if (getAddress(address) === VAULT) {
        if (functionName === "listedTokens") return list;
        throw new Error(`unexpected vault call ${functionName}`);
      }
      const t = tokens[getAddress(address)];
      if (t === undefined) throw new Error("no such token");
      if (functionName === "decimals") return t.decimals;
      if (functionName === "symbol") return t.symbol;
      if (functionName === "name") return t.name;
      if (functionName === "uiMultiplier" && t.uiMultiplier !== undefined) return t.uiMultiplier;
      throw new Error("execution reverted");
    },
  } as unknown as PublicClient;
  return { client, counter };
}

const LOGO = "https://onchainos.bnbstatic.com/images/web3-data/public/token/logos/9dc00cf6.png";

function tokenRow(address: string, over: Record<string, unknown> = {}) {
  return {
    binanceChainId: "56",
    tokenContractAddress: address.toLowerCase(),
    platformId: "bstock",
    tokenName: "from the API, not used",
    tokenSymbol: "IGNORED",
    tokenLogoUrl: LOGO,
    statusInfo: { openState: true, marketStatus: null, reasonCode: "TRADING", reasonMsg: null, nextOpenTime: null, nextCloseTime: null },
    ...over,
  };
}

function priceRow(address: string, tokenPrice: string) {
  return { binanceChainId: "56", tokenContractAddress: address.toLowerCase(), platformId: "bstock", tokenPrice };
}

function fakeApi(prices: unknown, tokens: unknown) {
  const calls: { path: ApiPath; params: Record<string, string> }[] = [];
  const api: Web3Api = {
    async get(path, params) {
      calls.push({ path, params });
      if (path === "/api/v1/dex/market/rwa/price") return prices;
      if (path === "/api/v1/dex/market/rwa/tokens") return tokens;
      throw new Error(`unexpected path ${path}`);
    },
    async post() {
      throw new Error("no POST expected");
    },
  };
  return { api, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getGiftableStocks", () => {
  it("takes the token list from the vault only, in the vault's order, with chain facts from the contracts", async () => {
    const { client } = fakeClient([NVDAB, AAPLB]);
    const { api, calls } = fakeApi(
      [priceRow(TSLAB, "400.1"), priceRow(AAPLB, "334.78000000"), priceRow(NVDAB, "240.20678926")],
      [tokenRow(TSLAB), tokenRow(NVDAB)],
    );
    const stocks = await getGiftableStocks({ client, vault: VAULT, api });
    expect(stocks.map((s) => s.address)).toEqual([NVDAB, AAPLB]);
    expect(stocks[0]).toEqual({
      address: NVDAB,
      symbol: "NVDAB",
      name: "NVIDIA (bStocks)",
      decimals: 18,
      uiMultiplier: "1000778223752807865",
      priceUsd: "240.20678926",
      market: { open: true, reasonCode: "TRADING", reasonMsg: null, nextOpenTime: null },
      logoUrl: LOGO,
    });
    expect(calls).toEqual([
      { path: "/api/v1/dex/market/rwa/price", params: { binanceChainId: "56", tokenContractAddresses: `${NVDAB},${AAPLB}` } },
      { path: "/api/v1/dex/market/rwa/tokens", params: { binanceChainId: "56", platformId: "bstock" } },
    ]);
  });

  it("gives a token missing from the RWA list null market fields and a null logo, and keeps its price", async () => {
    const { client } = fakeClient([AAPLB]);
    const { api } = fakeApi([priceRow(AAPLB, "334.78000000")], [tokenRow(NVDAB)]);
    const [aaplb] = await getGiftableStocks({ client, vault: VAULT, api });
    expect(aaplb?.priceUsd).toBe("334.78000000");
    expect(aaplb?.market).toEqual({ open: null, reasonCode: null, reasonMsg: null, nextOpenTime: null });
    expect(aaplb?.logoUrl).toBeNull();
  });

  it("drops a logo that is plain http, on another host, a lookalike host or not https at all", async () => {
    const logos = [
      "http://onchainos.bnbstatic.com/a.png",
      "https://evil.example/a.png",
      "https://bnbstatic.com.evil.example/a.png",
      "https://evilbnbstatic.com/a.png",
      "javascript:alert(1)//.bnbstatic.com",
      "//onchainos.bnbstatic.com/a.png",
      "https://bnbstatic.com/a.png",
    ];
    const list = logos.map((_, i) => extra(i + 1));
    const tokens = Object.fromEntries(list.map((a) => [a, { symbol: "X", name: "X", decimals: 18 }]));
    const { client } = fakeClient(list, tokens);
    const { api } = fakeApi([], list.map((a, i) => tokenRow(a, { tokenLogoUrl: logos[i] })));
    const stocks = await getGiftableStocks({ client, vault: VAULT, api });
    expect(stocks.map((s) => s.logoUrl)).toEqual([null, null, null, null, null, null, "https://bnbstatic.com/a.png"]);
  });

  it("trims a 300-character name and upstream text to 64 characters without splitting an emoji", async () => {
    const long = "N".repeat(300);
    const { client } = fakeClient([NVDAB], { [NVDAB]: { symbol: `${"S".repeat(63)}🎁🎁`, name: long, decimals: 18 } });
    const { api } = fakeApi([], [tokenRow(NVDAB, { statusInfo: { openState: false, reasonCode: "<b>x</b>".repeat(40), reasonMsg: long, nextOpenTime: 1_791_300_000_000 } })]);
    const [s] = await getGiftableStocks({ client, vault: VAULT, api });
    expect(s?.name).toBe("N".repeat(64));
    expect(s?.symbol).toBe(`${"S".repeat(63)}🎁`);
    expect(s?.market.reasonMsg).toBe("N".repeat(64));
    expect(s?.market.reasonCode).toBe("<b>x</b>".repeat(8));
    expect(s?.market.open).toBe(false);
    expect(s?.market.nextOpenTime).toBe(1_791_300_000_000);
    expect(s?.uiMultiplier).toBe("1000000000000000000");
  });

  it("gives nulls for a token listed twice, a malformed price and malformed status fields", async () => {
    const { client } = fakeClient([NVDAB, AAPLB]);
    const { api } = fakeApi(
      [priceRow(NVDAB, "240.1"), priceRow(NVDAB, "1"), priceRow(AAPLB, "1e3")],
      [tokenRow(NVDAB), tokenRow(NVDAB), tokenRow(AAPLB, { statusInfo: { openState: "yes", reasonCode: 5, nextOpenTime: -1 } })],
    );
    const [nvdab, aaplb] = await getGiftableStocks({ client, vault: VAULT, api });
    expect(nvdab?.priceUsd).toBeNull();
    expect(nvdab?.logoUrl).toBeNull();
    expect(nvdab?.market.open).toBeNull();
    expect(aaplb?.priceUsd).toBeNull();
    expect(aaplb?.market).toEqual({ open: null, reasonCode: null, reasonMsg: null, nextOpenTime: null });
  });

  it("makes no API call for an empty vault list and throws when an API answer is not a list", async () => {
    const empty = fakeApi([], []);
    expect(await getGiftableStocks({ client: fakeClient([]).client, vault: VAULT, api: empty.api })).toEqual([]);
    expect(empty.calls).toHaveLength(0);
    await expect(getGiftableStocks({ client: fakeClient([NVDAB]).client, vault: VAULT, api: fakeApi([], { rows: [] }).api })).rejects.toThrow(/rwa\/tokens/);
  });
});

describe("createStocksCache", () => {
  it("serves a second call inside the TTL from memory and fetches again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_791_000_000_000);
    const { client, counter } = fakeClient([NVDAB]);
    const { api, calls } = fakeApi([priceRow(NVDAB, "240")], [tokenRow(NVDAB)]);
    const cached = createStocksCache(60_000);
    const first = await cached({ client, vault: VAULT, api });
    const reads = counter.reads;
    vi.setSystemTime(1_791_000_059_999);
    expect(await cached({ client, vault: VAULT, api })).toBe(first);
    expect(calls).toHaveLength(2);
    expect(counter.reads).toBe(reads);
    vi.setSystemTime(1_791_000_060_000);
    await cached({ client, vault: VAULT, api });
    expect(calls).toHaveLength(4);
  });

  it("runs one fetch for two concurrent calls, and does not keep a failure", async () => {
    const { client } = fakeClient([NVDAB]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fetches = 0;
    let fail = true;
    const api: Web3Api = {
      async get(path) {
        if (path === "/api/v1/dex/market/rwa/price") {
          fetches += 1;
          await gate;
          if (fail) throw new Web3ApiError(path, 500, "50000", "upstream boom");
        }
        return [];
      },
      async post() {
        throw new Error("no POST expected");
      },
    };
    const cached = createStocksCache();
    const a = cached({ client, vault: VAULT, api });
    const b = cached({ client, vault: VAULT, api });
    release?.();
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(fetches).toBe(1);
    fail = false;
    expect(await cached({ client, vault: VAULT, api })).toHaveLength(1);
    expect(fetches).toBe(2);
  });
});

describe("handleStocks", () => {
  it("answers 200 with the list and the time", async () => {
    const { client } = fakeClient([NVDAB]);
    const { api } = fakeApi([priceRow(NVDAB, "240")], [tokenRow(NVDAB)]);
    const res = await handleStocks({ client, vault: VAULT, api, now: () => 1_791_000_000_000 });
    expect(res.status).toBe(200);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.body.asOf).toBe(1_791_000_000_000);
    expect(res.body.stocks.map((s) => s.symbol)).toEqual(["NVDAB"]);
  });

  it("maps any upstream failure to 502 upstream_unavailable with no upstream text", async () => {
    const { client } = fakeClient([NVDAB]);
    const api: Web3Api = {
      async get(path) {
        throw new Web3ApiError(path, 500, "50000", "secret upstream detail");
      },
      async post() {
        throw new Error("no POST expected");
      },
    };
    const res = await handleStocks({ client, vault: VAULT, api });
    expect(res).toEqual({ status: 502, body: { ok: false, error: "upstream_unavailable" } });
    expect(JSON.stringify(res)).not.toContain("secret");
  });
});
