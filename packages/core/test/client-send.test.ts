// Not covered here: a real wallet, node or Binance service. The chain is an in-memory fake that
// applies approvals, the swap and createGift (key proof included); the /api/quote answers are
// scripted; /api/wrap is the real wrap.ts handler over a fake b402. A real browser's fetch, a
// router's own calldata and a mainnet run are not exercised; scripts/check-b402-payload.ts sends a
// browser-built payment to the live b402 verify.
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  maxUint256,
  parseAbi,
  recoverAddress,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { USDT as USDT_TEXT } from "../src/chain.js";
import { EXPECTED_ROUTER } from "../src/checks.js";
import { recoverPendingGift, sendGift, SendGiftError, wrapGift, type PendingGift, type SendGiftDeps, type SendStep, type WrapStep } from "../src/client/send.js";
import { PERMIT2_ADDRESS, type WalletSigner } from "../src/client/x402.js";
import { giftVaultAbi } from "../src/generated/giftVaultAbi.js";
import { claimKeyMatches, openNote, parseLink, registerDigest } from "../src/gift.js";
import { createMemoryStore } from "../src/store.js";
import type { Web3Api } from "../src/web3api.js";
import { handleWrap, PAYMENT_SIGNATURE_HEADER, WRAP_ASSETS } from "../src/wrap.js";

const ORIGIN = "https://moi.example";
const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const PAY_TO = getAddress("0x96e854abddc5c618ca843956d1303017b586ab75");
const STOCK = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const OTHER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const USDT = getAddress(USDT_TEXT);
const U = WRAP_ASSETS.find((a) => a.symbol === "U")!.address;
const SIGNER = "0x34F7a661160780Ce1346e6D7B96D2bE244590899";
const SPENDER = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633";
const E18 = 10n ** 18n;
const GIFT_USDT = 5n * E18;
const EXPECTED_OUT = 26_000_000_000_000_000n;
const MIN_OUT = (EXPECTED_OUT * 9_900n) / 10_000n;
const FEE = 50_000_000_000_000_000n;
const START_MS = 1_800_000_000_000;
const NOTE = "Happy birthday, from me";

const kind = (name: string, method: string) => ({
  x402Version: 2,
  scheme: "exact",
  network: "eip155:56",
  extra: { name, version: "1", assetTransferMethod: method, signerAddress: SIGNER, ...(method === "eip3009" ? {} : { spenderAddress: SPENDER }) },
});
const SUPPORTED = {
  kinds: [
    kind("United Stables", "eip3009"),
    kind("United Stables", "permit2-exact"),
    kind("World Liberty Financial USD", "eip3009"),
    kind("World Liberty Financial USD", "permit2-exact"),
    kind("Tether USD", "permit2-exact"),
    kind("USD Coin", "permit2-exact"),
  ],
};

const stringify = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const approveData = (spender: Address, amount: bigint) => encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [spender, amount] });
const SWAP_DATA = `0x7ff36ab5${GIFT_USDT.toString(16).padStart(64, "0")}` as Hex;

type Log = { address: Address; topics: Hex[]; data: Hex };
type MinedTx = { from: Address; to: Address; input: Hex; status: "success" | "reverted"; blockNumber: bigint; logs: Log[] };
type Gift = { token: Address; sender: Address; claimKey: Address; expiry: bigint; state: number; amount: bigint; sealedNote: Hex };

