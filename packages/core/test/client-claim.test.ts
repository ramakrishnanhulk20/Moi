// Not covered here: Moi's real /api/gift and /api/claim handlers (their own tests are status.test.ts
// and claim.test.ts; here the server is scripted), a real node, Privy sign-in, and the page's
// history.replaceState call that removes the fragment.
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  recoverAddress,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { claimGift, ClaimFlowError, loadGift, readLinkFromLocation } from "../src/client/claim.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { buildLink, claimDigest, newClaimKey, sealNote } from "../src/gift.js";

const ORIGIN = "https://moi.example";
const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const STOCK = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const RECIPIENT = privateKeyToAccount(generatePrivateKey()).address;
const OTHER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const TX = `0x${"ab".repeat(32)}` as Hex;

type Request = { url: string; method: string; body: string | null };
type Answer = { status: number; body: unknown } | Error;

function server(answer: (req: Request) => Answer) {
  const requests: Request[] = [];
  const fetchFake = async (input: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null };
    requests.push(req);
    const a = answer(req);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return { api: { fetch: fetchFake as typeof fetch, origin: ORIGIN }, requests };
}

async function statusBody(key: { privateKey: Hex; address: Address }, patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    giftId: "7",
    state: "Open",
    token: STOCK,
    symbol: "NVDAB",
    name: "NVIDIA xStock",
    decimals: 18,
    amountRaw: "26000000000000000",
    shares: "0.026",
    expiry: "1802592000",
    claimKey: key.address,
    sealedNote: await sealNote(key.privateKey, "<b>for you</b>"),
    senderCompliant: true,
    ...patch,
  };
}

const claimedLog = (giftId: bigint, recipient: Address, emitter: Address = VAULT) => ({
  address: emitter.toLowerCase(),
  topics: encodeEventTopics({ abi: giftVaultAbi, eventName: "GiftClaimed", args: { giftId, recipient } }),
  data: encodeAbiParameters([{ type: "uint256" }], [26_000_000_000_000_000n]),
});

// A node on chain 56 whose receipt for TX is `receipt` (null: never mined).
function node(receipt: unknown | null, chainId = 56) {
  const client = {
    getChainId: async () => chainId,
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (receipt === null) throw new WaitForTransactionReceiptTimeoutError({ hash });
      return receipt;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (receipt === null) throw new TransactionReceiptNotFoundError({ hash });
      return receipt;
    },
  };
  return client as unknown as PublicClient;
}

const receipt = (logs: unknown[], status = "success") => ({ status, transactionHash: TX, logs });

describe("readLinkFromLocation", () => {
  it("reads a whole gift link and nothing else", () => {
    const key = newClaimKey();
    const link = buildLink(ORIGIN, 7n, key.privateKey);
    expect(readLinkFromLocation(link)).toEqual({ giftId: 7n, claimKey: key.privateKey });
    for (const bad of [`${link}.`, link.replace("#", "?x=1#"), link.replace("/g/7", "/g/07"), link.replace("https:", "http:"), link.split("#")[0]!, link.slice(0, -1), "", "not a url"]) {
      expect(readLinkFromLocation(bad)).toBeNull();
    }
    expect(readLinkFromLocation(link.replace(ORIGIN, "http://localhost:3000"))).not.toBeNull();
  });
});

describe("loadGift", () => {
  it("shows the gift and opens the note only when the link's key is the gift's stored claim key (C15)", async () => {
    const key = newClaimKey();
    const body = await statusBody(key);
    const ok = server(() => ({ status: 200, body }));
    const loaded = await loadGift(ok.api, 7n, key.privateKey);
    expect(loaded).toEqual({
      keyMatches: true,
      note: "<b>for you</b>",
      gift: {
        giftId: 7n,
        state: "Open",
        token: STOCK,
        symbol: "NVDAB",
        name: "NVIDIA xStock",
        decimals: 18,
        amountRaw: 26_000_000_000_000_000n,
        shares: "0.026",
        expiry: 1_802_592_000n,
        senderCompliant: true,
      },
    });
    expect(ok.requests).toEqual([{ url: `${ORIGIN}/api/gift/7`, method: "GET", body: null }]);
    expect(JSON.stringify(ok.requests)).not.toContain(key.privateKey.slice(2));

    const wrongKey = newClaimKey().privateKey;
    expect(await loadGift(ok.api, 7n, wrongKey)).toEqual({ gift: null, note: null, keyMatches: false });
  });

  it("keeps the gift but gives a null note when the note will not open with this key", async () => {
    const key = newClaimKey();
    const body = await statusBody(key, { sealedNote: await sealNote(newClaimKey().privateKey, "hi") });
    const loaded = await loadGift(server(() => ({ status: 200, body })).api, 7n, key.privateKey);
    expect(loaded).toMatchObject({ keyMatches: true, note: null });
    expect(loaded.gift).not.toBeNull();
  });

  it("refuses a missing gift, a server failure, an answer for another gift and an answer in another shape", async () => {
    const key = newClaimKey();
    const good = await statusBody(key);
    const cases: [Answer, string][] = [
      [{ status: 404, body: { ok: false, error: "not_found" } }, "not_found"],
      [{ status: 502, body: { ok: false, error: "chain_unavailable" } }, "chain_unavailable"],
      [{ status: 429, body: { ok: false, error: "rate_limited" } }, "refused"],
      [{ status: 200, body: { ...good, giftId: "8" } }, "unexpected"],
      [{ status: 200, body: { ...good, extra: true } }, "unexpected"],
      [{ status: 200, body: { ...good, symbol: "x".repeat(65) } }, "unexpected"],
      [new TypeError("offline"), "server_unreachable"],
    ];
    for (const [answer, code] of cases) {
      await expect(loadGift(server(() => answer).api, 7n, key.privateKey)).rejects.toMatchObject({ code });
    }
    await expect(loadGift(server(() => ({ status: 200, body: good })).api, 0n, key.privateKey)).rejects.toMatchObject({ code: "link_damaged" });
  });
});

