// Not covered here: a real Upstash database. Every Upstash call goes to a fake fetch, so this
// proves the command arrays we send and how we read replies, not that Upstash accepts them or
// that MULTI/EXEC is atomic there. Cross-process atomicity of the memory store is also out of
// scope: it lives in one process only.
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { createMemoryStore, createUpstashStore, keys, StoreError } from "../src/store.js";

const VAULT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER_VAULT: Address = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const RELAYER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const URL_ORIGIN = "https://eu1-fake-store.upstash.io";
const TOKEN = "fake-upstash-token-0001";

type Captured = { url: string; init: RequestInit };

function fakeFetch(replies: { status?: number; body: unknown }[], captured: Captured[] = []): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    const reply = replies[Math.min(i++, replies.length - 1)] ?? { body: { result: null } };
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  }) as typeof fetch;
}

function sent(c: Captured): unknown {
  return JSON.parse(String(c.init.body));
}

describe("keys", () => {
  it("builds canonical keys scoped to chain 56 and a checksummed address", () => {
    expect(keys.claim(VAULT, 1n)).toBe("moi:v1:56:0x5FbDB2315678afecb367f032d93F642f64180aa3:claim:1");
    expect(keys.claimLock(VAULT, 42n)).toBe("moi:v1:56:0x5FbDB2315678afecb367f032d93F642f64180aa3:claimlock:42");
    expect(keys.relayerSpent(RELAYER, "2026-10-07")).toBe("moi:v1:56:0x70997970C51812dc3A010C7d01b50e0d17dc79C8:relayerspent:2026-10-07");
    expect(keys.relayerSendLock(RELAYER)).toBe("moi:v1:56:0x70997970C51812dc3A010C7d01b50e0d17dc79C8:relayersendlock");
    expect(keys.relayerNonce(RELAYER)).toBe("moi:v1:56:0x70997970C51812dc3A010C7d01b50e0d17dc79C8:relayernonce");
    expect(keys.relayerNonce(RELAYER.toLowerCase() as Address)).toBe(keys.relayerNonce(RELAYER));
    expect(keys.claim(VAULT, (1n << 256n) - 1n)).toBe(`moi:v1:56:${VAULT}:claim:${(1n << 256n) - 1n}`);
    expect(keys.claim(VAULT.toLowerCase() as Address, 1n)).toBe(keys.claim(VAULT, 1n));
    expect(keys.relayerSendLock(RELAYER.toUpperCase().replace("0X", "0x") as Address)).toBe(keys.relayerSendLock(RELAYER));
  });

  it("gives the same gift id under two vaults two different keys", () => {
    expect(keys.claim(VAULT, 1n)).not.toBe(keys.claim(OTHER_VAULT, 1n));
    expect(keys.claimLock(VAULT, 1n)).not.toBe(keys.claimLock(OTHER_VAULT, 1n));
    expect(keys.relayerSpent(VAULT, "2026-10-07")).not.toBe(keys.relayerSpent(RELAYER, "2026-10-07"));
  });

  it("refuses a malformed address", () => {
    for (const bad of ["0x1234", "", `${VAULT} `, `${VAULT}00`, "0xZZbDB2315678afecb367f032d93F642f64180aa3", "moi:v1:56"]) {
      expect(() => keys.claim(bad as Address, 1n)).toThrow(RangeError);
      expect(() => keys.claimLock(bad as Address, 1n)).toThrow(RangeError);
      expect(() => keys.relayerSpent(bad as Address, "2026-10-07")).toThrow(RangeError);
      expect(() => keys.relayerSendLock(bad as Address)).toThrow(RangeError);
      expect(() => keys.relayerNonce(bad as Address)).toThrow(RangeError);
    }
    expect(() => keys.claim(undefined as unknown as Address, 1n)).toThrow(TypeError);
  });

  it("refuses gift ids outside 1 to 2^256 - 1 and non-bigints", () => {
    expect(() => keys.claim(VAULT, 0n)).toThrow();
    expect(() => keys.claim(VAULT, -1n)).toThrow();
    expect(() => keys.claimLock(VAULT, 1n << 256n)).toThrow();
    expect(() => keys.claim(VAULT, "1" as unknown as bigint)).toThrow();
    expect(() => keys.claim(VAULT, 1 as unknown as bigint)).toThrow();
  });

  it("refuses a malformed or impossible day", () => {
    for (const day of ["2026-10-7", "26-10-07", "2026-13-01", "2026-02-30", "2026-10-07T00:00", " 2026-10-07", "2026/10/07", "", "moi:v1:claim:1"]) {
      expect(() => keys.relayerSpent(RELAYER, day)).toThrow(RangeError);
    }
    expect(() => keys.relayerSpent(RELAYER, 20261007 as unknown as string)).toThrow(RangeError);
    expect(keys.relayerSpent(RELAYER, "2028-02-29")).toBe(`moi:v1:56:${RELAYER}:relayerspent:2028-02-29`);
  });
});

