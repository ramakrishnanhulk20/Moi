// Not covered here: Privy itself (the server's token check is a fake that knows one judge's token),
// a real wallet, node or relayer, and the HTTP route's body cap and rate limits (server.test.ts).
// The server is the real judge.ts handler, so the page's message and proof meet its real checks.
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { claimJudgeGift } from "../src/client/judge.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { judgeWalletMessage as movedMessage } from "../src/judge-message.js";
import { deriveJudgeKey, handleJudgeClaim, judgeWalletMessage as serverMessage } from "../src/judge.js";
import { PrivyTokenError, type verifyPrivyAccessToken } from "../src/privy.js";
import type { createRelayer } from "../src/relayer.js";
import { createMemoryStore } from "../src/store.js";

const ORIGIN = "https://moi.example";
const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const STOCK = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const OTHER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const SEED = `0x${"5a".repeat(32)}` as const;
const HASH_KEY = `0x${"7c".repeat(32)}` as const;
const CODE = "MOI-7K4P-QX9M";
const NOW_S = 1_800_000_000n;
const NOW_MS = Number(NOW_S) * 1000;
const GIFT_ID = 5n;
const USER = "did:privy:judge0";

// Captured from judge.ts before judgeWalletMessage moved to judge-message.ts.
const BEFORE_THE_MOVE: [Parameters<typeof movedMessage>[0], string][] = [
  [
    { recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", userId: "did:privy:cm1abc2def3", issuedAt: "2026-10-08T12:00:00Z" },
    "Moi judge gift\nWallet: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8\nPrivy user: did:privy:cm1abc2def3\nIssued at: 2026-10-08T12:00:00Z",
  ],
  [
    { recipient: "0x96E854aBDdc5C618ca843956d1303017b586aB75", userId: "did:privy:ZZ09", issuedAt: "2028-02-29T23:59:59Z" },
    "Moi judge gift\nWallet: 0x96E854aBDdc5C618ca843956d1303017b586aB75\nPrivy user: did:privy:ZZ09\nIssued at: 2028-02-29T23:59:59Z",
  ],
  [
    { recipient: "0x02FCA66C1D1AFB4E2A7884261EB00F63598A7436", userId: "x!~", issuedAt: "2000-01-01T00:00:00Z" },
    "Moi judge gift\nWallet: 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436\nPrivy user: x!~\nIssued at: 2000-01-01T00:00:00Z",
  ],
];

const base64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const accessToken = (payload: unknown) => `${base64url({ alg: "ES256", typ: "JWT" })}.${base64url(payload)}.c2ln`;
const TOKEN = accessToken({ sub: USER, sid: "session-1" });

const claimedLog = (giftId: bigint, recipient: Address) => ({
  address: VAULT.toLowerCase(),
  topics: encodeEventTopics({ abi: giftVaultAbi, eventName: "GiftClaimed", args: { giftId, recipient } }),
  data: encodeAbiParameters([{ type: "uint256" }], [1n]),
});

// One judge pool gift (GIFT_ID, index 0), the real judge handler behind /api/judge, a relayer whose
// claims land with `landsTo` as the GiftClaimed recipient (the requested one by default), and a
// node that serves those receipts.
async function judgeWorld(opts: { landsTo?: Address; mined?: boolean; serverNowMs?: number } = {}) {
  const claimKey = privateKeyToAccount(await deriveJudgeKey(SEED, 0)).address;
  const receipts = new Map<string, unknown>();
  const submitted: { giftId: bigint; recipient: Address }[] = [];
  const client = {
    getChainId: async () => 56,
    getBlock: async () => ({ timestamp: NOW_S }),
    getCode: async () => undefined,
    readContract: async ({ functionName, args }: { functionName: string; args: [bigint] }) => {
      if (functionName !== "getGift" || args[0] !== GIFT_ID) throw new Error("unexpected read");
      return { token: STOCK, sender: OTHER, claimKey, expiry: NOW_S + 86_400n, state: 1, amount: 1n, sealedNote: "0x" };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!receipts.has(hash)) throw new TransactionReceiptNotFoundError({ hash });
      return receipts.get(hash);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!receipts.has(hash)) throw new WaitForTransactionReceiptTimeoutError({ hash });
      return receipts.get(hash);
    },
  } as unknown as PublicClient;
  const relayer = {
    submitClaim: async (input: { giftId: bigint; recipient: Address }) => {
      submitted.push(input);
      const txHash = `0x${submitted.length.toString(16).padStart(64, "0")}` as Hex;
      if (opts.mined !== false) receipts.set(txHash, { status: "success", transactionHash: txHash, logs: [claimedLog(input.giftId, opts.landsTo ?? input.recipient)] });
      return { txHash, reused: false };
    },
  } as unknown as ReturnType<typeof createRelayer>;
  const verifyAccessToken = (async (token: string) => {
    if (token !== TOKEN) throw new PrivyTokenError("invalid");
    return { userId: USER };
  }) as typeof verifyPrivyAccessToken;
  const serverDeps = {
    client,
    vault: VAULT,
    relayer,
    store: createMemoryStore(() => NOW_MS),
    judgeSeed: SEED,
    pool: new Map([[GIFT_ID, 0]]),
    judgeCode: CODE,
    privyAppId: "cmuy05pes00wz0ckz26av3gig",
    clientHashKey: HASH_KEY,
    verifyAccessToken,
    now: () => new Date(opts.serverNowMs ?? NOW_MS),
  };
  const bodies: Record<string, unknown>[] = [];
  const fetchFake = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== `${ORIGIN}/api/judge` || init?.method !== "POST") throw new Error("unexpected request");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    const res = await handleJudgeClaim(serverDeps, body, { country: "IN", region: null, clientIp: "203.0.113.7" });
    return new Response(JSON.stringify(res.body), { status: res.status });
  };
  const deps = { fetch: fetchFake as typeof fetch, origin: ORIGIN, publicClient: client, vault: VAULT };
  return { deps, bodies, submitted };
}