// An in-memory BNB Smart Chain: balances with history (a read at a block sees that block),
// allowances, gifts and mined transactions. Every effect a test relies on is applied by `mine`.
function createChain(clock: { now: () => number }) {
  let block = 100n;
  let txCount = 0;
  let nextGiftId = 1n;
  const balances = new Map<string, [bigint, bigint][]>();
  const allowances = new Map<string, bigint>();
  const gifts = new Map<bigint, Gift>();
  const txs = new Map<Hex, MinedTx>();
  const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(":");
  const nowSeconds = () => BigInt(Math.floor(clock.now() / 1000));

  function balance(token: Address, owner: Address, at?: bigint): bigint {
    const seen = (balances.get(key(token, owner)) ?? []).filter(([b]) => at === undefined || b <= at);
    return seen.length === 0 ? 0n : seen[seen.length - 1]![1];
  }
  function setBalance(token: Address, owner: Address, value: bigint) {
    const history = balances.get(key(token, owner)) ?? [];
    history.push([block, value]);
    balances.set(key(token, owner), history);
  }
  const allowance = (token: Address, owner: Address, spender: Address) => allowances.get(key(token, owner, spender)) ?? 0n;
  function record(tx: MinedTx): Hex {
    txCount += 1;
    const hash = keccak256(toHex(`tx-${txCount}`));
    txs.set(hash, tx);
    return hash;
  }
  function transfer(token: Address, from: Address, to: Address, amount: bigint): Log {
    setBalance(token, from, balance(token, from) - amount);
    setBalance(token, to, balance(token, to) + amount);
    return {
      address: getAddress(token).toLowerCase() as Address,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    };
  }

  async function mine(from: Address, tx: { to: Address; data: Hex }): Promise<Hex> {
    block += 1n;
    const logs: Log[] = [];
    let status: MinedTx["status"] = "success";
    const to = getAddress(tx.to);
    if (tx.data.startsWith("0x095ea7b3")) {
      const { args } = decodeFunctionData({ abi: approveAbi, data: tx.data });
      allowances.set(key(to, from, args[0]), args[1]);
    } else if (to === EXPECTED_ROUTER) {
      if (allowance(USDT, from, EXPECTED_ROUTER) < GIFT_USDT || balance(USDT, from) < GIFT_USDT) status = "reverted";
      else {
        setBalance(USDT, from, balance(USDT, from) - GIFT_USDT);
        setBalance(STOCK, from, balance(STOCK, from) + chain.deliver);
      }
    } else if (to === VAULT) {
      const decoded = decodeFunctionData({ abi: giftVaultAbi, data: tx.data });
      const [token, amount, claimKey, expiry, sealedNote, keyProof] = decoded.args as unknown as [Address, bigint, Address, bigint, Hex, Hex];
      const prover = await recoverAddress({ hash: registerDigest(VAULT, 56, from), signature: keyProof });
      if (decoded.functionName !== "createGift" || prover !== getAddress(claimKey) || allowance(token, from, VAULT) < amount || balance(token, from) < amount) {
        status = "reverted";
      } else {
        allowances.set(key(token, from, VAULT), allowance(token, from, VAULT) - amount);
        transfer(token, from, VAULT, amount);
        const giftId = nextGiftId++;
        gifts.set(giftId, { token: getAddress(token), sender: from, claimKey: getAddress(claimKey), expiry, state: 1, amount, sealedNote });
        logs.push({
          address: VAULT.toLowerCase() as Address,
          topics: encodeEventTopics({ abi: giftVaultAbi, eventName: "GiftCreated", args: { giftId, token, sender: from } }) as Hex[],
          data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [claimKey, amount, expiry]),
        });
      }
    }
    return record({ from, to, input: tx.data, status, blockNumber: block, logs });
  }

  // Every read's arguments, so a test can prove no claim key ever went to the node.
  const reads: unknown[] = [];
  const stats = { multicalls: 0 };
  const client = {
    getChainId: async () => 56,
    getBlock: async () => ({ timestamp: nowSeconds(), number: block }),
    multicall: async ({ contracts, multicallAddress }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]; multicallAddress: Address }) => {
      if (getAddress(multicallAddress) !== getAddress("0xcA11bde05977b3631167028862bE2a173976CA11")) throw new Error("not Multicall3");
      stats.multicalls += 1;
      return Promise.all(contracts.map((c) => client.readContract(c)));
    },
    readContract: async ({ address, functionName, args, blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      reads.push({ address, functionName, args });
      const at = getAddress(address);
      switch (functionName) {
        case "claimKeyUsed":
          return [...gifts.values()].some((g) => g.claimKey === getAddress(args![0] as Address));
        case "nextGiftId":
          return nextGiftId;
        case "listedTokens":
          return [STOCK];
        case "decimals":
          return 18;
        case "symbol":
          return at === STOCK ? "NVDAB" : "USDT";
        case "uiMultiplier":
          if (at === STOCK) return E18;
          throw new Error("no uiMultiplier");
        case "balanceOf":
          return balance(at, args![0] as Address, blockNumber);
        case "allowance":
          return allowance(at, args![0] as Address, args![1] as Address);
        case "getGift": {
          const gift = gifts.get(args![0] as bigint);
          return gift ?? { token: VAULT, sender: VAULT, claimKey: VAULT, expiry: 0n, state: 0, amount: 0n, sealedNote: "0x" };
        }
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const tx = txs.get(hash);
      if (tx === undefined) throw new TransactionReceiptNotFoundError({ hash });
      return { status: tx.status, transactionHash: hash, blockNumber: tx.blockNumber, logs: tx.logs, from: tx.from, to: tx.to };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => client.getTransactionReceipt({ hash }),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const tx = txs.get(hash)!;
      return { hash, input: tx.input, from: tx.from, to: tx.to, value: 0n, chainId: 56 };
    },
  };
  // Another sender's gift, numbered like the vault numbers them.
  const addGift = (gift: Gift) => gifts.set(nextGiftId++, gift);
  const chain = { deliver: EXPECTED_OUT, gifts, txs, reads, stats, balance, setBalance, allowance, mine, record, transfer, addGift, client: client as unknown as PublicClient };
  return chain;
}

