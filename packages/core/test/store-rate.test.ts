// Covers the rate-limit key builder and one counter on the memory store. Not covered here: how
// http.ts picks windows and limits (http.test.ts), and counting on a real Upstash database.
import { describe, expect, it } from "vitest";
import { createMemoryStore, keys } from "../src/store.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}`;

describe("keys.rateLimit", () => {
  it("builds client and global keys under the zero address with a fixed prefix", () => {
    expect(keys.rateLimit("client", HASH, "post-29345678")).toBe(`moi:v1:56:${ZERO}:ratelimit:client-${HASH}-post-29345678`);
    expect(keys.rateLimit("global", "", "29345678")).toBe(`moi:v1:56:${ZERO}:ratelimit:global-29345678`);
  });

  it("writes one hash spelling and keeps clients, windows and scopes apart", () => {
    expect(keys.rateLimit("client", HASH.toUpperCase().replace("0X", "0x"), "get-1")).toBe(keys.rateLimit("client", HASH, "get-1"));
    expect(keys.rateLimit("client", HASH, "get-1")).not.toBe(keys.rateLimit("client", `0x${"cd".repeat(32)}`, "get-1"));
    expect(keys.rateLimit("client", HASH, "get-1")).not.toBe(keys.rateLimit("client", HASH, "post-1"));
    expect(keys.rateLimit("client", HASH, "get-1")).not.toBe(keys.rateLimit("client", HASH, "get-2"));
    expect(keys.rateLimit("global", "", "1")).not.toBe(keys.rateLimit("client", HASH, "1"));
  });

  it("refuses a raw address, a missing hash, a hash on the global counter and an unknown scope", () => {
    for (const raw of ["203.0.113.7", "unknown", "", "0x1234", `${HASH}:x`]) {
      expect(() => keys.rateLimit("client", raw, "get-1")).toThrow(RangeError);
    }
    expect(() => keys.rateLimit("global", HASH, "1")).toThrow(RangeError);
    expect(() => keys.rateLimit("other" as "client", HASH, "1")).toThrow(RangeError);
  });

  it("refuses a window that could leave its key or has another spelling", () => {
    for (const window of ["", "a:b", "GET-1", " 1", "1 ", "-1", "a".repeat(33), "moi:v1:56", "get_1", 7 as unknown as string]) {
      expect(() => keys.rateLimit("client", HASH, window)).toThrow(RangeError);
      expect(() => keys.rateLimit("global", "", window)).toThrow(RangeError);
    }
  });

  it("counts on the store and expires with its window", async () => {
    let now = 0;
    const store = createMemoryStore(() => now);
    const k = keys.rateLimit("client", HASH, "post-1");
    expect(await store.incrBy(k, 1n, 120)).toBe(1n);
    expect(await store.incrBy(k, 1n, 120)).toBe(2n);
    now = 121_000;
    expect(await store.incrBy(k, 1n, 120)).toBe(1n);
  });
});