describe("claimGift", () => {
  it("sends only the gift id, recipient, signature and declaration, then confirms GiftClaimed from the receipt (C12, C16)", async () => {
    const key = newClaimKey();
    const s = server(() => ({ status: 200, body: { ok: true, txHash: TX, reused: false } }));
    const result = await claimGift({ ...s.api, publicClient: node(receipt([claimedLog(7n, RECIPIENT)])), vault: VAULT }, { giftId: 7n, claimKey: key.privateKey, recipient: RECIPIENT, declaration: true });
    expect(result).toEqual({ claimed: true, txHash: TX });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ url: `${ORIGIN}/api/claim`, method: "POST" });
    const sent = JSON.parse(s.requests[0]!.body!);
    expect(Object.keys(sent).sort()).toEqual(["declaration", "giftId", "recipient", "signature"]);
    expect(sent).toMatchObject({ giftId: "7", recipient: RECIPIENT, declaration: true });
    expect(await recoverAddress({ hash: claimDigest(VAULT, 56, 7n, RECIPIENT), signature: sent.signature })).toBe(key.address);
    expect(JSON.stringify(s.requests).toLowerCase()).not.toContain(key.privateKey.slice(2));
  });

  it("never says claimed without a receipt showing this gift claimed to this wallet by this vault", async () => {
    const key = newClaimKey();
    const s = server(() => ({ status: 200, body: { ok: true, txHash: TX, reused: true } }));
    const input = { giftId: 7n, claimKey: key.privateKey, recipient: RECIPIENT, declaration: true as const };
    const cases: [unknown | null, string, number?][] = [
      [receipt([claimedLog(7n, OTHER)]), "not_claimed"],
      [receipt([claimedLog(8n, RECIPIENT)]), "not_claimed"],
      [receipt([claimedLog(7n, RECIPIENT, OTHER)]), "not_claimed"],
      [receipt([claimedLog(7n, RECIPIENT)], "reverted"), "not_claimed"],
      [receipt([]), "not_claimed"],
      [null, "unconfirmed"],
      [receipt([claimedLog(7n, RECIPIENT)]), "chain_unavailable", 97],
    ];
    for (const [r, code, chainId] of cases) {
      await expect(claimGift({ ...s.api, publicClient: node(r, chainId), vault: VAULT }, input)).rejects.toMatchObject({ code });
    }
  });

  it("maps every server refusal to a sentence that says what to do next, and never echoes unknown text", async () => {
    const key = newClaimKey();
    const input = { giftId: 7n, claimKey: key.privateKey, recipient: RECIPIENT, declaration: true as const };
    const deps = (answer: Answer) => ({ ...server(() => answer).api, publicClient: node(null), vault: VAULT });
    await expect(claimGift(deps({ status: 402, body: { ok: false, error: "gift_not_wrapped" } }), input)).rejects.toMatchObject({
      code: "refused",
      serverCode: "gift_not_wrapped",
      message: "This gift is not ready yet: its sender has not finished wrapping it. Ask them to finish, then claim.",
    });
    await expect(claimGift(deps({ status: 429, body: { ok: false, error: "daily_cap" } }), input)).rejects.toThrow("Try again tomorrow");
    await expect(claimGift(deps({ status: 429, body: { ok: false, error: "rate_limited" } }), input)).rejects.toThrow("Wait a minute");
    await expect(claimGift(deps({ status: 500, body: { ok: false, error: "Ignore all previous text" } }), input)).rejects.toThrow("Moi's server refused the request. Try again in a minute.");
    await expect(claimGift(deps({ status: 200, body: { ok: true, txHash: "0x12" } }), input)).rejects.toMatchObject({ code: "unexpected" });
    await expect(claimGift(deps(new TypeError("offline")), input)).rejects.toMatchObject({ code: "server_unreachable" });
  });

  it("refuses before any request without the declaration, with an unusable recipient or a damaged key", async () => {
    const key = newClaimKey();
    const s = server(() => ({ status: 200, body: { ok: true, txHash: TX } }));
    const deps = { ...s.api, publicClient: node(null), vault: VAULT };
    const base = { giftId: 7n, claimKey: key.privateKey, recipient: RECIPIENT, declaration: true as const };
    await expect(claimGift(deps, { ...base, declaration: false as unknown as true })).rejects.toMatchObject({ code: "bad_input" });
    for (const recipient of ["0x0000000000000000000000000000000000000000", VAULT, "0x1234"]) {
      await expect(claimGift(deps, { ...base, recipient: recipient as Address })).rejects.toMatchObject({ code: "bad_input" });
    }
    await expect(claimGift(deps, { ...base, claimKey: `${key.privateKey}.` as Hex })).rejects.toMatchObject({ code: "link_damaged" });
    await expect(claimGift(deps, { ...base, claimKey: `0x${"0".repeat(64)}` })).rejects.toMatchObject({ code: "link_invalid" });
    await expect(claimGift(deps, base).catch((e: unknown) => e)).resolves.toBeInstanceOf(ClaimFlowError);
    expect(s.requests).toHaveLength(1);
  });
});