type Chain = ReturnType<typeof createChain>;
type QuoteAnswer = { status: number; body: unknown };

// One test's whole world: a shared clock, the chain, a wallet on it, and Moi's server. `settle`
// lists b402's settle answers in order, repeating the last.
function createWorld(opts: { usdt?: bigint; u?: bigint; settle?: ("pending" | "settled")[]; quote?: (wallet: Address) => QuoteAnswer | undefined } = {}) {
  let now = START_MS;
  const sleeps: number[] = [];
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  const chain = createChain(clock);
  const account = privateKeyToAccount(generatePrivateKey());
  chain.setBalance(USDT, account.address, opts.usdt ?? 10n * E18);
  if (opts.u !== undefined) chain.setBalance(U, account.address, opts.u);

  const timeline: string[] = [];
  const requests: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
  const signed: unknown[] = [];
  const sent: { to: Address; data: Hex }[] = [];
  const wallet = {
    tamper: null as null | ((tx: { to: Address; data: Hex }) => { to: Address; data: Hex }),
    reject: null as null | ((tx: { to: Address; data: Hex }) => boolean),
  };
  const signer: WalletSigner = {
    address: account.address,
    signTypedData: async (typedData) => {
      signed.push(typedData);
      timeline.push("sign");
      return account.signTypedData(typedData);
    },
    signMessage: (message) => account.signMessage({ message }),
    sendTransaction: async (tx) => {
      if (tx.chainId !== 56 || tx.value !== 0n) throw new Error("bad transaction fields");
      sent.push({ to: tx.to, data: tx.data });
      timeline.push(`send ${tx.data.slice(0, 10)}`);
      if (wallet.reject?.(tx)) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      return chain.mine(account.address, wallet.tamper === null ? tx : wallet.tamper(tx));
    },
  };

  let settles = 0;
  const settleScript = opts.settle ?? ["settled"];
  const api: Web3Api = {
    get: async () => {
      throw new Error("no GET");
    },
    post: async (path, body) => {
      if (path === "/api/v2/b402/supported") return structuredClone(SUPPORTED);
      const { paymentPayload, paymentRequirements } = (body as { body: { paymentPayload: Record<string, any>; paymentRequirements: Record<string, any> } }).body;
      const payer = getAddress(paymentPayload.payload.authorization?.from ?? paymentPayload.payload.permit2Authorization.from);
      if (path === "/api/v2/b402/verify") return { isValid: true, payer };
      const step = settleScript[Math.min(settles++, settleScript.length - 1)];
      const asset = getAddress(paymentRequirements.asset);
      const amount = BigInt(paymentRequirements.amount);
      if (paymentRequirements.extra.assetTransferMethod === "permit2-exact" && chain.allowance(asset, payer, PERMIT2_ADDRESS) < amount) {
        return { success: false, transaction: "", network: "eip155:56" };
      }
      if (step === "pending") return { success: false, transaction: `0x${"cd".repeat(32)}`, network: "eip155:56" };
      const log = chain.transfer(asset, payer, PAY_TO, amount);
      const hash = chain.record({ from: payer, to: asset, input: "0x", status: "success", blockNumber: 1n, logs: [log] });
      return { success: true, transaction: hash, network: "eip155:56", amount: amount.toString() };
    },
  };
  const serverDeps = { api, client: chain.client, vault: VAULT, store: createMemoryStore(clock.now), origin: ORIGIN, payTo: PAY_TO, priceUsd: "0.05", settleBudgetMs: 1, now: clock.now, sleep: clock.sleep };

  const quoteFor = (wallet: Address): QuoteAnswer => {
    const scripted = opts.quote?.(wallet);
    if (scripted !== undefined) return scripted;
    if (chain.allowance(USDT, wallet, EXPECTED_ROUTER) < GIFT_USDT) {
      return { status: 200, body: { ok: true, step: "approve", approveTx: { to: USDT, data: approveData(EXPECTED_ROUTER, GIFT_USDT), value: "0" } } };
    }
    return { status: 200, body: swapQuote() };
  };

  const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const body = typeof init?.body === "string" ? init.body : null;
    requests.push({ url: url.href, method: init?.method ?? "GET", headers, body });
    timeline.push(`fetch ${url.pathname}`);
    if (init?.redirect !== "error" || init?.credentials !== "omit") throw new Error("a Moi request must refuse redirects and send no cookies");
    if (url.pathname === "/api/quote") {
      const answer = quoteFor(getAddress(JSON.parse(body ?? "{}").wallet));
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    const wrap = /^\/api\/wrap\/([0-9]+)$/.exec(url.pathname);
    if (wrap !== null) {
      const res = await handleWrap(serverDeps, wrap[1]!, headers[PAYMENT_SIGNATURE_HEADER] ?? null);
      return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
    }
    return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
  };

  const deps: SendGiftDeps = { fetch: fetchFake, origin: ORIGIN, signer, publicClient: chain.client, vault: VAULT, payTo: PAY_TO, now: clock.now, sleep: clock.sleep };
  return { deps, chain, account, timeline, requests, signed, sent, sleeps, wallet };
}

