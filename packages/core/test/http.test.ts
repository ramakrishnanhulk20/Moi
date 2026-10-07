// Covers the request layer with every handler replaced by a fake: the fixed route table, the body
// cap, JSON parsing, the rate limits, the fixed headers, the 500 path and its log line, and
// clientFromHeaders. Not covered here: the handlers themselves (their own test files), a real
// Upstash store, Vercel's own header rewriting, and node:http (the live local run covers serve.ts).
import { getAddress, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/stocks.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/stocks.js")>()), handleStocks: vi.fn() }));
vi.mock("../src/quote.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/quote.js")>()), handleQuote: vi.fn() }));
vi.mock("../src/status.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/status.js")>()), handleGiftStatus: vi.fn() }));
vi.mock("../src/claim.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/claim.js")>()), handleClaim: vi.fn() }));
vi.mock("../src/wrap.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/wrap.js")>()), handleWrap: vi.fn() }));
vi.mock("../src/judge.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/judge.js")>()), handleJudgeClaim: vi.fn() }));

import { handleClaim } from "../src/claim.js";
import { clientFromHeaders, json, MAX_BODY_BYTES, route, type MoiRequest, type ServerDeps } from "../src/http.js";
import { handleJudgeClaim } from "../src/judge.js";
import { handleQuote } from "../src/quote.js";
import { handleGiftStatus } from "../src/status.js";
import { handleStocks } from "../src/stocks.js";
import { createMemoryStore, type KvStore } from "../src/store.js";
import type { Web3Api } from "../src/web3api.js";
import { handleWrap } from "../src/wrap.js";

const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const PAYOUT = getAddress("0x96e854abddc5c618ca843956d1303017b586ab75");
const TX = `0x${"aa".repeat(32)}` as const;
// 2026-10-07 12:00:10 UTC, so 50 seconds remain in the current minute.
const START = Date.UTC(2026, 9, 7, 12, 0, 10);
const CLAIM_BODY = JSON.stringify({ giftId: "1", recipient: PAYOUT, signature: `0x${"11".repeat(65)}`, declaration: true });
const api = { get: vi.fn(), post: vi.fn() } as unknown as Web3Api;
const wrapApi = { get: vi.fn(), post: vi.fn() } as unknown as Web3Api;

function setup(over: Partial<ServerDeps> = {}) {
  let nowMs = START;
  const lines: string[] = [];
  const deps: ServerDeps = {
    client: {} as PublicClient,
    api,
    wrapApi,
    store: createMemoryStore(() => nowMs),
    storeKind: "memory",
    relayer: { submitClaim: vi.fn() },
    vault: VAULT,
    payTo: PAYOUT,
    sponsor: null,
    origin: "http://localhost:3000",
    wrapPriceUsd: "0.05",
    judge: null,
    privyAppId: null,
    getStocks: async () => [],
    devAllowUnknownCountry: false,
    now: () => nowMs,
    log: (line) => lines.push(line),
    ...over,
  };
  return { deps, lines, advance: (ms: number) => (nowMs += ms) };
}

function request(method: string, path: string, over: Partial<MoiRequest> = {}): MoiRequest {
  return { method, path, headers: {}, body: null, clientIp: "203.0.113.7", country: "IN", region: null, ...over };
}

const post = (path: string, body: string | null = CLAIM_BODY, over: Partial<MoiRequest> = {}) => request("POST", path, { body, ...over });

const mocks = [handleStocks, handleQuote, handleGiftStatus, handleClaim, handleWrap, handleJudgeClaim].map((h) => vi.mocked(h as (...args: never[]) => unknown));
const handlerCalls = () => mocks.reduce((n, m) => n + m.mock.calls.length, 0);

beforeEach(() => {
  vi.mocked(handleStocks).mockReset().mockResolvedValue({ status: 200, body: { stocks: [], asOf: 1 } });
  vi.mocked(handleQuote).mockReset().mockResolvedValue({ status: 400, body: { ok: false, error: "bad_request" } });
  vi.mocked(handleGiftStatus).mockReset().mockResolvedValue({ status: 404, body: { ok: false, error: "not_found" } });
  vi.mocked(handleClaim).mockReset().mockResolvedValue({ status: 200, body: { ok: true, txHash: TX, reused: false } });
  vi.mocked(handleWrap).mockReset().mockResolvedValue({ status: 402, headers: { "PAYMENT-REQUIRED": "e30=" }, body: { x402Version: 2 } });
  vi.mocked(handleJudgeClaim).mockReset().mockResolvedValue({ status: 410, body: { ok: false, error: "pool_empty" } });
});

