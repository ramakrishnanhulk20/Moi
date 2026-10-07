import { createHmac } from "node:crypto";

const BASE_URL = "https://web3.binance.com/build";
const BUILD_PREFIX = "/build";
const DEFAULT_TIMEOUT_MS = 10_000;
// A full multi-route quote is a few KB. Anything near this cap is not a real answer.
const MAX_RESPONSE_BYTES = 1_000_000;
const UPSTREAM_MSG_MAX = 200;

export const API_PATHS = [
  "/api/v1/dex/aggregator/quote",
  "/api/v1/dex/aggregator/approve-transaction",
  "/api/v1/dex/aggregator/swap",
  "/api/v1/dex/pre-transaction/simulate",
  "/api/v1/dex/market/rwa/price",
  "/api/v1/dex/market/rwa/tokens",
  "/api/v2/b402/supported",
  "/api/v2/b402/verify",
  "/api/v2/b402/settle",
] as const;

export type ApiPath = (typeof API_PATHS)[number];

export type Method = "GET" | "POST";

export type CallRecord = {
  path: ApiPath;
  method: Method;
  ms: number;
  httpStatus: number;
  code: string | null;
  upstreamMsg: string | null;
};

export type Web3ApiOptions = {
  apiKey: string;
  secretKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onCall?: (c: CallRecord) => void;
};

export type Web3Api = {
  get(path: ApiPath, params: Record<string, string>): Promise<unknown>;
  post(path: ApiPath, body: unknown): Promise<unknown>;
};

/**
 * Thrown for every failed call: transport error, timeout, non-2xx status, non-JSON body or a
 * business code other than success. Carries only what the gateway said, scrubbed of anything
 * this client sent as a credential.
 */
export class Web3ApiError extends Error {
  readonly path: string;
  readonly httpStatus: number;
  readonly code: string | null;
  readonly upstreamMsg: string | null;
  constructor(path: string, httpStatus: number, code: string | null, upstreamMsg: string | null) {
    super(`Web3 API ${path} failed: HTTP ${httpStatus}, code ${code ?? "none"}${upstreamMsg ? `, ${upstreamMsg}` : ""}`);
    this.name = "Web3ApiError";
    this.path = path;
    this.httpStatus = httpStatus;
    this.code = code;
    this.upstreamMsg = upstreamMsg;
  }
}

const SUCCESS_CODES = new Set(["0", "000000000"]);

/** Query string exactly as it goes on the wire: encodeURIComponent on both sides, caller order kept. */
export function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** timestamp + METHOD + "/build" + path (+ "?" + query when present) + body, per the Authentication page. */
export function buildPreHash(timestamp: string, method: Method, path: string, query: string, body: string): string {
  return timestamp + method + BUILD_PREFIX + path + (query ? `?${query}` : "") + body;
}

export function signPreHash(preHash: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(preHash, "utf8").digest("base64");
}

function scrub(raw: unknown, secrets: string[]): string | null {
  if (raw === null || raw === undefined) return null;
  let text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
  for (const s of secrets) {
    if (s.length > 0) text = text.split(s).join("[redacted]");
  }
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  return text.length > UPSTREAM_MSG_MAX ? `${text.slice(0, UPSTREAM_MSG_MAX)}...` : text;
}

function normaliseCode(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 32) return raw;
  return null;
}

export function createWeb3Api(opts: Web3ApiOptions): Web3Api {
  const { apiKey, secretKey } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!apiKey || !secretKey) throw new Error("createWeb3Api needs an API key and a secret key.");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("timeoutMs must be a whole number of milliseconds between 1 and 60000.");
  }

  const report = (c: CallRecord) => {
    try {
      opts.onCall?.(c);
    } catch {
      // The call log is for the developer report only. A broken logger must not change the
      // outcome of a money call in either direction.
    }
  };

  async function call(method: Method, path: ApiPath, query: string, body: string): Promise<unknown> {
    // The type system stops a wrong path at compile time; this stops one built at run time.
    if (!(API_PATHS as readonly string[]).includes(path)) {
      throw new Web3ApiError(String(path).slice(0, 80), 0, null, "path is not on the fixed list");
    }
    const timestamp = new Date().toISOString();
    const signature = signPreHash(buildPreHash(timestamp, method, path, query, body), secretKey);
    const secrets = [apiKey, secretKey, signature];
    const url = BASE_URL + path + (query ? `?${query}` : "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    let httpStatus = 0;
    let text: string;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          "X-OC-APIKEY": apiKey,
          "X-OC-TIMESTAMP": timestamp,
          "X-OC-SIGN": signature,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" ? body : undefined,
        // The host is fixed. Following a redirect would send the signed headers somewhere else.
        redirect: "error",
        signal: controller.signal,
      });
      httpStatus = res.status;
      text = await res.text();
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      const reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : "network error";
      report({ path, method, ms, httpStatus, code: null, upstreamMsg: reason });
      throw new Web3ApiError(path, httpStatus, null, reason);
    } finally {
      clearTimeout(timer);
    }
    const ms = Math.round(performance.now() - started);

    if (text.length > MAX_RESPONSE_BYTES) {
      report({ path, method, ms, httpStatus, code: null, upstreamMsg: "response too large" });
      throw new Web3ApiError(path, httpStatus, null, "response too large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const msg = text.length === 0 ? "empty body" : "body is not JSON";
      report({ path, method, ms, httpStatus, code: null, upstreamMsg: msg });
      throw new Web3ApiError(path, httpStatus, null, msg);
    }

    const envelope = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const code = normaliseCode(envelope.code);
    // b402 answers errors in errorData instead of msg. Either way the text is for the call log and
    // the thrown error only; handlers answer clients with their own fixed codes (C19).
    const upstreamMsg = scrub(envelope.msg ?? envelope.errorData, secrets);
    report({ path, method, ms, httpStatus, code, upstreamMsg });

    const ok2xx = httpStatus >= 200 && httpStatus < 300;
    if (!ok2xx || code === null || !SUCCESS_CODES.has(code)) {
      throw new Web3ApiError(path, httpStatus, code, upstreamMsg);
    }
    return envelope.data;
  }

  return {
    get(path, params) {
      for (const [k, v] of Object.entries(params)) {
        if (typeof v !== "string") throw new Web3ApiError(path, 0, null, `parameter ${k.slice(0, 40)} is not a string`);
      }
      return call("GET", path, buildQuery(params), "");
    },
    post(path, body) {
      const raw = JSON.stringify(body);
      if (typeof raw !== "string") throw new Web3ApiError(path, 0, null, "body is not serialisable");
      return call("POST", path, "", raw);
    },
  };
}
