// Not covered here: the live Binance wallet, the real vault and the real Moi server (the live run
// needs Ram's phone and the deployed vault), Binance's own swap pricing, and Permit2 approval
// timing on chain. The chain, baw and the server are fakes with reply shapes taken from the
// skill's reference files and from WO-4d's 402 contract.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { USDT } from "@moi/core/src/chain.js";
import { buildApproveVaultTx, buildCreateGiftTx, defaultExpiry } from "@moi/core/src/create.js";
import { giftVaultAbi } from "@moi/core/src/generated/giftVaultAbi.js";
import { claimKeyMatches, parseLink, signKeyProof } from "@moi/core/src/gift.js";
import { WRAP_ASSETS } from "@moi/core/src/wrap.js";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GiftCancelled, GiftError, GiftNotWrapped, sendGift, type GiftDeps } from "../src/gift.js";
import { unwrappedMarker } from "../src/linkfile.js";
import { resolvePendingGifts } from "../src/pending.js";
import { wrapSavedGift } from "../src/wrap.js";
import type { Pinned } from "../src/pinned.js";
import { ADDRESSES, fakeBaw, leftQuota, settings, STATUS_CONNECTED, WALLET } from "./fakes.js";

const captured = vi.hoisted(() => ({}) as { key?: { privateKey: `0x${string}`; address: `0x${string}` }; sealed?: `0x${string}` });

vi.mock("@moi/core/src/gift.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@moi/core/src/gift.js")>();
  return {
    ...real,
    newClaimKey: () => {
      const key = real.newClaimKey();
      captured.key = key;
      return key;
    },
    sealNote: async (key: `0x${string}`, note: string) => {
      const sealed = await real.sealNote(key, note);
      captured.sealed = sealed;
      return sealed;
    },
  };
});

const VAULT = getAddress("0x1111111111111111111111111111111111111111");
const NVDAB = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const TSLAB = getAddress("0x3333333333333333333333333333333333333333");
const PAYOUT = getAddress("0x96E854aBDdc5C618ca843956d1303017b586aB75");
const OWNER = getAddress(WALLET);
const NOW = 1_800_000_000n;
const GIFT_ID = 7n;
const BOUGHT = 27_100_000_000_000_000n;
const FEE = 50_000_000_000_000_000n;
const SWAP_HASH = `0x${"5a".repeat(32)}` as Hex;
const APPROVE_HASH = `0x${"a1".repeat(32)}` as Hex;
const CREATE_HASH = `0x${"c2".repeat(32)}` as Hex;
const WRAP_HASH = `0x${"e3".repeat(32)}` as Hex;
const ORIGIN = "https://moi.example";

const pinned: Pinned = {
  chainId: 56,
  vault: VAULT,
  usdt: getAddress(USDT),
  payTo: PAYOUT,
  wrapFeeCeilingUsd: "0.10",
  serverOrigin: ORIGIN,
  linkOrigin: ORIGIN,
};

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";

type Accept = { scheme: string; network: string; asset: string; amount: string; payTo: string; extra: Record<string, string> };

function requirements(change: (accepts: Accept[]) => void = () => {}) {
  const accepts: Accept[] = WRAP_ASSETS.map((a) => ({
    scheme: "exact",
    network: "eip155:56",
    asset: a.address,
    amount: FEE.toString(),
    payTo: PAYOUT,
    extra: { name: a.name, version: "1" },
  }));
  change(accepts);
  return { x402Version: 2, resource: { url: `${ORIGIN}/api/wrap/${GIFT_ID}` }, accepts };
}