describe("route: the fixed table", () => {
  it("answers 404 for any path outside the table without calling a handler", async () => {
    const { deps } = setup();
    const paths = ["/", "/api", "/api/stock", "/api/stocks/", "/API/stocks", "/api/gift", "/api/claim/", "/api/stocks?x=1", "/api/../api/stocks", "//api/stocks", "/api/wrap", `/api/gift/${"1".repeat(200)}`];
    for (const path of paths) {
      for (const method of ["GET", "POST"]) {
        const res = await route(deps, request(method, path));
        expect(res.status).toBe(404);
        expect(JSON.parse(res.body)).toEqual({ ok: false, error: "not_found" });
      }
    }
    expect(handlerCalls()).toBe(0);
  });

  it("answers 405 with an Allow header for a known path and another method", async () => {
    const { deps } = setup();
    const cases: [string, string, string][] = [
      ["POST", "/api/stocks", "GET"],
      ["HEAD", "/api/stocks", "GET"],
      ["GET", "/api/quote", "POST"],
      ["get", "/api/gift/1", "GET"],
      ["GET", "/api/claim", "POST"],
      ["PUT", "/api/wrap/1", "POST"],
      ["OPTIONS", "/api/judge", "POST"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await route(deps, request(method, path));
      expect(res.status).toBe(405);
      expect(res.headers.Allow).toBe(allow);
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: "method_not_allowed" });
    }
    expect(handlerCalls()).toBe(0);
  });

  it("answers 404 for an id parseGiftId refuses, before any handler", async () => {
    const { deps } = setup();
    for (const id of ["", "0", "01", "0x1", "-1", "+1", "1e3", "1.0", " 1", "%31", "1/2", (1n << 256n).toString()]) {
      expect((await route(deps, request("GET", `/api/gift/${id}`))).status).toBe(404);
      expect((await route(deps, post(`/api/wrap/${id}`, null))).status).toBe(404);
    }
    expect(handlerCalls()).toBe(0);
  });

  it("hands the parsed id, the platform's place and the payment header to the right handler", async () => {
    const { deps } = setup({ devAllowUnknownCountry: true, sponsor: PAYOUT });
    await route(deps, request("GET", "/api/gift/42"));
    expect(vi.mocked(handleGiftStatus)).toHaveBeenCalledWith({ client: deps.client, vault: VAULT }, "42");

    for (const headers of [{ "payment-signature": "abc=" }, { "PAYMENT-SIGNATURE": "abc=" }]) {
      await route(deps, post("/api/wrap/7", null, { headers }));
      expect(vi.mocked(handleWrap)).toHaveBeenLastCalledWith(
        { api: wrapApi, client: deps.client, vault: VAULT, store: deps.store, origin: "http://localhost:3000", payTo: PAYOUT, priceUsd: "0.05" },
        "7",
        "abc=",
      );
    }
    await route(deps, post("/api/wrap/7", null, { headers: { "Payment-Signature": "a", "payment-signature": "b" } }));
    expect(vi.mocked(handleWrap).mock.lastCall?.[2]).toBeNull();

    await route(deps, post("/api/claim", CLAIM_BODY, { country: "SG", region: "01" }));
    expect(vi.mocked(handleClaim)).toHaveBeenCalledWith(
      { client: deps.client, vault: VAULT, relayer: deps.relayer, store: deps.store, sponsor: PAYOUT, devAllowUnknownCountry: true },
      JSON.parse(CLAIM_BODY),
      { country: "SG", region: "01", clientIp: "203.0.113.7" },
    );
    await route(deps, post("/api/quote", '{"stock":"x"}', { country: null }));
    expect(vi.mocked(handleQuote)).toHaveBeenCalledWith({ api, client: deps.client, vault: VAULT, devAllowUnknownCountry: true }, { stock: "x" }, {
      country: null,
      region: null,
      clientIp: "203.0.113.7",
    });
  });
});