describe("createMemoryStore", () => {
  it("gets, sets and deletes", async () => {
    const store = createMemoryStore();
    const k = keys.claim(VAULT, 7n);
    expect(await store.get(k)).toBeNull();
    await store.set(k, "0xabc");
    expect(await store.get(k)).toBe("0xabc");
    await store.del(k);
    expect(await store.get(k)).toBeNull();
  });

  it("honours TTLs on set, setNx and incrBy", async () => {
    let t = 1_000_000;
    const store = createMemoryStore(() => t);
    await store.set(keys.claim(VAULT, 1n), "a", 10);
    expect(await store.setNx(keys.claimLock(VAULT, 1n), "lock", 60)).toBe(true);
    expect(await store.incrBy(keys.relayerSpent(RELAYER, "2026-10-07"), 5n, 30)).toBe(5n);
    t += 9_999;
    expect(await store.get(keys.claim(VAULT, 1n))).toBe("a");
    t += 1;
    expect(await store.get(keys.claim(VAULT, 1n))).toBeNull();
    t += 20_000;
    expect(await store.get(keys.relayerSpent(RELAYER, "2026-10-07"))).toBeNull();
    expect(await store.setNx(keys.claimLock(VAULT, 1n), "other", 60)).toBe(false);
    t += 30_000;
    expect(await store.setNx(keys.claimLock(VAULT, 1n), "other", 60)).toBe(true);
  });

  it("setNx writes only once while the key lives", async () => {
    const store = createMemoryStore();
    const k = keys.claimLock(VAULT, 3n);
    const results = await Promise.all([store.setNx(k, "a", 60), store.setNx(k, "b", 60)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.get(k)).toBe("a");
  });

  it("incrBy adds, subtracts and refuses non-integers and 64-bit overflow", async () => {
    const store = createMemoryStore();
    const k = keys.relayerSpent(RELAYER, "2026-10-07");
    expect(await store.incrBy(k, 100n, 60)).toBe(100n);
    expect(await store.incrBy(k, -40n, 60)).toBe(60n);
    await expect(store.incrBy(k, 1n << 63n, 60)).rejects.toThrow(RangeError);
    await expect(store.incrBy(k, (1n << 63n) - 1n, 60)).rejects.toThrow(StoreError);
    await store.set(k, "not a number");
    await expect(store.incrBy(k, 1n, 60)).rejects.toThrow(StoreError);
  });

  it("refuses a TTL that is not whole positive seconds", async () => {
    const store = createMemoryStore();
    await expect(store.setNx(keys.claimLock(VAULT, 1n), "a", 0)).rejects.toThrow(RangeError);
    await expect(store.set(keys.claim(VAULT, 1n), "a", 1.5)).rejects.toThrow(RangeError);
    await expect(store.incrBy(keys.relayerSpent(RELAYER, "2026-10-07"), 1n, Date.now())).rejects.toThrow(RangeError);
  });
});

describe("createUpstashStore", () => {
  it("sends the right REST command arrays with the bearer token", async () => {
    const captured: Captured[] = [];
    const store = createUpstashStore({
      url: URL_ORIGIN,
      token: TOKEN,
      fetchImpl: fakeFetch(
        [
          { body: { result: "0xhash" } },
          { body: { result: "OK" } },
          { body: { result: "OK" } },
          { body: { result: "OK" } },
          { body: { result: null } },
          { body: [{ result: 12 }, { result: 1 }, { result: "12345678901234567" }] },
          { body: { result: 1 } },
        ],
        captured,
      ),
    });
    const claim = keys.claim(VAULT, 5n);
    const lock = keys.claimLock(VAULT, 5n);
    const day = keys.relayerSpent(RELAYER, "2026-10-07");
    expect(await store.get(claim)).toBe("0xhash");
    await store.set(claim, "0xhash", 2_592_000);
    await store.set(claim, "0xhash");
    expect(await store.setNx(lock, "token", 60)).toBe(true);
    expect(await store.setNx(lock, "token", 60)).toBe(false);
    expect(await store.incrBy(day, 12_345_678_901_234_567n, 172_800)).toBe(12_345_678_901_234_567n);
    await store.del(lock);

    expect(captured.map(sent)).toEqual([
      ["GET", claim],
      ["SET", claim, "0xhash", "EX", "2592000"],
      ["SET", claim, "0xhash"],
      ["SET", lock, "token", "NX", "EX", "60"],
      ["SET", lock, "token", "NX", "EX", "60"],
      [
        ["INCRBY", day, "12345678901234567"],
        ["EXPIRE", day, "172800"],
        ["GET", day],
      ],
      ["DEL", lock],
    ]);
    expect(captured.map((c) => c.url)).toEqual([...Array(5).fill(URL_ORIGIN), `${URL_ORIGIN}/multi-exec`, URL_ORIGIN]);
    for (const c of captured) {
      expect(c.init.method).toBe("POST");
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("throws on a non-200 status without echoing the store's text or the token", async () => {
    const store = createUpstashStore({ url: URL_ORIGIN, token: TOKEN, fetchImpl: fakeFetch([{ status: 401, body: { error: `bad token ${TOKEN}` } }]) });
    const err = await store.get(keys.claim(VAULT, 1n)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain("bad token");
  });

  it("throws on a timeout", async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const store = createUpstashStore({ url: URL_ORIGIN, token: TOKEN, fetchImpl: hanging, timeoutMs: 30 });
    await expect(store.setNx(keys.claimLock(VAULT, 1n), "a", 60)).rejects.toThrow("store timed out");
  });

  it("throws on an error reply, a transport failure and an unexpected shape", async () => {
    const cases: { status?: number; body: unknown }[] = [
      { body: { error: "WRONGTYPE" } },
      { body: "not json" },
      { body: { result: 5 } },
      { body: [] },
    ];
    for (const reply of cases) {
      const store = createUpstashStore({ url: URL_ORIGIN, token: TOKEN, fetchImpl: fakeFetch([reply]) });
      await expect(store.get(keys.claim(VAULT, 1n))).rejects.toThrow(StoreError);
    }
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(createUpstashStore({ url: URL_ORIGIN, token: TOKEN, fetchImpl: broken }).del(keys.claim(VAULT, 1n))).rejects.toThrow(StoreError);
    const badTx = createUpstashStore({ url: URL_ORIGIN, token: TOKEN, fetchImpl: fakeFetch([{ body: [{ result: 1 }, { error: "boom" }, { result: "1" }] }]) });
    await expect(badTx.incrBy(keys.relayerSpent(RELAYER, "2026-10-07"), 1n, 60)).rejects.toThrow(StoreError);
    const badSet = createUpstashStore({ url: URL_ORIGIN, token: TOKEN, fetchImpl: fakeFetch([{ body: { result: null } }]) });
    await expect(badSet.set(keys.claim(VAULT, 1n), "x")).rejects.toThrow(StoreError);
  });

  it("refuses a URL that is not an https origin and a missing token", () => {
    for (const url of ["http://fake.upstash.io", "https://fake.upstash.io/path", "https://fake.upstash.io/?q=1", "not a url"]) {
      expect(() => createUpstashStore({ url, token: TOKEN })).toThrow();
    }
    expect(() => createUpstashStore({ url: URL_ORIGIN, token: "" })).toThrow();
  });
});