function judge(overrides: Partial<Parameters<typeof claimJudgeGift>[1]> = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    account,
    input: {
      judgeCode: " moi-7k4p-qx9m ",
      accessToken: TOKEN,
      recipient: account.address,
      signMessage: (message: string) => account.signMessage({ message }),
      declaration: true as const,
      now: () => NOW_MS - 30_000,
      ...overrides,
    },
  };
}

describe("judge-message.ts", () => {
  it("holds the very judgeWalletMessage judge.ts exports, returning exactly the text it returned before the move", () => {
    expect(serverMessage).toBe(movedMessage);
    for (const [args, text] of BEFORE_THE_MOVE) {
      expect(movedMessage(args)).toBe(text);
      expect(serverMessage(args)).toBe(text);
    }
    const good = BEFORE_THE_MOVE[0]![0];
    for (const bad of [{ issuedAt: "2026-02-30T00:00:00Z" }, { issuedAt: "2026-10-08T12:00:00.000Z" }, { userId: "did privy" }, { userId: "" }]) {
      expect(() => movedMessage({ ...good, ...bad })).toThrow(RangeError);
    }
    expect(() => movedMessage({ ...good, recipient: "0x1234" })).toThrow();
  });
});

describe("claimJudgeGift", () => {
  it("claims a pool gift through the real judge handler and says claimed only from the receipt", async () => {
    const w = await judgeWorld();
    const j = judge();
    const result = await claimJudgeGift(w.deps, j.input);
    expect(result).toEqual({ claimed: true, giftId: GIFT_ID, txHash: `0x${"1".padStart(64, "0")}` });
    expect(w.submitted).toMatchObject([{ giftId: GIFT_ID, recipient: j.account.address }]);
    expect(Object.keys(w.bodies[0]!).sort()).toEqual(["accessToken", "declaration", "issuedAt", "judgeCode", "recipient", "walletProof"]);
    expect(w.bodies[0]).toMatchObject({ issuedAt: "2027-01-15T07:59:30Z", recipient: j.account.address, declaration: true });
  });

  it("says a wrong judge code in the order's exact words, and maps the server's other refusals", async () => {
    const w = await judgeWorld();
    await expect(claimJudgeGift(w.deps, judge({ judgeCode: "MOI-AAAA-BBBB" }).input)).rejects.toMatchObject({
      code: "refused",
      serverCode: "bad_judge_code",
      message: "That judge code is not right. It is in the submission's instructions for judges.",
    });
    const first = judge();
    await claimJudgeGift(w.deps, first.input);
    await expect(claimJudgeGift(w.deps, first.input)).rejects.toMatchObject({ serverCode: "already_claimed", message: "You have already claimed a judge gift. Each judge gets one." });

    const fast = await judgeWorld();
    await expect(claimJudgeGift(fast.deps, judge({ now: () => NOW_MS + 10 * 60_000 }).input)).rejects.toMatchObject({ serverCode: "proof_expired" });
    const stranger = await judgeWorld();
    await expect(claimJudgeGift(stranger.deps, judge({ accessToken: accessToken({ sub: "did:privy:someoneelse" }) }).input)).rejects.toMatchObject({
      serverCode: "bad_token",
    });
  });

  it("refuses before any request without the declaration, a readable sign-in, the right wallet's proof or the judge's consent", async () => {
    const w = await judgeWorld();
    const other = privateKeyToAccount(generatePrivateKey());
    const cases: [Partial<Parameters<typeof claimJudgeGift>[1]>, string, string][] = [
      [{ declaration: false as unknown as true }, "bad_input", "Confirm that you are not a US person"],
      [{ accessToken: "not.a-token" }, "bad_input", "Sign out, sign in again"],
      [{ accessToken: accessToken({ sub: "someone" }) }, "bad_input", "Sign out, sign in again"],
      [{ judgeCode: "" }, "bad_input", "That judge code is not right"],
      [{ recipient: "0x0000000000000000000000000000000000000000" }, "bad_input", "That wallet cannot receive"],
      [{ signMessage: (message: string) => other.signMessage({ message }) }, "bad_input", "did not come from the wallet you named"],
      [{ signMessage: async () => "0x1234" as Hex }, "bad_input", "could not be read"],
      [{ signMessage: async () => Promise.reject(Object.assign(new Error("rejected"), { code: 4001 })) }, "declined", "You declined"],
    ];
    for (const [override, code, text] of cases) {
      const err = await claimJudgeGift(w.deps, judge(override).input).catch((e: unknown) => e);
      expect(err).toMatchObject({ code });
      expect((err as Error).message).toContain(text);
    }
    expect(w.bodies).toHaveLength(0);
  });

  it("never says claimed when the receipt shows another recipient or no receipt arrives", async () => {
    const elsewhere = await judgeWorld({ landsTo: OTHER });
    await expect(claimJudgeGift(elsewhere.deps, judge().input)).rejects.toMatchObject({ code: "not_claimed" });
    const unmined = await judgeWorld({ mined: false });
    await expect(claimJudgeGift(unmined.deps, judge().input)).rejects.toMatchObject({ code: "unconfirmed" });
  });
});