describe("route: body cap and JSON", () => {
  it("refuses a body over 8 KB of UTF-8 with 413 before parsing it", async () => {
    const { deps } = setup();
    const broken = `{${"x".repeat(MAX_BODY_BYTES)}`;
    // 2731 euro signs are 2731 characters but 8193 bytes.
    const wide = JSON.stringify({ pad: "€".repeat(2728) });
    expect(new TextEncoder().encode(wide).length).toBeGreaterThan(MAX_BODY_BYTES);
    for (const body of [broken, wide]) {
      const res = await route(deps, post("/api/claim", body));
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: "body_too_large" });
    }
    expect((await route(deps, request("GET", "/api/stocks", { body: broken }))).status).toBe(413);
    expect(handlerCalls()).toBe(0);

    const exact = JSON.stringify({ pad: "y".repeat(MAX_BODY_BYTES - 10) });
    expect(exact.length).toBe(MAX_BODY_BYTES);
    expect((await route(deps, post("/api/claim", exact))).status).toBe(200);
    expect(vi.mocked(handleClaim)).toHaveBeenCalledTimes(1);
  });

  it("answers 400 bad_json for an empty or broken body without calling the handler", async () => {
    const { deps } = setup({ judge: { seed: `0x${"12".repeat(32)}`, pool: new Map([[1n, 0]]) }, privyAppId: "app123" });
    for (const path of ["/api/claim", "/api/quote", "/api/judge"]) {
      for (const body of [null, "", "{", "not json", '{"a":1}}']) {
        const res = await route(deps, post(path, body, { clientIp: "198.51.100.1" }));
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body)).toEqual({ ok: false, error: "bad_json" });
      }
    }
    expect(handlerCalls()).toBe(0);
  });
});

describe("route: rate limits (C23)", () => {
  it("allows 30 POSTs a minute per client, then 429 with Retry-After, and starts again next minute", async () => {
    const { deps, advance } = setup();
    for (let i = 0; i < 30; i += 1) expect((await route(deps, post("/api/claim"))).status).toBe(200);
    const limited = await route(deps, post("/api/claim"));
    expect(limited.status).toBe(429);
    expect(limited.headers["Retry-After"]).toBe("50");
    expect(JSON.parse(limited.body)).toEqual({ ok: false, error: "rate_limited" });
    expect(vi.mocked(handleClaim)).toHaveBeenCalledTimes(30);
    expect((await route(deps, post("/api/claim", CLAIM_BODY, { clientIp: "203.0.113.8" }))).status).toBe(200);
    expect((await route(deps, request("GET", "/api/stocks"))).status).toBe(200);
    advance(50_000);
    expect((await route(deps, post("/api/claim"))).status).toBe(200);
  });

  it("allows 120 GETs a minute per client", async () => {
    const { deps } = setup();
    for (let i = 0; i < 120; i += 1) expect((await route(deps, request("GET", "/api/stocks"))).status).toBe(200);
    expect((await route(deps, request("GET", "/api/gift/1"))).status).toBe(429);
  });

  it("keys Vercel callers on x-real-ip and ignores X-Forwarded-For", async () => {
    const { deps } = setup();
    const send = (headers: Record<string, string>) => route(deps, post("/api/claim", CLAIM_BODY, { headers, ...clientFromHeaders(headers, "vercel") }));
    for (let i = 0; i < 30; i += 1) {
      const res = await send({ "x-real-ip": "198.51.100.9", "x-forwarded-for": `10.0.0.${i}, 198.51.100.9`, "x-vercel-ip-country": "IN" });
      expect(res.status).toBe(200);
    }
    expect((await send({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "10.9.9.9", "x-vercel-ip-country": "IN" })).status).toBe(429);
    // Without x-real-ip every caller is "unknown", whatever X-Forwarded-For claims.
    for (let i = 0; i < 30; i += 1) expect((await send({ "x-forwarded-for": `192.0.2.${i}` })).status).toBe(200);
    expect((await send({ "x-forwarded-for": "192.0.2.200" })).status).toBe(429);
  });

  it("counts every caller without a usable address in one shared bucket", async () => {
    const { deps } = setup();
    for (let i = 0; i < 15; i += 1) {
      expect((await route(deps, post("/api/claim", CLAIM_BODY, { clientIp: null }))).status).toBe(200);
      expect((await route(deps, post("/api/claim", CLAIM_BODY, { clientIp: "not an address" }))).status).toBe(200);
    }
    expect((await route(deps, post("/api/claim", CLAIM_BODY, { clientIp: null }))).status).toBe(429);
  });

  it("stops everyone after 600 requests a minute, then opens next minute", async () => {
    const { deps, advance } = setup();
    for (let c = 0; c < 20; c += 1) {
      for (let i = 0; i < 30; i += 1) expect((await route(deps, request("GET", "/api/stocks", { clientIp: `192.0.2.${c}` }))).status).toBe(200);
    }
    expect((await route(deps, request("GET", "/api/stocks", { clientIp: "192.0.2.99" }))).status).toBe(429);
    advance(60_000);
    expect((await route(deps, request("GET", "/api/stocks", { clientIp: "192.0.2.99" }))).status).toBe(200);
  });

  it("refuses when the store cannot count, and calls no handler (fail closed)", async () => {
    const memory = createMemoryStore();
    const broken: KvStore = { ...memory, incrBy: async () => Promise.reject(new Error("store down: token abc")) };
    const odd: KvStore = { ...memory, incrBy: async () => 1 as unknown as bigint };
    for (const store of [broken, odd]) {
      const { deps } = setup({ store });
      const res = await route(deps, post("/api/claim"));
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: "store_unavailable" });
    }
    expect(handlerCalls()).toBe(0);
  });
});