function swapQuote(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    step: "swap",
    stock: STOCK,
    usdAmount: "5",
    swapTx: { to: EXPECTED_ROUTER, data: SWAP_DATA, value: "0" },
    vaultApproveTx: { to: STOCK, data: approveData(VAULT, MIN_OUT), value: "0" },
    expectedOut: EXPECTED_OUT.toString(),
    minOut: MIN_OUT.toString(),
    priceUsd: "190.5",
    ...patch,
  };
}

async function collect<T extends { kind: string }>(gen: AsyncGenerator<T, unknown, void>, timeline?: string[]) {
  const steps: T[] = [];
  let error: SendGiftError | null = null;
  let result: unknown;
  try {
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      steps.push(next.value);
      timeline?.push(`step ${next.value.kind}`);
    }
  } catch (err) {
    if (!(err instanceof SendGiftError)) throw err;
    error = err;
  }
  const kinds = steps.map((s) => (s.kind === "wrap" ? `wrap:${(s as unknown as { stage: string }).stage}` : s.kind));
  return { steps, kinds, error, result };
}

const gift = (input: Partial<{ stock: Address; usdAmount: string; note: string; expiryDays: number }> = {}) => ({ stock: STOCK, usdAmount: "5", note: NOTE, ...input });
const paidHeaders = (w: ReturnType<typeof createWorld>) => w.requests.filter((r) => r.url.includes("/api/wrap/") && r.headers[PAYMENT_SIGNATURE_HEADER] !== undefined).map((r) => r.headers[PAYMENT_SIGNATURE_HEADER]);

