// Not covered here: b402 itself (scripts/check-b402-payload.ts sends a browser-built USDT payment
// to the live verify), a real wallet extension or Privy (the signer is a local viem account), a
// token contract executing the signed authorization, and the browser's own fetch and atob.
import { encodeFunctionData, erc20Abi, getAddress, isAddress, maxUint256, recoverTypedDataAddress, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPayment,
  decodePaymentRequired,
  PaymentRequestError,
  PERMIT2_ADDRESS,
  permit2ApprovalTx,
  pickRequirement,
  WRAP_FEE_CEILING_USD,
  type WalletSigner,
} from "../src/client/x402.js";
import { createMemoryStore } from "../src/store.js";
import type { Web3Api } from "../src/web3api.js";
import { handleWrap, PAYMENT_REQUIRED_HEADER, WRAP_ASSETS, type PaymentRequirementsV2 } from "../src/wrap.js";

const PAY_TO = getAddress("0x96e854abddc5c618ca843956d1303017b586ab75");
const ORIGIN = "https://moi.example";
const VAULT = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const SIGNER = "0x34F7a661160780Ce1346e6D7B96D2bE244590899";
const SPENDER = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633";
const START_MS = 1_800_000_000_000;
const NOW_S = BigInt(START_MS / 1000);
const PRICE_UNITS = "50000000000000000";
const RESOURCE = `${ORIGIN}/api/wrap/7`;

const kind = (name: string, method: string, spender?: string) => ({
  x402Version: 2,
  scheme: method === "permit2-upto" ? "upto" : "exact",
  network: "eip155:56",
  extra: { name, version: "1", assetTransferMethod: method, signerAddress: SIGNER, ...(spender === undefined ? {} : { spenderAddress: spender }) },
});

// The live /supported kinds of 2026-10-07, upto included so the server's own filter is exercised.
const SUPPORTED = {
  kinds: [
    kind("United Stables", "eip3009"),
    kind("United Stables", "permit2-exact", SPENDER),
    kind("United Stables", "permit2-upto", SPENDER),
    kind("World Liberty Financial USD", "eip3009"),
    kind("World Liberty Financial USD", "permit2-exact", SPENDER),
    kind("Tether USD", "permit2-exact", SPENDER),
    kind("USD Coin", "permit2-exact", SPENDER),
  ],
};

const asset = (symbol: string) => WRAP_ASSETS.find((a) => a.symbol === symbol)!;

function requirement(symbol: string, method: "eip3009" | "permit2-exact"): PaymentRequirementsV2 {
  const a = asset(symbol);
  return {
    scheme: "exact",
    network: "eip155:56",
    amount: PRICE_UNITS,
    asset: a.address,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { name: a.name, version: "1", assetTransferMethod: method, signerAddress: SIGNER, ...(method === "permit2-exact" ? { spenderAddress: SPENDER } : {}) },
  };
}

function localSigner(key: Hex = generatePrivateKey(), signs = { count: 0 }): WalletSigner {
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    signTypedData: async (typedData) => {
      signs.count += 1;
      return account.signTypedData(typedData);
    },
    signMessage: (message) => account.signMessage({ message }),
    sendTransaction: async () => {
      throw new Error("no transactions in this file");
    },
  };
}

// A node that reports `chainId`, a latest block at `blockTime` (an Error: the read fails) and
// answers allowance(owner, Permit2) with `allowance`.
function buyerClient(allowance: bigint, chainId = 56, reads: unknown[][] = [], blockTime: bigint | Error = NOW_S) {
  return {
    getChainId: async () => chainId,
    getBlock: async () => {
      if (blockTime instanceof Error) throw blockTime;
      return { timestamp: blockTime };
    },
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName !== "allowance") throw new Error(`unexpected read ${functionName}`);
      reads.push(args);
      return allowance;
    },
  } as unknown as PublicClient;
}

const decodeHeader = (header: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))));
const toBase64 = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));

async function pay(symbol: string, method: "eip3009" | "permit2-exact", signer = localSigner()) {
  const req = requirement(symbol, method);
  const built = await buildPayment({ signer, publicClient: buyerClient(maxUint256) }, req, RESOURCE);
  return { req, built, signer };
}

