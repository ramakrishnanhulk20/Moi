// Attacks on POST /api/wrap/:id (the b402 wrapping fee) and on the website's own payer, through route().
import { createPublicClient, custom, getAddress, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { decodePaymentRequired, pickRequirement, WRAP_FEE_CEILING_USD } from "../../src/client/x402.js";
import { signClaim } from "../../src/gift.js";
import { isWrapped, WRAP_ASSETS, type PaymentRequirementsV2 } from "../../src/wrap.js";
import type { Fork, Gift } from "./fork.js";
import { ORIGIN, PAYOUT, type Server } from "./server.js";
import { freshAddress, verdict, type Attack } from "./verdict.js";

/** Gifts from a sender who is not the sponsor, so each one needs its wrapping fee paid. */
export type WrapGifts = { paid: Gift; oldHash: Gift; paidNothing: Gift; replayed: Gift; tampered: Gift };

type Challenge = { requirement: PaymentRequirementsV2; resource: { url: string }; header: string };

function nonce(): Hex {
  return `0x${Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
}

// A payment payload in the shape wrap.ts decodes. b402 is a fake here, so the signature is filler:
// these attacks target what Moi itself checks before and after b402.
function paymentHeader(
  fork: Fork,
  c: Challenge,
  opts: { nonce: Hex; accepted?: Partial<PaymentRequirementsV2>; to?: Address; value?: string; withResource?: boolean },
): string {
  const accepted = { ...c.requirement, ...(opts.accepted ?? {}) };
  const payment = {
    x402Version: 2,
    ...(opts.withResource === false ? {} : { resource: c.resource }),
    accepted,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: fork.payer.address,
        to: opts.to ?? accepted.payTo,
        value: opts.value ?? accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 120),
        nonce: opts.nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
}

// A node that answers everything as the fork does but says it serves chain 97.
function chain97Client(fork: Fork): PublicClient {
  return createPublicClient({
    chain: bsc,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_chainId") return "0x61";
        const res = await fetch(fork.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const reply = (await res.json()) as { result?: unknown; error?: unknown };
        if (reply.error !== undefined) throw new Error("rpc error");
        return reply.result;
      },
    }),
  }) as PublicClient;
}

export function wrapAttacks(fork: Fork, server: Server, gifts: WrapGifts): Attack[] {
  const wrap = (gift: Gift, ip: string, header?: string, extra: Record<string, string> = {}) =>
    server.send({ method: "POST", path: `/api/wrap/${gift.giftId}`, ip, headers: header === undefined ? extra : { ...extra, "PAYMENT-SIGNATURE": header } });
  const challenge = async (gift: Gift, ip: string): Promise<Challenge> => {
    const res = await wrap(gift, ip);
    const accepts = res.json.accepts as PaymentRequirementsV2[] | undefined;
    const header = res.headers["PAYMENT-REQUIRED"];
    const requirement = accepts?.[0];
    if (res.status !== 402 || requirement === undefined || header === undefined) throw new Error(`the 402 challenge failed: ${res.status}`);
    return { requirement, resource: res.json.resource as { url: string }, header };
  };
  const wrapped = (gift: Gift) => isWrapped(server.deps.store, fork.vault, gift.giftId);

  // The honest payment every replay below reuses. Not an attack: if it fails, the attacks prove nothing.
  let honest: { header: string; txHash: Hex } | null = null;
  const honestPayment = async () => {
    if (honest !== null) return honest;
    server.plan.settle = { mode: "pay" };
    const c = await challenge(gifts.paid, "203.0.113.51");
    const header = paymentHeader(fork, c, { nonce: nonce() });
    const res = await wrap(gifts.paid, "203.0.113.51", header);
    if (res.status !== 200 || res.json.wrapped !== true || typeof res.json.txHash !== "string") throw new Error(`the honest wrap payment failed: ${res.status} ${String(res.json.error)}`);
    honest = { header, txHash: res.json.txHash as Hex };
    return honest;
  };

  return [
    {
      id: "C44",
      attack: "the facilitator answers a second gift's payment with the first gift's settlement",
      run: async () => {
        const first = await honestPayment();
        const c = await challenge(gifts.oldHash, "203.0.113.52");
        server.plan.settle = { mode: "answer", hash: first.txHash };
        try {
          const res = await wrap(gifts.oldHash, "203.0.113.52", paymentHeader(fork, c, { nonce: nonce() }));
          return verdict("502 settlement_unexpected, second gift not wrapped", [
            [res.status === 502 && res.json.error === "settlement_unexpected", `answered ${res.status} ${String(res.json.error)}`],
            [!(await wrapped(gifts.oldHash)), "the second gift was marked wrapped"],
            [await wrapped(gifts.paid), "the first gift lost its mark"],
          ]);
        } finally {
          server.plan.settle = { mode: "pay" };
        }
      },
    },
    {
      id: "C42",
      attack: "the facilitator reports success for a transaction that paid Moi nothing",
      run: async () => {
        const c = await challenge(gifts.paidNothing, "203.0.113.53");
        server.plan.settle = { mode: "answer", hash: gifts.paidNothing.createTx };
        try {
          const res = await wrap(gifts.paidNothing, "203.0.113.53", paymentHeader(fork, c, { nonce: nonce() }));
          return verdict("502 settlement_unexpected, gift not wrapped", [
            [res.status === 502 && res.json.error === "settlement_unexpected", `answered ${res.status} ${String(res.json.error)}`],
            [!(await wrapped(gifts.paidNothing)), "the gift was marked wrapped"],
          ]);
        } finally {
          server.plan.settle = { mode: "pay" };
        }
      },
    },
    {
      id: "C42",
      attack: "one settled wrap payment replayed, unchanged, for a second gift",
      run: async () => {
        const first = await honestPayment();
        const calls = server.upstreamCalls.length;
        const res = await wrap(gifts.replayed, "203.0.113.54", first.header);
        return verdict("402 payment_mismatch (it names the first gift), b402 never asked", [
          [res.status === 402 && res.json.error === "payment_mismatch", `answered ${res.status} ${String(res.json.error)}`],
          [!server.upstreamCalls.slice(calls).some((p) => p.endsWith("/verify") || p.endsWith("/settle")), "b402 was asked to verify or settle"],
          [!(await wrapped(gifts.replayed)), "the second gift was marked wrapped"],
        ]);
      },
    },
    {
      id: "C42",
      attack: "the same payment replayed for a second gift with its resource field stripped",
      run: async () => {
        const first = await honestPayment();
        const c = await challenge(gifts.replayed, "203.0.113.55");
        const firstPayment = JSON.parse(Buffer.from(first.header, "base64").toString("utf8")) as { payload: { authorization: { nonce: Hex } } };
        const header = paymentHeader(fork, c, { nonce: firstPayment.payload.authorization.nonce, withResource: false });
        const calls = server.upstreamCalls.length;
        const res = await wrap(gifts.replayed, "203.0.113.55", header);
        return verdict("402 payment_reused, b402 never asked", [
          [res.status === 402 && res.json.error === "payment_reused", `answered ${res.status} ${String(res.json.error)}`],
          [!server.upstreamCalls.slice(calls).some((p) => p.endsWith("/verify") || p.endsWith("/settle")), "b402 was asked to verify or settle"],
          [!(await wrapped(gifts.replayed)), "the second gift was marked wrapped"],
        ]);
      },
    },
    {
      id: "C24",
      attack: "wrap payment that pays another address (in the accepted terms, and in the signed transfer only)",
      run: async () => {
        const c = await challenge(gifts.tampered, "203.0.113.56");
        const thief = freshAddress();
        const inTerms = await wrap(gifts.tampered, "203.0.113.56", paymentHeader(fork, c, { nonce: nonce(), accepted: { payTo: thief } }));
        const inTransfer = await wrap(gifts.tampered, "203.0.113.56", paymentHeader(fork, c, { nonce: nonce(), to: thief }));
        return verdict("402 payment_mismatch twice", [
          [inTerms.status === 402 && inTerms.json.error === "payment_mismatch", `accepted terms: ${inTerms.status} ${String(inTerms.json.error)}`],
          [inTransfer.status === 402 && inTransfer.json.error === "payment_mismatch", `signed transfer: ${inTransfer.status} ${String(inTransfer.json.error)}`],
        ]);
      },
    },
    {
      id: "C24",
      attack: "wrap payment of 0.01 U where the price is 0.05",
      run: async () => {
        const c = await challenge(gifts.tampered, "203.0.113.57");
        const low = parseUnits("0.01", 18).toString();
        const res = await wrap(gifts.tampered, "203.0.113.57", paymentHeader(fork, c, { nonce: nonce(), accepted: { amount: low } }));
        return verdict("402 payment_mismatch", [[res.status === 402 && res.json.error === "payment_mismatch", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C24",
      attack: "402 asked for with forged Host, X-Forwarded-Host and Origin headers",
      run: async () => {
        const forged = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", origin: "https://evil.example", forwarded: "host=evil.example" };
        const res = await wrap(gifts.tampered, "203.0.113.58", undefined, forged);
        const accepts = (res.json.accepts as PaymentRequirementsV2[] | undefined) ?? [];
        const resource = (res.json.resource as { url?: string } | undefined)?.url;
        return verdict("payee and resource unchanged, built from config", [
          [res.status === 402 && accepts.length > 0, `answered ${res.status}`],
          [accepts.every((a) => getAddress(a.payTo) === PAYOUT), "a requirement names another payee"],
          [resource === `${ORIGIN}/api/wrap/${gifts.tampered.giftId}`, `the resource is ${String(resource)}`],
          [!`${res.text} ${Buffer.from(res.headers["PAYMENT-REQUIRED"] ?? "", "base64").toString("utf8")}`.includes("evil.example"), "the forged host reached the answer"],
        ]);
      },
    },
    {
      id: "C24",
      attack: "claim of a gift whose wrapping fee was never paid",
      run: async () => {
        const recipient = freshAddress();
        const signature = await signClaim(gifts.tampered.key, fork.vault, 56, gifts.tampered.giftId, recipient);
        const res = await server.send({ method: "POST", path: "/api/claim", ip: "203.0.113.59", body: JSON.stringify({ giftId: gifts.tampered.giftId.toString(), recipient, signature, declaration: true }) });
        return verdict("402 gift_not_wrapped", [[res.status === 402 && res.json.error === "gift_not_wrapped", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C27",
      attack: "a 402 asking 5 USD, or paying another address, read by the website's payer",
      run: async () => {
        const c = await challenge(gifts.tampered, "203.0.113.60");
        const read = (header: string) => pickRequirement(decodePaymentRequired(header).accepts, { payTo: PAYOUT, maxUsd: WRAP_FEE_CEILING_USD, assets: WRAP_ASSETS, prefer: "eip3009-first" });
        const tamper = (change: (r: PaymentRequirementsV2) => void) => {
          const body = JSON.parse(Buffer.from(c.header, "base64").toString("utf8")) as { accepts: PaymentRequirementsV2[] };
          body.accepts.forEach(change);
          return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
        };
        const pricey = read(tamper((r) => (r.amount = parseUnits("5", 18).toString())));
        const elsewhere = read(tamper((r) => (r.payTo = freshAddress())));
        return verdict("no requirement picked, nothing signed", [
          [read(c.header) !== null, "the honest 402 was not payable either, so the check proves nothing"],
          [pricey === null, "the 5 USD requirement was picked"],
          [elsewhere === null, "the requirement paying another address was picked"],
        ]);
      },
    },
    {
      id: "C45",
      attack: "wrap through a node that reports chain 97",
      run: async () => {
        const res = await server.send({ method: "POST", path: `/api/wrap/${gifts.tampered.giftId}`, ip: "203.0.113.61" }, { ...server.deps, client: chain97Client(fork) });
        return verdict("502 chain_unavailable", [[res.status === 502 && res.json.error === "chain_unavailable", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
  ];
}