/** baw with every command the gift flow uses; x402 options list Permit2 tokens first on purpose. */
function wallet(events: string[], replies: Record<string, unknown> = {}) {
  const previews = new Map<string, string>();
  const fake = fakeBaw({
    "wallet status": STATUS_CONNECTED,
    "wallet address": ADDRESSES,
    "wallet settings": settings(),
    "wallet left-quota": leftQuota(),
    "market-order quote": { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "NVDAB", toCoinAmount: "0.0271", slippage: 0.005 },
    "market-order swap": { orderId: "1234567890" },
    "market-order list": {
      total: 1,
      page: 1,
      pageSize: 20,
      list: [{ orderType: "market", orderId: "1234567890", chain: "56", fromToken: USDT, toToken: NVDAB, status: "FINISHED", txHash: SWAP_HASH }],
    },
    "contract-call preview": (args: string[]) => {
      const requestId = `req-${previews.size + 1}`;
      previews.set(requestId, flag(args, "--to"));
      return {
        requestId,
        parsedTx: { transactionType: "ContractCall", contractAddress: flag(args, "--to") },
        simulationResult: { simulationCode: "000000000", simulationErrorDetail: null, balanceChanges: [], allowanceChanges: [], authorityChanges: [], preCheckCode: "" },
        risks: { riskDetails: [], addresses: {}, riskBehaviors: [] },
        tokenInfos: {},
        requireConfirmation: false,
        expiresAt: 1_800_000_600_000,
      };
    },
    "contract-call execute": (args: string[]) => {
      const to = previews.get(flag(args, "--requestId"));
      return { orderId: "order-1", status: "BROADCASTED", txHash: to === NVDAB.toLowerCase() ? APPROVE_HASH : CREATE_HASH, message: null };
    },
    "x402-payment preview": (args: string[]) => {
      const required = JSON.parse(Buffer.from(flag(args, "--paymentRequirements"), "base64").toString("utf8")) as ReturnType<typeof requirements>;
      const options = required.accepts
        .map((accept) => {
          const asset = WRAP_ASSETS.find((a) => a.address === getAddress(accept.asset));
          const eip3009 = asset?.symbol === "U" || asset?.symbol === "USD1";
          return {
            status: "READY_TO_SIGN",
            reasons: [],
            scheme: "exact",
            assetTransferMethod: eip3009 ? "eip3009" : "permit2",
            binanceChainId: "56",
            tokenAddress: accept.asset,
            tokenSymbol: asset?.symbol,
            amount: "0.05",
            amountUsd: "0.05",
            payTo: accept.payTo,
            userWalletAddress: WALLET,
            currentBalance: "10",
            currentBalanceUsd: "10.00",
            needApproveFirst: !eip3009,
            originalAccept: accept,
          };
        })
        .sort((a, b) => Number(a.assetTransferMethod === "eip3009") - Number(b.assetTransferMethod === "eip3009"))
        .map((option, i) => ({ index: i + 1, ...option }));
      return { paymentId: "550e8400-e29b-41d4-a716-446655440000", options };
    },
    "x402-payment sign": { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: "eyJ4NDAyVmVyc2lvbiI6Mn0=", approveTxHash: null, binanceChainId: null, signatureExpiresAt: 1_800_000_600 },
    ...replies,
  });
  const runner: typeof fake.runner = async (args) => {
    events.push(`baw ${args[0]} ${args[1]}`);
    return fake.runner(args);
  };
  return { runner, calls: fake.calls };
}

type ChainOpts = { balances?: bigint[]; createFails?: () => never; giftState?: number; uiMultiplier?: bigint; claimKeyUsed?: boolean };

function chain(opts: ChainOpts = {}): PublicClient {
  const balances = opts.balances ?? [0n, BOUGHT];
  let reads = 0;
  const createdLog = {
    address: VAULT,
    topics: encodeEventTopics({ abi: giftVaultAbi, eventName: "GiftCreated", args: { giftId: GIFT_ID, token: NVDAB, sender: OWNER } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [TSLAB, BOUGHT, NOW]),
  };
  const receipts: Record<string, unknown> = {
    [APPROVE_HASH]: { status: "success", from: OWNER.toLowerCase(), to: NVDAB.toLowerCase(), logs: [] },
    [CREATE_HASH]: { status: "success", from: OWNER.toLowerCase(), to: VAULT.toLowerCase(), logs: [createdLog] },
  };
  const symbols: Record<string, string> = { [NVDAB]: "NVDAB", [TSLAB]: "TSLAB", [getAddress(USDT)]: "USDT" };
  return {
    getChainId: async () => 56,
    getBlock: async () => ({ timestamp: NOW }),
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "claimKeyUsed") return opts.claimKeyUsed ?? false;
      if (functionName === "nextGiftId") return GIFT_ID + 1n;
      if (functionName === "listedTokens") return [NVDAB, TSLAB];
      if (functionName === "symbol") return symbols[getAddress(address)];
      if (functionName === "decimals") return 18;
      if (functionName === "uiMultiplier") {
        if (opts.uiMultiplier === undefined || address !== NVDAB) throw new Error("not a scaled token");
        return opts.uiMultiplier;
      }
      if (functionName === "balanceOf") return balances[Math.min(reads++, balances.length - 1)];
      if (functionName === "getGift") {
        const claimKey = args?.[0] === GIFT_ID && captured.key !== undefined ? captured.key.address : TSLAB;
        return { token: NVDAB, sender: OWNER, claimKey, expiry: NOW + 86_400n, state: opts.giftState ?? 1, amount: BOUGHT, sealedNote: "0x" };
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash === CREATE_HASH && opts.createFails) opts.createFails();
      const receipt = receipts[hash];
      if (receipt === undefined) throw new Error("unknown transaction");
      return receipt;
    },
  } as unknown as PublicClient;
}