describe("route: headers", () => {
  it("sends no-store on every response except a good stock list", async () => {
    const { deps } = setup({ judge: { seed: `0x${"12".repeat(32)}`, pool: new Map([[1n, 0]]) }, privyAppId: "app123" });
    const stocks = await route(deps, request("GET", "/api/stocks"));
    expect(stocks.headers["Cache-Control"]).toBe("public, max-age=30");
    const others = [
      request("GET", "/api/gift/1"),
      post("/api/quote", "{}"),
      post("/api/claim"),
      post("/api/wrap/1", null),
      post("/api/judge", "{}"),
      request("GET", "/nope"),
      request("POST", "/api/stocks"),
      post("/api/claim", "x".repeat(MAX_BODY_BYTES + 1)),
    ];
    vi.mocked(handleStocks).mockResolvedValueOnce({ status: 502, body: { ok: false, error: "upstream_unavailable" } });
    others.push(request("GET", "/api/stocks"));
    for (const r of others) {
      const res = await route(deps, r);
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
      expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });

  it("passes a handler's own headers through but never lets it override the fixed ones", async () => {
    const { deps } = setup();
    vi.mocked(handleWrap).mockResolvedValueOnce({
      status: 402,
      headers: { "PAYMENT-REQUIRED": "e30=", "Retry-After": "5", "cache-control": "public, max-age=999", "Content-Type": "text/html" },
      body: { x402Version: 2 },
    });
    const res = await route(deps, post("/api/wrap/3", null));
    expect(res.status).toBe(402);
    expect(res.headers).toEqual({
      "PAYMENT-REQUIRED": "e30=",
      "Retry-After": "5",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("answers 500 when a handler returns a header that could split the response", async () => {
    const { deps } = setup();
    vi.mocked(handleWrap).mockResolvedValueOnce({ status: 200, headers: { "X-Note": "a\r\nSet-Cookie: x=1" }, body: { ok: true } });
    const res = await route(deps, post("/api/wrap/3", null));
    expect(res.status).toBe(500);
    expect(res.body).toBe('{"ok":false,"error":"internal"}');
  });

  it("json adds the fixed headers and refuses a status outside 200 to 599", () => {
    expect(json(201, { a: 1 })).toEqual({
      status: 201,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      body: '{"a":1}',
    });
    expect(() => json(600, {})).toThrow(RangeError);
    expect(() => json(199, {})).toThrow(RangeError);
  });
});

describe("route: failures and logs (C19)", () => {
  it("turns a handler throw into a fixed 500 and logs one line with no address, body or key", async () => {
    const { deps, lines } = setup();
    const secret = `0x${"9f".repeat(32)}`;
    vi.mocked(handleClaim).mockRejectedValueOnce(new Error(`relayer key ${secret} failed for 203.0.113.7`));
    const body = JSON.stringify({ giftId: "1", recipient: PAYOUT, signature: secret, declaration: true });
    const res = await route(deps, post("/api/claim", body));
    expect(res.status).toBe(500);
    expect(res.body).toBe('{"ok":false,"error":"internal"}');
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["error", "ip", "route", "status", "t"]);
    expect(entry).toMatchObject({ route: "/api/claim", status: 500, error: "internal", t: "2026-10-07T12:00:10.000Z" });
    expect(entry.ip).toMatch(/^[0-9a-f]{8}$/);
    for (const leak of ["9f9f9f9f", "203.0.113.7", PAYOUT, "declaration", "relayer key"]) expect(line).not.toContain(leak);
  });

  it("logs every refusal once and nothing for a success", async () => {
    const { deps, lines } = setup();
    await route(deps, post("/api/claim"));
    expect(lines).toHaveLength(0);
    await route(deps, request("GET", "/api/<script>"));
    await route(deps, request("DELETE", "/api/claim"));
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { route: "unmatched", status: 404, error: "not_found" },
      { route: "/api/claim", status: 405, error: "method_not_allowed" },
    ]);
    expect(lines.join("\n")).not.toContain("script");
  });
});

describe("route: judge gifts (C26)", () => {
  it("answers 503 judge_gifts_closed without a pool, before any handler", async () => {
    const { deps } = setup();
    const res = await route(deps, post("/api/judge", "{}"));
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "judge_gifts_closed" });
    expect(handlerCalls()).toBe(0);
  });

  it("hands the judge handler the seed, pool, verifier and the platform's address and place, never cached", async () => {
    const verifyAccessToken = vi.fn();
    const judge = { seed: `0x${"12".repeat(32)}` as const, pool: new Map([[5n, 0]]) };
    const { deps } = setup({ judge, privyAppId: "app123", verifyAccessToken, devAllowUnknownCountry: true });
    const res = await route(deps, post("/api/judge", '{"a":1}', { region: "07" }));
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(vi.mocked(handleJudgeClaim)).toHaveBeenCalledWith(
      { client: deps.client, vault: VAULT, relayer: deps.relayer, store: deps.store, judgeSeed: judge.seed, pool: judge.pool, privyAppId: "app123", verifyAccessToken },
      { a: 1 },
      { country: "IN", region: "07", clientIp: "203.0.113.7", devAllowUnknownCountry: true },
    );
    await route(deps, post("/api/judge", "{}", { clientIp: null }));
    expect(vi.mocked(handleJudgeClaim).mock.lastCall?.[2]).toMatchObject({ clientIp: "" });
  });
});