describe("sendGift", () => {
  it("runs every step in order for a first-time sender holding only USDT, and the gift, link and note all check out", async () => {
    const w = createWorld();
    const run = await collect(sendGift(w.deps, gift({ expiryDays: 7 })), w.timeline);
    expect(run.error).toBeNull();
    expect(run.kinds).toEqual(["quote", "approve-usdt", "swap", "approve-vault", "key-pending", "create", "link-ready", "wrap:pay", "approve-permit2", "wrap:pay", "done"]);

    // Each transaction the wallet was asked for is exactly the one its step announced.
    const announced = run.steps.filter((s): s is Extract<SendStep, { tx: unknown }> => "tx" in s).map((s) => ({ to: s.tx.to, data: s.tx.data }));
    expect(w.sent).toEqual(announced);
    expect(w.sent[0]).toEqual({ to: USDT, data: approveData(EXPECTED_ROUTER, GIFT_USDT) });
    expect(w.sent[2]).toEqual({ to: STOCK, data: approveData(VAULT, EXPECTED_OUT) });
    expect(w.sent[4]).toEqual({ to: USDT, data: approveData(PERMIT2_ADDRESS, FEE) });

    const done = run.steps.at(-1) as Extract<SendStep, { kind: "done" }>;
    const ready = run.steps.find((s) => s.kind === "link-ready") as Extract<SendStep, { kind: "link-ready" }>;
    expect(done).toMatchObject({ giftId: 1n, link: ready.link });
    expect(done.wrapTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    const link = parseLink(ready.link);
    expect(link).toMatchObject({ origin: ORIGIN, giftId: 1n });
    const stored = w.chain.gifts.get(1n)!;
    expect(stored).toMatchObject({ token: STOCK, sender: w.account.address, amount: EXPECTED_OUT, state: 1 });
    expect(claimKeyMatches(link.claimKey, stored.claimKey)).toBe(true);
    expect(await openNote(link.claimKey, stored.sealedNote)).toBe(NOTE);
    expect(stored.expiry).toBe(BigInt(START_MS / 1000) + 7n * 86_400n);
    expect(w.chain.balance(USDT, PAY_TO)).toBe(FEE);
    expect(w.signed).toHaveLength(1);

    // The pending record holds this gift's key and note and is handed over before createGift is sent.
    const pending = (run.steps.find((s) => s.kind === "key-pending") as Extract<SendStep, { kind: "key-pending" }>).pending;
    expect(pending).toEqual({ senderAddress: w.account.address, claimKey: link.claimKey, sealedNote: stored.sealedNote, createdAt: START_MS / 1000, landsBefore: Number(stored.expiry) - 3_600 });
    expect(JSON.parse(JSON.stringify(pending))).toEqual(pending);
    const createSelector = w.sent[3]!.data.slice(0, 10);
    expect(w.timeline.indexOf("step key-pending")).toBeLessThan(w.timeline.indexOf(`send ${createSelector}`));

    // C12: the claim key is in no request URL, header or body, in no chain read, and in nothing the wallet signed or sent.
    const bare = link.claimKey.slice(2);
    const everything = stringify([w.requests, w.sent, w.signed, w.chain.reads]).toLowerCase();
    expect(everything).not.toContain(bare);
  });

  it("pays the fee in U through eip3009 when the wallet holds U, with no approval", async () => {
    const w = createWorld({ u: E18 });
    const run = await collect(sendGift(w.deps, gift()));
    expect(run.error).toBeNull();
    expect(run.kinds.slice(run.kinds.indexOf("key-pending"))).toEqual(["key-pending", "create", "link-ready", "wrap:pay", "done"]);
    expect(w.chain.balance(U, PAY_TO)).toBe(FEE);
    expect(w.signed).toHaveLength(1);
    expect((w.signed[0] as { primaryType: string }).primaryType).toBe("TransferWithAuthorization");
  });

  it("hands out the link before any wrap request, so a wrap that fails never loses it", async () => {
    const w = createWorld({ usdt: GIFT_USDT });
    const run = await collect(sendGift(w.deps, gift()), w.timeline);
    // The USDT all went into the purchase, so nothing is left for the fee.
    expect(run.error).toMatchObject({ code: "wrap_unpayable", giftId: 1n });
    expect(run.error!.stillHeld).toContain("link is ready");
    expect(run.kinds.at(-1)).toBe("link-ready");
    expect(w.timeline.indexOf("step link-ready")).toBeLessThan(w.timeline.indexOf("fetch /api/wrap/1"));
    expect(w.signed).toHaveLength(0);
  });

  it("replays the identical payment header while the server answers 202 settlement_pending, and signs only once", async () => {
    const w = createWorld({ settle: ["pending", "pending", "settled"] });
    const run = await collect(sendGift(w.deps, gift()));
    expect(run.error).toBeNull();
    expect(run.kinds.slice(-3)).toEqual(["wrap:pay", "wrap:settling", "done"]);
    const headers = paidHeaders(w);
    expect(headers).toHaveLength(3);
    expect(new Set(headers).size).toBe(1);
    expect(w.signed).toHaveLength(1);
    expect(w.sleeps).toEqual([5_000, 5_000]);
    expect(w.chain.balance(USDT, PAY_TO)).toBe(FEE);
  });

  it("stops with wrap_pending after 3 minutes of settlement_pending, having signed once and kept the gift", async () => {
    const w = createWorld({ settle: ["pending"] });
    const run = await collect(sendGift(w.deps, gift()));
    expect(run.error).toMatchObject({ code: "wrap_pending", giftId: 1n });
    expect(run.error!.message).toContain("you will not pay twice");
    expect(run.kinds).toContain("link-ready");
    expect(w.signed).toHaveLength(1);
    const headers = paidHeaders(w);
    expect(new Set(headers).size).toBe(1);
    expect(headers.length).toBeGreaterThan(30);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(180_000);
  });

  it("stops when the chain's copy of a transaction is not the calldata Moi built (C48), before locking anything", async () => {
    const w = createWorld();
    w.wallet.tamper = (tx) => (tx.data === approveData(VAULT, EXPECTED_OUT) ? { to: tx.to, data: approveData(VAULT, maxUint256) } : tx);
    const run = await collect(sendGift(w.deps, gift()));
    expect(run.error).toMatchObject({ code: "tx_mismatch", giftId: null });
    expect(run.error!.stillHeld).toContain("0.026 NVDAB you bought is in your wallet");
    expect(run.kinds.at(-1)).toBe("approve-vault");
    expect(w.chain.gifts.size).toBe(0);
  });

  it("refuses a quote that breaks C21 before the wallet is asked for anything", async () => {
    const bad: QuoteAnswer[] = [
      { status: 200, body: { ok: true, step: "approve", approveTx: { to: USDT, data: approveData(EXPECTED_ROUTER, maxUint256), value: "0" } } },
      { status: 200, body: { ok: true, step: "approve", approveTx: { to: USDT, data: approveData(OTHER, GIFT_USDT), value: "0" } } },
      { status: 200, body: swapQuote({ swapTx: { to: OTHER, data: SWAP_DATA, value: "0" } }) },
      { status: 200, body: swapQuote({ minOut: "1" }) },
      { status: 200, body: swapQuote({ stock: OTHER }) },
      { status: 200, body: swapQuote({ usdAmount: "50" }) },
      { status: 200, body: swapQuote({ swapTx: { to: EXPECTED_ROUTER, data: SWAP_DATA, value: "1" } }) },
      { status: 200, body: swapQuote({ extra: "field" }) },
    ];
    for (const answer of bad) {
      const w = createWorld({ quote: () => answer });
      const run = await collect(sendGift(w.deps, gift()));
      expect(run.error?.code).toBe("quote_refused");
      expect(run.error!.stillHeld).toBe("Nothing was spent.");
      expect(w.sent).toHaveLength(0);
    }
  });

  it("turns a decline, a short swap and a server refusal into typed errors that say what is still held", async () => {
    const declined = createWorld();
    declined.wallet.reject = (tx) => getAddress(tx.to) === EXPECTED_ROUTER;
    const a = await collect(sendGift(declined.deps, gift()));
    expect(a.error).toMatchObject({ code: "declined" });
    expect(a.error!.stillHeld).toContain("trading router may spend exactly that amount");

    const short = createWorld();
    short.chain.deliver = MIN_OUT - 1n;
    const b = await collect(sendGift(short.deps, gift()));
    expect(b.error).toMatchObject({ code: "swap_short" });
    expect(b.error!.stillHeld).toContain("NVDAB you bought is in your wallet");
    expect(short.sent.some((tx) => getAddress(tx.to) === VAULT)).toBe(false);

    const refused = createWorld({ quote: () => ({ status: 403, body: { ok: false, error: "restricted_place" } }) });
    const c = await collect(sendGift(refused.deps, gift()));
    expect(c.error).toMatchObject({ code: "quote_refused", message: "Moi gifts are not available where you are connecting from." });

    const unknown = createWorld({ quote: () => ({ status: 500, body: { ok: false, error: "<script>" } }) });
    const d = await collect(sendGift(unknown.deps, gift()));
    expect(d.error!.message).toBe("Moi's server refused the request. Try again in a minute.");
  });

  it("refuses bad input and an unlisted stock before any request", async () => {
    const cases: [Partial<Parameters<typeof gift>[0]>, string][] = [
      [{ stock: OTHER }, "not_listed"],
      [{ note: "x".repeat(484) }, "bad_input"],
      [{ expiryDays: 0 }, "bad_input"],
      [{ expiryDays: 91 }, "bad_input"],
      [{ expiryDays: 1.5 }, "bad_input"],
      [{ usdAmount: "100.01" }, "bad_input"],
      [{ usdAmount: "1e3" }, "bad_input"],
      [{ usdAmount: "11" }, "bad_input"],
    ];
    for (const [input, code] of cases) {
      const w = createWorld();
      const run = await collect(sendGift(w.deps, gift(input)));
      expect(run.error?.code).toBe(code);
      expect(w.requests).toHaveLength(0);
      expect(w.sent).toHaveLength(0);
    }
  });
});

describe("wrapGift", () => {
  it("returns the settlement of a gift already wrapped and pays nothing again", async () => {
    const w = createWorld({ u: E18 });
    const first = await collect(sendGift(w.deps, gift()));
    const again = await collect(wrapGift(w.deps, 1n) as AsyncGenerator<WrapStep, unknown, void>);
    expect(again.error).toBeNull();
    expect(again.steps).toEqual([]);
    expect(again.result).toBe((first.steps.at(-1) as Extract<SendStep, { kind: "done" }>).wrapTxHash);
    expect(w.signed).toHaveLength(1);
  });

  it("refuses to pay a 402 whose payee is not the pinned one, and signs nothing", async () => {
    const w = createWorld({ u: E18 });
    // A gift placed straight into the fake vault, so only the wrap step runs.
    const key = privateKeyToAccount(generatePrivateKey());
    w.chain.gifts.set(1n, { token: STOCK, sender: w.account.address, claimKey: key.address, expiry: BigInt(START_MS / 1000) + 86_400n, state: 1, amount: 1n, sealedNote: "0x" });
    const run = await collect(wrapGift({ ...w.deps, payTo: OTHER }, 1n) as AsyncGenerator<WrapStep, unknown, void>);
    expect(run.error).toMatchObject({ code: "wrap_refused", giftId: 1n });
    expect(w.signed).toHaveLength(0);
    expect(paidHeaders(w)).toHaveLength(0);
  });
});

describe("recoverPendingGift", () => {
  // Runs sendGift as a page would until the createGift transaction has been sent and mined, then
  // drops the flow as a closed tab would, before the link reaches the page.
  async function sendThenCloseTab(w: ReturnType<typeof createWorld>) {
    const flow = sendGift(w.deps, gift());
    let pending: PendingGift | null = null;
    for (;;) {
      const next = await flow.next();
      if (next.done) throw new Error("the flow ended early");
      if (next.value.kind === "key-pending") pending = next.value.pending;
      if (next.value.kind === "link-ready") break;
    }
    await flow.return(undefined);
    return pending!;
  }

  it("finds the gift a closed tab made and rebuilds its link, reading only the key's address", async () => {
    const w = createWorld();
    const pending = await sendThenCloseTab(w);
    const reads = w.chain.reads.length;
    const found = await recoverPendingGift({ publicClient: w.chain.client, vault: VAULT, origin: ORIGIN }, pending);
    expect(found?.giftId).toBe(1n);
    expect(parseLink(found!.link)).toEqual({ origin: ORIGIN, giftId: 1n, claimKey: pending.claimKey });
    expect(stringify(w.chain.reads.slice(reads)).toLowerCase()).not.toContain(pending.claimKey.slice(2));
  });

  it("returns null when the key has not made a gift", async () => {
    const w = createWorld();
    w.wallet.reject = (tx) => getAddress(tx.to) === VAULT;
    const run = await collect(sendGift(w.deps, gift()));
    expect(run.error).toMatchObject({ code: "declined" });
    expect(run.error!.stillHeld).toContain("Keep the saved gift key");
    const pending = (run.steps.find((s) => s.kind === "key-pending") as Extract<SendStep, { kind: "key-pending" }>).pending;
    expect(await recoverPendingGift({ publicClient: w.chain.client, vault: VAULT, origin: ORIGIN }, pending)).toBeNull();
  });

  it("scans only the newest 1,000 gifts, newest first, in batches, and keeps the record when the gift is older", async () => {
    const w = createWorld();
    const pending = await sendThenCloseTab(w);
    const someone = (n: number) => ({ token: STOCK, sender: OTHER, claimKey: privateKeyToAccount(keccak256(toHex(`other-${n}`))).address, expiry: 1n, state: 1, amount: 1n, sealedNote: "0x" as Hex });
    for (let n = 0; n < 999; n += 1) w.chain.addGift(someone(n));
    const deps = { publicClient: w.chain.client, vault: VAULT, origin: ORIGIN };
    const before = w.chain.stats.multicalls;
    expect((await recoverPendingGift(deps, pending))?.giftId).toBe(1n);
    expect(w.chain.stats.multicalls - before).toBe(10);
    w.chain.addGift(someone(999));
    await expect(recoverPendingGift(deps, pending)).rejects.toMatchObject({ code: "gift_not_found", stillHeld: expect.stringContaining("Keep the saved gift key") });
    await expect(recoverPendingGift(deps, { ...pending, claimKey: "0x12" })).rejects.toMatchObject({ code: "bad_input" });
  });
});