const WRAPPED = () => new Response(JSON.stringify({ ok: true, wrapped: true, txHash: WRAP_HASH }), { status: 200 });
const SETTLING = (seconds: number) => () =>
  new Response(JSON.stringify({ ok: false, error: "settlement_pending", retryAfterSeconds: seconds }), {
    status: 202,
    headers: { "Retry-After": String(seconds) },
  });

/** The Moi server: 402 for a request without payment; each paid request takes the next reply in `paid` (200 once they run out). */
function server(events: string[], required: unknown = requirements(), paid: (() => Response)[] = []) {
  const payments: (string | null)[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    events.push("fetch");
    const payment = new Headers(init?.headers).get("payment-signature");
    payments.push(payment);
    if (payment === null) {
      const encoded = Buffer.from(JSON.stringify(required), "utf8").toString("base64");
      return new Response(JSON.stringify(required), { status: 402, headers: { "PAYMENT-REQUIRED": encoded } });
    }
    return (paid.shift() ?? WRAPPED)();
  }) as typeof fetch;
  return { fetchImpl, payments };
}

type SetupOpts = ChainOpts & {
  replies?: Record<string, unknown>;
  required?: unknown;
  paid?: (() => Response)[];
  confirms?: boolean[];
  linkDir?: string;
};

function setup(opts: SetupOpts = {}) {
  const events: string[] = [];
  const baw = wallet(events, opts.replies);
  const srv = server(events, opts.required, opts.paid);
  const lines: string[] = [];
  const questions: string[] = [];
  const answers = [...(opts.confirms ?? [])];
  const deps: GiftDeps = {
    baw: baw.runner,
    client: chain(opts),
    pinned,
    fetchImpl: srv.fetchImpl,
    linkDir: opts.linkDir ?? path.join(mkdtempSync(path.join(tmpdir(), "moi-agent-")), "gifts"),
    confirm: async (summary) => {
      questions.push(summary);
      return answers.length === 0 ? true : (answers.shift() as boolean);
    },
    log: (line) => lines.push(line),
  };
  return { deps, calls: baw.calls, events, payments: srv.payments, lines, questions };
}

const INPUT = { ticker: "NVDA", usd: "5", note: "Happy Diwali" };

/**
 * Steps the fake clock a second at a time until `work` settles. Real file writes happen between
 * sleeps, so the clock can only move after each real I/O turn, which setImmediate (left real) gives.
 */
async function untilSettled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.then(
    () => (done = true),
    () => (done = true),
  );
  for (let step = 0; !done && step < 1_000; step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return work;
}
const commands = (calls: string[][]) => calls.map((c) => `${c[0]} ${c[1]}`);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete captured.key;
  delete captured.sealed;
});