describe("clientFromHeaders", () => {
  it("on Vercel reads x-real-ip and the Vercel place headers, never X-Forwarded-For", () => {
    expect(
      clientFromHeaders({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "10.0.0.1", "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "KA" }, "vercel"),
    ).toEqual({ clientIp: "198.51.100.9", country: "IN", region: "KA" });
    expect(clientFromHeaders({ "X-Real-IP": "::ffff:198.51.100.9", "X-Vercel-IP-Country": "SG" }, "vercel")).toEqual({
      clientIp: "198.51.100.9",
      country: "SG",
      region: null,
    });
    expect(clientFromHeaders({ "x-forwarded-for": "10.0.0.1" }, "vercel")).toEqual({ clientIp: null, country: null, region: null });
    expect(clientFromHeaders({ "x-real-ip": "198.51.100.9, 10.0.0.1" }, "vercel").clientIp).toBeNull();
    expect(clientFromHeaders({ "x-real-ip": "1.2.3.4", "X-Real-Ip": "5.6.7.8" }, "vercel").clientIp).toBeNull();
  });

  it("locally reads the socket address and MOI_DEV_COUNTRY, and no header", () => {
    const headers = { "x-real-ip": "198.51.100.9", "x-vercel-ip-country": "US" };
    expect(clientFromHeaders(headers, "local", { socketIp: "::ffff:127.0.0.1", devCountry: " IN " })).toEqual({ clientIp: "127.0.0.1", country: "IN", region: null });
    expect(clientFromHeaders(headers, "local", { socketIp: "::1" })).toEqual({ clientIp: "::1", country: null, region: null });
    expect(clientFromHeaders(headers, "local")).toEqual({ clientIp: null, country: null, region: null });
    expect(clientFromHeaders(headers, "other" as "local")).toEqual({ clientIp: null, country: null, region: null });
  });
});