// The server side of /api/wrap/7 with every dependency faked: an Open gift, a store in memory, and
// a b402 whose verify records what it was sent and answers `isValid`.
function wrapServer(isValid: boolean) {
  const verified: unknown[] = [];
  const api: Web3Api = {
    get: async () => {
      throw new Error("no GET in wrap");
    },
    post: async (path, body) => {
      if (path === "/api/v2/b402/supported") return structuredClone(SUPPORTED);
      if (path === "/api/v2/b402/verify") {
        verified.push(body);
        return { isValid, payer: PAY_TO };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  const client = {
    getChainId: async () => 56,
    readContract: async () => ({ token: PAY_TO, sender: PAY_TO, claimKey: PAY_TO, expiry: NOW_S + 86_400n, state: 1, amount: 1n, sealedNote: "0x" }),
    getBlock: async () => ({ timestamp: NOW_S }),
  } as unknown as PublicClient;
  const deps = { api, client, vault: VAULT, store: createMemoryStore(() => START_MS), origin: ORIGIN, payTo: PAY_TO, priceUsd: "0.05", now: () => START_MS, sleep: async () => {} };
  return { handle: (header: string | null) => handleWrap(deps, "7", header), verified };
}

describe("decodePaymentRequired", () => {
  it("reads the 402 that wrap.ts itself sends, every requirement unchanged", async () => {
    const res = await wrapServer(true).handle(null);
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequired(res.headers![PAYMENT_REQUIRED_HEADER]!);
    expect(decoded).toEqual(res.body);
    expect(decoded.accepts.map((r) => [r.asset, r.extra.assetTransferMethod])).toEqual([
      [asset("U").address, "eip3009"],
      [asset("U").address, "permit2-exact"],
      [asset("USD1").address, "eip3009"],
      [asset("USD1").address, "permit2-exact"],
      [asset("USDT").address, "permit2-exact"],
      [asset("USDC").address, "permit2-exact"],
    ]);
    expect(decoded.resource?.url).toBe(RESOURCE);
  });

  it("refuses anything that is not exactly an x402 v2 request for exact payments on chain 56", () => {
    const good = { x402Version: 2, resource: { url: RESOURCE }, accepts: [requirement("U", "eip3009")] };
    expect(decodePaymentRequired(toBase64(good)).accepts).toHaveLength(1);
    const withReq = (patch: Record<string, unknown>) => ({ ...good, accepts: [{ ...requirement("U", "eip3009"), ...patch }] });
    const permit2 = requirement("USDT", "permit2-exact");
    const bad: unknown[] = [
      { ...good, x402Version: 1 },
      { ...good, accepts: [] },
      { ...good, admin: true },
      withReq({ network: "eip155:97" }),
      withReq({ scheme: "upto" }),
      withReq({ amount: "-1" }),
      withReq({ amount: "05" }),
      withReq({ payTo: "0x1234" }),
      withReq({ asset: "0x55D398326F99059FF775485246999027B3197955" }),
      withReq({ note: "pay me" }),
      withReq({ extra: { ...permit2.extra, assetTransferMethod: "permit2-upto" } }),
      withReq({ extra: { ...permit2.extra, spenderAddress: undefined } }),
      withReq({ extra: { ...requirement("U", "eip3009").extra, facilitator: SIGNER } }),
      { ...good, resource: { url: RESOURCE, extra: 1 } },
      [good],
      "x402",
    ];
    for (const value of bad) expect(() => decodePaymentRequired(toBase64(value))).toThrow(PaymentRequestError);
    for (const text of ["", "not base64!", "abc", toBase64(good).slice(1), "A".repeat(16 * 1024 + 4), btoa("{not json"), btoa("\xff\xfe")]) {
      expect(() => decodePaymentRequired(text)).toThrow(PaymentRequestError);
    }
    expect(() => decodePaymentRequired(null as unknown as string)).toThrow(PaymentRequestError);
  });
});

describe("pickRequirement", () => {
  const opts = { payTo: PAY_TO, maxUsd: WRAP_FEE_CEILING_USD, assets: WRAP_ASSETS, prefer: "eip3009-first" as const };

  it("takes the first eip3009 requirement, else the first permit2-exact one", () => {
    const all = [requirement("USDT", "permit2-exact"), requirement("U", "permit2-exact"), requirement("USD1", "eip3009"), requirement("U", "eip3009")];
    expect(pickRequirement(all, opts)).toBe(all[2]);
    expect(pickRequirement(all.slice(0, 2), opts)).toBe(all[0]);
    expect(pickRequirement([], opts)).toBeNull();
  });

  it("skips a requirement for another payee, an unlisted or misnamed asset, a zero amount or one above the ceiling", () => {
    const u = requirement("U", "eip3009");
    const skipped: PaymentRequirementsV2[] = [
      { ...u, payTo: getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8") },
      { ...u, asset: getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436") },
      { ...u, extra: { ...u.extra, name: "Tether USD" } },
      { ...u, amount: "0" },
      { ...u, amount: "100000000000000001" },
      { ...u, network: "eip155:97" as "eip155:56" },
      { ...u, extra: { ...u.extra, assetTransferMethod: "permit2-upto", spenderAddress: SPENDER } },
    ];
    for (const r of skipped) expect(pickRequirement([r], opts)).toBeNull();
    expect(pickRequirement([{ ...u, amount: "100000000000000000" }], opts)).not.toBeNull();
    expect(pickRequirement([{ ...u, payTo: PAY_TO.toLowerCase() as Address }], opts)).not.toBeNull();
    expect(pickRequirement([u], { ...opts, maxUsd: "0.01" })).toBeNull();
  });

  it("throws on a pinned payee or ceiling that is unusable", () => {
    const all = [requirement("U", "eip3009")];
    expect(() => pickRequirement(all, { ...opts, payTo: "0x0000000000000000000000000000000000000000" })).toThrow();
    expect(() => pickRequirement(all, { ...opts, payTo: "0x1234" as Address })).toThrow();
    expect(() => pickRequirement(all, { ...opts, maxUsd: "ten" })).toThrow();
  });
});

describe("buildPayment", () => {
  it("signs an eip3009 TransferWithAuthorization over the token's own domain, valid from now - 5 s to now + 600 s", async () => {
    const { req, built, signer } = await pay("U", "eip3009");
    expect(built.needsPermit2Approval).toBeNull();
    const sent = decodeHeader(built.headerValue);
    expect(Object.keys(sent)).toEqual(["x402Version", "resource", "accepted", "payload"]);
    expect(sent).toMatchObject({ x402Version: 2, resource: { url: RESOURCE }, accepted: req });
    const auth = sent.payload.authorization;
    expect(auth).toMatchObject({ from: signer.address, to: PAY_TO, value: PRICE_UNITS, validAfter: String(NOW_S - 5n), validBefore: String(NOW_S + 600n) });
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "United Stables", version: "1", chainId: 56, verifyingContract: asset("U").address },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: sent.payload.signature,
    });
    expect(recovered).toBe(signer.address);
    const again = decodeHeader((await pay("U", "eip3009", signer)).built.headerValue);
    expect(again.payload.authorization.nonce).not.toBe(auth.nonce);
  });

  it("signs a Permit2 PermitWitnessTransferFrom with the witness (to, validAfter) once Permit2 may move the amount", async () => {
    const { req, built, signer } = await pay("USDT", "permit2-exact");
    const sent = decodeHeader(built.headerValue);
    const auth = sent.payload.permit2Authorization;
    expect(sent.accepted).toEqual(req);
    expect(auth).toMatchObject({
      permitted: { token: asset("USDT").address, amount: PRICE_UNITS },
      from: signer.address,
      spender: getAddress(SPENDER),
      deadline: String(NOW_S + 600n),
      witness: { to: PAY_TO, validAfter: String(NOW_S - 5n) },
    });
    expect(auth.nonce).toMatch(/^[1-9][0-9]*$/);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "Permit2", chainId: 56, verifyingContract: PERMIT2_ADDRESS },
      types: {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "Witness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        Witness: [
          { name: "to", type: "address" },
          { name: "validAfter", type: "uint256" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
        spender: auth.spender,
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
        witness: { to: auth.witness.to, validAfter: BigInt(auth.witness.validAfter) },
      },
      signature: sent.payload.signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it("asks for a Permit2 approval of exactly the amount, and signs nothing, when the allowance is short", async () => {
    const signs = { count: 0 };
    const signer = localSigner(generatePrivateKey(), signs);
    const reads: unknown[][] = [];
    const req = requirement("USDT", "permit2-exact");
    const built = await buildPayment({ signer, publicClient: buyerClient(BigInt(PRICE_UNITS) - 1n, 56, reads) }, req, RESOURCE);
    expect(built).toEqual({ headerValue: "", needsPermit2Approval: { token: asset("USDT").address, spender: PERMIT2_ADDRESS, amount: BigInt(PRICE_UNITS) } });
    expect(reads).toEqual([[signer.address, PERMIT2_ADDRESS]]);
    expect(signs.count).toBe(0);
  });

  it("takes the payment window from the latest block, never the device clock, and refuses when the block cannot be read", async () => {
    // The chain is 10 minutes ahead of this device: a device-clock window would not be valid yet.
    const deviceSeconds = BigInt(Math.floor(Date.now() / 1000));
    const blockTime = deviceSeconds + 600n;
    for (const [symbol, method] of [["U", "eip3009"], ["USDT", "permit2-exact"]] as const) {
      const signer = localSigner();
      const built = await buildPayment({ signer, publicClient: buyerClient(maxUint256, 56, [], blockTime) }, requirement(symbol, method), RESOURCE);
      const sent = decodeHeader(built.headerValue).payload;
      const auth = sent.authorization ?? sent.permit2Authorization;
      expect(auth.validAfter ?? auth.witness.validAfter).toBe(String(blockTime - 5n));
      expect(auth.validBefore ?? auth.deadline).toBe(String(blockTime + 600n));
    }
    const signs = { count: 0 };
    for (const failing of [buyerClient(maxUint256, 56, [], new Error("node down")), buyerClient(maxUint256, 56, [], 0n)]) {
      await expect(buildPayment({ signer: localSigner(generatePrivateKey(), signs), publicClient: failing }, requirement("U", "eip3009"), RESOURCE)).rejects.toThrow(
        "could not read the time from BNB Smart Chain",
      );
    }
    expect(signs.count).toBe(0);
  });

  it("refuses a permit2-exact request naming any spender but b402's pinned one, before reading the allowance or calling signTypedData", async () => {
    const signs = { count: 0 };
    const reads: unknown[][] = [];
    const deps = { signer: localSigner(generatePrivateKey(), signs), publicClient: buyerClient(maxUint256, 56, reads) };
    const usdt = requirement("USDT", "permit2-exact");
    for (const spender of ["0x8c819E6De3df83E0e87bBE7651c5D4e83229b239", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", PERMIT2_ADDRESS]) {
      const foreign = { ...usdt, extra: { ...usdt.extra, spenderAddress: spender } };
      await expect(buildPayment(deps, foreign, RESOURCE)).rejects.toThrow(PaymentRequestError);
    }
    expect(signs.count).toBe(0);
    expect(reads).toEqual([]);
    const pinned = { ...usdt, extra: { ...usdt.extra, spenderAddress: SPENDER.toLowerCase() } };
    expect((await buildPayment(deps, pinned, RESOURCE)).headerValue).not.toBe("");
    expect(signs.count).toBe(1);
  });

  it("refuses a wallet that signs with another key, a request it will not pay, a bad resource URL or a node on another chain", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const lying: WalletSigner = { ...localSigner(), signTypedData: (d) => other.signTypedData(d) };
    const deps = { signer: localSigner(), publicClient: buyerClient(maxUint256) };
    await expect(buildPayment({ ...deps, signer: lying }, requirement("U", "eip3009"), RESOURCE)).rejects.toThrow(PaymentRequestError);
    await expect(buildPayment({ ...deps, signer: { ...lying, signTypedData: async () => "0x1234" } }, requirement("U", "eip3009"), RESOURCE)).rejects.toThrow(PaymentRequestError);
    const upto = { ...requirement("USDT", "permit2-exact"), scheme: "upto" } as unknown as PaymentRequirementsV2;
    await expect(buildPayment(deps, upto, RESOURCE)).rejects.toThrow(PaymentRequestError);
    for (const url of ["http://moi.example/api/wrap/7", "https://moi.example/api/wrap/7#x", "https://a:b@moi.example/api/wrap/7", "not a url"]) {
      await expect(buildPayment(deps, requirement("U", "eip3009"), url)).rejects.toThrow(PaymentRequestError);
    }
    for (const [symbol, method] of [["U", "eip3009"], ["USDT", "permit2-exact"]] as const) {
      await expect(buildPayment({ ...deps, publicClient: buyerClient(maxUint256, 97) }, requirement(symbol, method), RESOURCE)).rejects.toThrow(PaymentRequestError);
    }
  });
});

describe("permit2ApprovalTx", () => {
  it("approves Permit2 for exactly the amount on a wrap asset, and nothing else", () => {
    const token = asset("USDT").address;
    expect(permit2ApprovalTx({ token, spender: PERMIT2_ADDRESS, amount: 5n })).toEqual({
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, 5n] }),
      value: 0n,
    });
    const refused = [
      { token, spender: PERMIT2_ADDRESS, amount: maxUint256 },
      { token, spender: PERMIT2_ADDRESS, amount: 0n },
      { token, spender: getAddress(SPENDER), amount: 5n },
      { token: getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436"), spender: PERMIT2_ADDRESS, amount: 5n },
    ];
    for (const approval of refused) expect(() => permit2ApprovalTx(approval)).toThrow(PaymentRequestError);
  });
});

// wrap.ts exports no decoder of its own, so this is a copy of its paymentPayloadSchema, field for
// field. The handleWrap test below runs the real decoder as well, through the exported handler.
const addressText = z.string().refine((a) => isAddress(a));
const uintText = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const signatureText = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const mirroredPaymentPayloadSchema = z.strictObject({
  x402Version: z.literal(2),
  resource: z.strictObject({ url: z.string().max(2_048), description: z.string().max(256).optional(), mimeType: z.string().max(128).optional() }).optional(),
  accepted: z.strictObject({
    scheme: z.string().max(16),
    network: z.string().max(32),
    amount: uintText,
    asset: addressText,
    payTo: addressText,
    maxTimeoutSeconds: z.number().int().min(1).max(86_400),
    extra: z.record(z.string().max(64), z.unknown()),
  }),
  payload: z.union([
    z.strictObject({
      signature: signatureText,
      authorization: z.strictObject({ from: addressText, to: addressText, value: uintText, validAfter: uintText, validBefore: uintText, nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
    }),
    z.strictObject({
      signature: signatureText,
      permit2Authorization: z.strictObject({
        permitted: z.strictObject({ token: addressText, amount: uintText }),
        from: addressText,
        spender: addressText,
        nonce: uintText,
        deadline: uintText,
        witness: z.strictObject({ to: addressText, validAfter: uintText, facilitator: z.null().optional() }),
      }),
    }),
  ]),
  extensions: z.strictObject({}).optional(),
});

describe("every payment buildPayment makes is one wrap.ts accepts", () => {
  const all: [string, "eip3009" | "permit2-exact"][] = [
    ["U", "eip3009"],
    ["USD1", "eip3009"],
    ["U", "permit2-exact"],
    ["USD1", "permit2-exact"],
    ["USDT", "permit2-exact"],
    ["USDC", "permit2-exact"],
  ];

  it("passes a copy of wrap.ts's payment schema", async () => {
    for (const [symbol, method] of all) {
      const { built } = await pay(symbol, method);
      expect(mirroredPaymentPayloadSchema.safeParse(decodeHeader(built.headerValue)).success).toBe(true);
      expect(built.headerValue.length).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it("gets through handleWrap's real decoder and requirement match to b402 verify, as the very object sent", async () => {
    for (const [symbol, method] of all) {
      const server = wrapServer(false);
      const first = await server.handle(null);
      const offered = decodePaymentRequired(first.headers![PAYMENT_REQUIRED_HEADER]!);
      const chosen = offered.accepts.find((r) => r.asset === asset(symbol).address && r.extra.assetTransferMethod === method)!;
      const built = await buildPayment({ signer: localSigner(), publicClient: buyerClient(maxUint256) }, chosen, offered.resource!.url);
      const res = await server.handle(built.headerValue);
      // payment_invalid is the fake verify's answer; a decode or match failure would be payment_malformed or payment_mismatch.
      expect(res.body).toMatchObject({ error: "payment_invalid" });
      expect(server.verified).toEqual([{ body: { x402Version: 2, paymentPayload: decodeHeader(built.headerValue), paymentRequirements: chosen } }]);
    }
  });
});