describe("sendGift", () => {
  it("buys, locks, wraps and saves the link, with every argv an array of lowercase addresses", async () => {
    const t = setup();
    const result = await sendGift(t.deps, INPUT);

    expect(result.giftId).toBe(GIFT_ID);
    expect(result.txs).toEqual([SWAP_HASH, APPROVE_HASH, CREATE_HASH, WRAP_HASH]);
    expect(t.lines.at(-1)).toBe(`Gift 7 is ready. The link is saved in ${result.linkFile}. Send it to your friend.`);
    expect(path.basename(result.linkFile)).toBe("gift-7.txt");
    const saved = readFileSync(result.linkFile, "utf8");
    expect(saved.split("\n")).toHaveLength(2);
    const link = parseLink(saved.trim());
    expect(link.origin).toBe(ORIGIN);
    expect(link.giftId).toBe(GIFT_ID);
    expect(claimKeyMatches(link.claimKey, captured.key!.address)).toBe(true);

    expect(commands(t.calls)).toEqual([
      "wallet status",
      "wallet address",
      "wallet settings",
      "wallet left-quota",
      "market-order quote",
      "market-order swap",
      "market-order list",
      "contract-call preview",
      "contract-call execute",
      "contract-call preview",
      "contract-call execute",
      "x402-payment preview",
      "x402-payment sign",
    ]);
    for (const argv of t.calls) {
      expect(Array.isArray(argv)).toBe(true);
      for (const arg of argv) {
        expect(typeof arg).toBe("string");
        if (arg.startsWith("0x")) expect(arg).toBe(arg.toLowerCase());
      }
      for (const name of ["--from", "--to", "--fromToken", "--toToken"]) {
        if (argv.includes(name)) expect(flag(argv, name)).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
    expect(flag(t.calls[4]!, "--fromToken")).toBe(USDT.toLowerCase());
    expect(flag(t.calls[4]!, "--toToken")).toBe(NVDAB.toLowerCase());
    expect(flag(t.calls[4]!, "--binanceChainId")).toBe("56");
    expect(t.payments).toEqual([null, "eyJ4NDAyVmVyc2lvbiI6Mn0="]);
  });

  it("refuses an unknown ticker before any baw call", async () => {
    const t = setup();
    await expect(sendGift(t.deps, { ...INPUT, ticker: "AAPL" })).rejects.toThrow(/AAPL is not a stock Moi can gift/);
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it("passes contract-call exactly the approve and createGift calldata create.ts builds, before the server is ever asked", async () => {
    const t = setup();
    await sendGift(t.deps, INPUT);
    const previews = t.calls.filter((c) => c[0] === "contract-call" && c[1] === "preview");
    const key = captured.key!;
    const approve = buildApproveVaultTx({ token: NVDAB, amount: BOUGHT, vault: VAULT });
    const create = buildCreateGiftTx({
      vault: VAULT,
      token: NVDAB,
      amount: BOUGHT,
      claimKeyAddress: key.address,
      expiry: defaultExpiry(NOW),
      sealedNote: captured.sealed!,
      keyProof: await signKeyProof(key.privateKey, VAULT, 56, OWNER),
      nowSeconds: NOW,
    });
    expect(previews.map((c) => [flag(c, "--to"), flag(c, "--inputData")])).toEqual([
      [approve.to.toLowerCase(), approve.data],
      [create.to.toLowerCase(), create.data],
    ]);
    expect(t.events.indexOf("fetch")).toBeGreaterThan(t.events.lastIndexOf("baw contract-call execute"));
  });

  it.each<[string, (accepts: Accept[]) => void]>([
    ["another payee", (a) => (a[0]!.payTo = "0x4444444444444444444444444444444444444444")],
    ["a higher amount", (a) => (a[1]!.amount = "110000000000000000")],
    ["another network", (a) => (a[2]!.network = "eip155:1")],
    ["an unknown asset", (a) => (a[3]!.asset = "0x5555555555555555555555555555555555555555")],
  ])("refuses a 402 that asks for %s and never calls x402-payment", async (_label, change) => {
    const t = setup({ required: requirements(change) });
    const err = await sendGift(t.deps, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GiftError);
    expect(err).toBeInstanceOf(GiftNotWrapped);
    expect((err as Error).message).toMatch(/Gift 7 exists in the vault and its link is saved in .*gift-7\.txt, but it is not wrapped yet.*npm run moi -- wrap 7.*nothing was paid/);
    expect(readFileSync((err as GiftNotWrapped).linkFile, "utf8").split("\n")[0]).toBe(unwrappedMarker(GIFT_ID));
    expect(t.calls.some((c) => c[0] === "x402-payment")).toBe(false);
    expect(t.payments).toEqual([null]);
  });

  it("keeps the key in a 'not wrapped yet' link file when wrapping fails, and moi wrap finishes it and clears that line", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const failing = setup({ paid: [() => new Response("{}", { status: 500 })] });
    const err = await sendGift(failing.deps, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GiftNotWrapped);
    const { linkFile } = err as GiftNotWrapped;
    const key = captured.key!;
    const [marker, linkLine] = readFileSync(linkFile, "utf8").split("\n");
    expect(marker).toBe("# not wrapped yet: run `npm run moi -- wrap 7`");
    expect(claimKeyMatches(parseLink(linkLine!).claimKey, key.address)).toBe(true);

    const later = setup({ linkDir: failing.deps.linkDir });
    const wrapped = await wrapSavedGift(later.deps, "7");
    expect(wrapped).toEqual({ giftId: GIFT_ID, linkFile, wrapTx: WRAP_HASH });
    expect(readFileSync(linkFile, "utf8")).toBe(`${linkLine}\n`);
    expect(commands(later.calls)).toEqual(["x402-payment preview", "x402-payment sign"]);
    expect(later.lines.at(-1)).toBe(`Gift 7 is wrapped. The link is saved in ${linkFile}. Send it to your friend.`);

    const seen = [...failing.lines, ...failing.questions, (err as Error).message, ...later.lines, ...later.questions, ...stdout.mock.calls.map((c) => String(c[0]))]
      .join("\n")
      .toLowerCase();
    expect(seen).not.toContain(key.privateKey.slice(2).toLowerCase());
  });

  it("waits through 202 settlement_pending by replaying the same signed header, and signs only once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = setup({ paid: [SETTLING(3), SETTLING(3)] });
    const result = await untilSettled(sendGift(t.deps, INPUT));
    expect(result.txs.at(-1)).toBe(WRAP_HASH);
    expect(t.calls.filter((c) => c[0] === "x402-payment" && c[1] === "sign")).toHaveLength(1);
    expect(t.payments).toEqual([null, "eyJ4NDAyVmVyc2lvbiI6Mn0=", "eyJ4NDAyVmVyc2lvbiI6Mn0=", "eyJ4NDAyVmVyc2lvbiI6Mn0="]);
    expect(t.lines).toContain("Binance is still settling the wrapping fee. Moi will keep checking for up to 3 minutes.");
    expect(readFileSync(result.linkFile, "utf8").startsWith("#")).toBe(false);
  });

  it("stops after 3 minutes of settlement_pending, says the payment is settling and how to finish it, and never signs again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = setup({ paid: Array.from({ length: 100 }, () => SETTLING(100)) });
    const err = await untilSettled(sendGift(t.deps, INPUT).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(GiftNotWrapped);
    expect((err as Error).message).toMatch(/was sent and is still settling at Binance\. Run `npm run moi -- wrap 7` in a few minutes to finish it; that will not pay twice/);
    expect(t.calls.filter((c) => c[0] === "x402-payment" && c[1] === "sign")).toHaveLength(1);
    // A 100 s wait is held to 15 s, so 3 minutes allow the first paid request plus 12 replays.
    expect(t.payments.filter((p) => p !== null)).toHaveLength(13);
    expect(readFileSync((err as GiftNotWrapped).linkFile, "utf8").split("\n")[0]).toBe(unwrappedMarker(GIFT_ID));
  });

  it("moi wrap refuses a gift id that is malformed or not open, before any payment", async () => {
    const claimed = setup({ giftState: 2 });
    await expect(wrapSavedGift(claimed.deps, "7")).rejects.toThrow(/Gift 7 is already claimed/);
    await expect(wrapSavedGift(claimed.deps, "07")).rejects.toThrow(/not a gift number/);
    expect(claimed.events).toEqual([]);
  });

  it("prefers an eip3009 option (U or USD1) over a Permit2 option listed before it", async () => {
    const t = setup();
    await sendGift(t.deps, INPUT);
    const preview = t.calls.find((c) => c[0] === "x402-payment" && c[1] === "preview")!;
    const sign = t.calls.find((c) => c[0] === "x402-payment" && c[1] === "sign")!;
    expect(flag(sign, "--selectedIndex")).toBe("3");
    expect(t.questions.at(-1)).toMatch(/^Pay the gift wrapping fee of 0\.05 U \(0xcE24439F2D9C6a2289F741120FE202248B666666\)/);
    expect(preview).toHaveLength(4);
  });

  it("refuses a FINISHED swap that left no stock in the wallet on chain", async () => {
    vi.useFakeTimers();
    const t = setup({ balances: [5n, 5n] });
    const outcome = sendGift(t.deps, INPUT).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await outcome;
    expect(err).toBeInstanceOf(GiftError);
    expect((err as Error).message).toMatch(/no NVDAB arrived in your wallet on chain/);
    expect(t.calls.some((c) => c[0] === "contract-call")).toBe(false);
    expect(captured.key).toBeUndefined();
  });

  it.each([
    ["less than the quote minus 1 percent", { toCoinAmount: "0.0271" }, 26_000_000_000_000_000n, "0.026 NVDAB"],
    ["less than the quote's own minimum", { toCoinAmount: "0.0271", minReceive: "0.0270" }, 26_950_000_000_000_000n, "0.02695 NVDAB"],
  ])("stops before approving the vault when %s arrived", async (_label, quote, arrived, held) => {
    const t = setup({ balances: [0n, arrived], replies: { "market-order quote": { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "NVDAB", ...quote } } });
    const err = await sendGift(t.deps, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GiftError);
    expect((err as Error).message).toMatch(/Binance delivered less than it quoted/);
    expect((err as Error).message).toContain(`The ${held} is in your wallet ${OWNER}. Moi stopped before approving the vault`);
    expect(t.calls.some((c) => c[0] === "contract-call")).toBe(false);
    expect(captured.key).toBeUndefined();
  });

  it("compares a scaled bStock in shares, as baw quotes it", async () => {
    // 0.0259 tokens at a 1.05 multiplier is 0.027195 shares, above the 0.026829 floor of a 0.0271-share quote.
    const t = setup({ balances: [0n, 25_900_000_000_000_000n], uiMultiplier: 1_050_000_000_000_000_000n });
    expect((await sendGift(t.deps, INPUT)).giftId).toBe(GIFT_ID);
  });

  it("stops when the Binance App holds the approval, says what is waiting and what the sender holds, and sends nothing more", async () => {
    const held = { orderId: "order-1", status: "PENDING_CONFIRMATION", txHash: null, message: "Please confirm in the Binance App" };
    const t = setup({ replies: { "contract-call execute": held } });
    const err = await sendGift(t.deps, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GiftError);
    expect((err as Error).message).toBe(
      `Approving the Moi vault is waiting for your OK in the Binance App, so Moi stopped here and sent nothing further. You hold the 0.0271 NVDAB in your wallet ${OWNER}, and no gift was made.`,
    );
    expect(commands(t.calls).slice(-2)).toEqual(["contract-call preview", "contract-call execute"]);
    expect(t.events).not.toContain("fetch");
  });

  it("keeps the key when the App holds createGift, and moi status saves the link once the gift exists", async () => {
    let executes = 0;
    const execute = () =>
      (executes += 1) === 1
        ? { orderId: "order-1", status: "BROADCASTED", txHash: APPROVE_HASH, message: null }
        : { orderId: "order-2", status: "PENDING_CONFIRMATION", txHash: null, message: "Please confirm in the Binance App" };
    const t = setup({ replies: { "contract-call execute": execute } });
    const message = String(await sendGift(t.deps, INPUT).catch((e: unknown) => (e as Error).message));
    const key = captured.key!;
    const pendingFile = path.join(t.deps.linkDir, `pending-${key.address.toLowerCase()}.txt`);
    expect(message).toBe(
      `Locking the gift is waiting for your OK in the Binance App, so Moi stopped here and sent nothing further. ` +
        `You hold the 0.0271 NVDAB in your wallet ${OWNER} until you approve it there; then it moves into the vault as the gift. ` +
        `After you approve it, run \`npm run moi -- status\` to check the gift and save its link. The gift key is kept in ${pendingFile} until then.`,
    );
    expect(readFileSync(pendingFile, "utf8").split("\n")[1]).toBe(key.privateKey);
    expect(t.events).not.toContain("fetch");

    const before = setup({ linkDir: t.deps.linkDir });
    await resolvePendingGifts(before.deps);
    expect(before.lines).toEqual([expect.stringMatching(/still waiting for your OK in the Binance App/)]);
    expect(existsSync(pendingFile)).toBe(true);

    const after = setup({ linkDir: t.deps.linkDir, claimKeyUsed: true });
    await resolvePendingGifts(after.deps);
    const linkFile = path.join(t.deps.linkDir, "gift-7.txt");
    expect(after.lines).toEqual([`Gift 7 was made after your approval. Its link is saved in ${linkFile}, but it is not wrapped yet: run \`npm run moi -- wrap 7\`.`]);
    const [marker, linkLine] = readFileSync(linkFile, "utf8").split("\n");
    expect(marker).toBe(unwrappedMarker(GIFT_ID));
    expect(parseLink(linkLine!).claimKey).toBe(key.privateKey);
    expect(existsSync(pendingFile)).toBe(false);
    expect([message, ...before.lines, ...after.lines].join("\n").toLowerCase()).not.toContain(key.privateKey.slice(2));
  });

  it("never lets the claim key or the link reach a log line, stdout or a thrown message", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const consoleLines = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    const t = setup();
    const result = await sendGift(t.deps, INPUT);
    const link = readFileSync(result.linkFile, "utf8").trim();

    const refused = setup({ required: requirements((a) => (a[0]!.payTo = "0x4444444444444444444444444444444444444444")) });
    const refusal = String(await sendGift(refused.deps, INPUT).catch((e: unknown) => (e as Error).message));
    const refusedKey = captured.key!.privateKey;

    const leaky = setup({
      createFails: () => {
        throw new Error(`node said ${captured.key!.privateKey}`);
      },
    });
    const scrubbed = String(await sendGift(leaky.deps, INPUT).catch((e: unknown) => (e as Error).message));
    const leakyKey = captured.key!.privateKey;

    const seen = [
      ...t.lines,
      ...t.questions,
      ...refused.lines,
      ...refused.questions,
      refusal,
      ...leaky.lines,
      scrubbed,
      ...stdout.mock.calls.map((c) => String(c[0])),
      ...consoleLines.flatMap((spy) => spy.mock.calls.map((c) => c.map(String).join(" "))),
    ]
      .join("\n")
      .toLowerCase();
    for (const secret of [link, parseLink(link).claimKey, refusedKey, leakyKey]) {
      expect(seen).not.toContain(secret.toLowerCase());
      expect(seen).not.toContain(secret.toLowerCase().replace(/^0x/, ""));
    }
    expect(scrubbed).toMatch(/The key was not shown anywhere/);
    expect(existsSync(path.join(leaky.deps.linkDir, "gift-7.txt"))).toBe(false);
  });

  it.each([
    [1, "market-order swap", "Stopped before buying"],
    [2, "contract-call execute", "Stopped before the approval"],
    [3, "contract-call execute", "Stopped before locking the gift"],
    [4, "x402-payment sign", "Stopped before paying the wrapping fee"],
  ])("stops at a 'no' to question %i before the next %s", async (question, nextCall, message) => {
    const confirms = [true, true, true, true].map((_, i) => i + 1 !== question);
    const t = setup({ confirms });
    const err = await sendGift(t.deps, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(question === 4 ? GiftNotWrapped : GiftCancelled);
    expect((err as Error).message).toContain(message);
    const executesBefore = question === 3 ? 1 : 0;
    const count = t.calls.filter((c) => `${c[0]} ${c[1]}` === nextCall).length;
    expect(count).toBe(nextCall === "contract-call execute" ? executesBefore : 0);
    expect(t.questions).toHaveLength(question);
    expect(t.payments.filter((p) => p !== null)).toEqual([]);
  });
});
