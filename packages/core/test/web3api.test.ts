// Not covered here: the live gateway. Every call goes to a fake fetch, so this proves what we
// send and how we read answers, not that Binance accepts it. The slice run proves that.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPreHash, buildQuery, createWeb3Api, signPreHash, Web3ApiError, type CallRecord } from "../src/web3api.js";

const DOC_TIME = "2026-05-11T10:08:57.715Z";
const API_KEY = "fake-api-key-0001";
const SECRET = "fake-secret-key-0002";

type Captured = { url: string; init: RequestInit };

function fakeFetch(status: number, body: string, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

async function errorOf(p: Promise<unknown>): Promise<Web3ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Web3ApiError) return err;
    throw err;
  }
  throw new Error("expected a Web3ApiError");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("signing strings from the Authentication page", () => {
  it("builds the documented GET preHash exactly", () => {
    const query = buildQuery({ chainId: "1", symbol: "ETH USDT" });
    expect(buildPreHash(DOC_TIME, "GET", "/api/v1/dex/market/price", query, "")).toBe(
      "2026-05-11T10:08:57.715ZGET/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT",
    );
  });

  it("builds the documented POST preHash exactly", () => {
    const body = '{"chainId":1,"fromToken":"0xEEEE...","toToken":"0xA0b8...","amount":"1000000000000000000"}';
    expect(buildPreHash(DOC_TIME, "POST", "/api/v1/dex/swap", "", body)).toBe(
      '2026-05-11T10:08:57.715ZPOST/build/api/v1/dex/swap{"chainId":1,"fromToken":"0xEEEE...","toToken":"0xA0b8...","amount":"1000000000000000000"}',
    );
  });

  it("encodes a space as %20 and keeps the caller's parameter order", () => {
    expect(buildQuery({ z: "a b", a: "1&2" })).toBe("z=a%20b&a=1%262");
    expect(buildQuery({})).toBe("");
  });

  it("signs with base64 HMAC-SHA256", () => {
    const expected = createHmac("sha256", SECRET).update("abc", "utf8").digest("base64");
    expect(signPreHash("abc", SECRET)).toBe(expected);
  });
});

describe("createWeb3Api", () => {
  it("sends a GET to the fixed host with the documented headers and signature", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(DOC_TIME));
    const captured: Captured[] = [];
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, '{"code":0,"msg":"success","data":[1]}', captured) });
    const data = await api.get("/api/v1/dex/aggregator/quote", { binanceChainId: "56", amount: "1 0" });
    expect(data).toEqual([1]);
    const sent = captured[0]!;
    expect(sent.url).toBe("https://web3.binance.com/build/api/v1/dex/aggregator/quote?binanceChainId=56&amount=1%200");
    expect(sent.init.method).toBe("GET");
    expect(sent.init.redirect).toBe("error");
    expect(header(sent.init, "X-OC-APIKEY")).toBe(API_KEY);
    expect(header(sent.init, "X-OC-TIMESTAMP")).toBe(DOC_TIME);
    const preHash = `${DOC_TIME}GET/build/api/v1/dex/aggregator/quote?binanceChainId=56&amount=1%200`;
    expect(header(sent.init, "X-OC-SIGN")).toBe(createHmac("sha256", SECRET).update(preHash, "utf8").digest("base64"));
  });

  it("signs exactly the POST body it sends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(DOC_TIME));
    const captured: Captured[] = [];
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, '{"code":"0","data":{"ok":true}}', captured) });
    await api.post("/api/v1/dex/pre-transaction/simulate", { binanceChainId: "56", evmTx: { from: "0x1", to: "0x2", value: "0", data: "0x" } });
    const sent = captured[0]!;
    const body = '{"binanceChainId":"56","evmTx":{"from":"0x1","to":"0x2","value":"0","data":"0x"}}';
    expect(sent.url).toBe("https://web3.binance.com/build/api/v1/dex/pre-transaction/simulate");
    expect(sent.init.body).toBe(body);
    expect(header(sent.init, "Content-Type")).toBe("application/json");
    const preHash = `${DOC_TIME}POST/build/api/v1/dex/pre-transaction/simulate${body}`;
    expect(header(sent.init, "X-OC-SIGN")).toBe(signPreHash(preHash, SECRET));
  });

  it("accepts the three documented success codes", async () => {
    for (const code of ["0", '"0"', '"000000000"']) {
      const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, `{"code":${code},"data":"x"}`) });
      await expect(api.get("/api/v1/dex/aggregator/swap", {})).resolves.toBe("x");
    }
  });

  it("never puts the key, the secret or the signature in an error, even when the gateway echoes them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(DOC_TIME));
    const signature = signPreHash(`${DOC_TIME}GET/build/api/v1/dex/aggregator/quote`, SECRET);
    const hostile = JSON.stringify({ code: 40102, msg: `Invalid signature ${signature} for ${API_KEY} using ${SECRET}` });
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(401, hostile) });
    const err = await errorOf(api.get("/api/v1/dex/aggregator/quote", {}));
    const everything = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)} ${String(err.upstreamMsg)}`;
    for (const s of [API_KEY, SECRET, signature, "X-OC-SIGN", "X-OC-APIKEY"]) {
      expect(everything).not.toContain(s);
    }
    expect(err.httpStatus).toBe(401);
    expect(err.code).toBe("40102");
    expect(err.path).toBe("/api/v1/dex/aggregator/quote");
  });

  it("posts a b402 call to its fixed path, signs the {body} wrapper and reads the b402 envelope", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(DOC_TIME));
    const captured: Captured[] = [];
    const envelope = '{"status":"OK","type":"GENERAL","code":"000000000","errorData":null,"data":{"kinds":[]},"subData":null,"params":null}';
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, envelope, captured) });
    for (const path of ["/api/v2/b402/supported", "/api/v2/b402/verify", "/api/v2/b402/settle"] as const) {
      await expect(api.post(path, { body: {} })).resolves.toEqual({ kinds: [] });
    }
    const sent = captured[0]!;
    expect(sent.url).toBe("https://web3.binance.com/build/api/v2/b402/supported");
    expect(sent.init.body).toBe('{"body":{}}');
    expect(header(sent.init, "X-OC-SIGN")).toBe(signPreHash(`${DOC_TIME}POST/build/api/v2/b402/supported{"body":{}}`, SECRET));
    expect(captured.map((c) => c.url.slice("https://web3.binance.com/build".length))).toEqual(["/api/v2/b402/supported", "/api/v2/b402/verify", "/api/v2/b402/settle"]);
  });

  it("throws on a b402 envelope whose code is not the nine-zero success code", async () => {
    for (const code of ['"000000"', '"40104"', "null"]) {
      const body = `{"status":"ERROR","type":"GENERAL","code":${code},"errorData":"denied","data":null}`;
      const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, body) });
      await errorOf(api.post("/api/v2/b402/settle", { body: {} }));
    }
  });

  it("logs b402's errorData as the upstream message when msg is absent, scrubbed of credentials", async () => {
    const calls: CallRecord[] = [];
    const body = JSON.stringify({ status: "ERROR", type: "GENERAL", code: "40104", errorData: `No permission: B402 for ${API_KEY}`, data: null });
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, body), onCall: (c) => calls.push(c) });
    const err = await errorOf(api.post("/api/v2/b402/verify", { body: {} }));
    expect(err.upstreamMsg).toBe("No permission: B402 for [redacted]");
    expect(calls[0]?.upstreamMsg).toBe("No permission: B402 for [redacted]");
    const both = JSON.stringify({ code: 40001, msg: "from msg", errorData: "from errorData" });
    const api2 = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, both) });
    expect((await errorOf(api2.post("/api/v2/b402/verify", { body: {} }))).upstreamMsg).toBe("from msg");
  });

  it("throws on a business error inside HTTP 200", async () => {
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, '{"code":40401,"msg":"Quote expired","data":null}') });
    const err = await errorOf(api.get("/api/v1/dex/aggregator/swap", {}));
    expect(err.code).toBe("40401");
    expect(err.upstreamMsg).toBe("Quote expired");
  });

  it("throws on a non-2xx status even when the body says success", async () => {
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(503, '{"code":0,"data":[]}') });
    expect((await errorOf(api.get("/api/v1/dex/aggregator/quote", {}))).httpStatus).toBe(503);
  });

  it("throws on a non-JSON or empty body", async () => {
    for (const body of ["<html>challenge</html>", ""]) {
      const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(202, body) });
      expect((await errorOf(api.get("/api/v1/dex/aggregator/quote", {}))).code).toBeNull();
    }
  });

  it("throws when the body has no code at all", async () => {
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, '{"data":[]}') });
    await errorOf(api.get("/api/v1/dex/aggregator/quote", {}));
  });

  it("times out and reports it", async () => {
    const hang = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const calls: CallRecord[] = [];
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, timeoutMs: 20, fetchImpl: hang, onCall: (c) => calls.push(c) });
    const err = await errorOf(api.get("/api/v1/dex/aggregator/quote", {}));
    expect(err.upstreamMsg).toContain("timed out");
    expect(calls[0]?.httpStatus).toBe(0);
  });

  it("refuses a path that is not on the fixed list, even if forced past the type check", async () => {
    const captured: Captured[] = [];
    const api = createWeb3Api({ apiKey: API_KEY, secretKey: SECRET, fetchImpl: fakeFetch(200, '{"code":0}', captured) });
    const forced = "/api/v1/dex/aggregator/quote/../../../evil" as unknown as "/api/v1/dex/aggregator/quote";
    await errorOf(api.get(forced, {}));
    expect(captured).toHaveLength(0);
  });

  it("reports every call to onCall with no secret in the record", async () => {
    const calls: CallRecord[] = [];
    const api = createWeb3Api({
      apiKey: API_KEY,
      secretKey: SECRET,
      fetchImpl: fakeFetch(200, `{"code":40001,"msg":"bad ${SECRET}"}`),
      onCall: (c) => calls.push(c),
    });
    await errorOf(api.get("/api/v1/dex/aggregator/approve-transaction", {}));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/v1/dex/aggregator/approve-transaction", method: "GET", httpStatus: 200, code: "40001" });
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });
});
