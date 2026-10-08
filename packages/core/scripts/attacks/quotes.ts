// Attacks on POST /api/quote, GET /api/stocks and the route table, through route().
import { createWalletClient, encodeFunctionData, http, maxUint256, parseAbi, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { EXPECTED_ROUTER } from "../../src/checks.js";
import { createStocksCache } from "../../src/stocks.js";
import { Web3ApiError } from "../../src/web3api.js";
import { NVDAB, TSLAB, USDT, type Fork } from "./fork.js";
import { FIXTURE, type Server } from "./server.js";
import { freshAddress, verdict, type Attack } from "./verdict.js";

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const ONE_USDT = parseUnits("1", 18);
const UPSTREAM_SECRET = "upstream-secret-detail-7f3a91";

function approvalAnswer(spender: `0x${string}`, amount: bigint) {
  const [recorded] = FIXTURE.approve;
  return [{ ...recorded, data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [spender, amount] }) }];
}

export function quoteAttacks(fork: Fork, server: Server): Attack[] {
  const quote = (wallet: string, ip: string, extra: { stock?: string; country?: string | null } = {}) =>
    server.send({ method: "POST", path: "/api/quote", ip, country: extra.country, body: JSON.stringify({ stock: extra.stock ?? NVDAB, usdAmount: "1", wallet }) });
  const stocksWithFreshCache = () => ({ ...server.deps, getStocks: createStocksCache() });

  return [
    {
      id: "C21",
      attack: "quote whose upstream approval is unlimited",
      run: async () => {
        server.plan.approve = approvalAnswer(EXPECTED_ROUTER, maxUint256);
        try {
          const calls = server.upstreamCalls.length;
          const res = await quote(freshAddress(), "203.0.113.71");
          return verdict("422 quote_refused before any swap was fetched", [
            [res.status === 422 && res.json.error === "quote_refused", `answered ${res.status} ${String(res.json.error)}`],
            [server.upstreamCalls.slice(calls).includes("/api/v1/dex/aggregator/approve-transaction"), "the approval was never fetched, so the check proves nothing"],
            [!server.upstreamCalls.slice(calls).includes("/api/v1/dex/aggregator/swap"), "a swap was fetched after the approval"],
          ]);
        } finally {
          server.plan.approve = FIXTURE.approve;
        }
      },
    },
    {
      id: "C21",
      attack: "quote whose upstream approval names a foreign spender",
      run: async () => {
        server.plan.approve = approvalAnswer(freshAddress(), ONE_USDT);
        try {
          const res = await quote(freshAddress(), "203.0.113.72");
          return verdict("422 quote_refused", [[res.status === 422 && res.json.error === "quote_refused", `answered ${res.status} ${String(res.json.error)}`]]);
        } finally {
          server.plan.approve = FIXTURE.approve;
        }
      },
    },
    {
      id: "C33",
      attack: "quote whose swap simulation sends the stock to someone else",
      run: async () => {
        // A wallet that already approved the router, so the quote goes past the approval step to the swap.
        const wallet = privateKeyToAccount(generatePrivateKey());
        await fork.test.setBalance({ address: wallet.address, value: 10n ** 17n });
        const client = createWalletClient({ account: wallet, chain: bsc, transport: http(fork.rpc) });
        await fork.mined(await client.writeContract({ address: USDT, abi: approveAbi, functionName: "approve", args: [EXPECTED_ROUTER, ONE_USDT] }));
        const swap = structuredClone(FIXTURE.swap);
        swap.tx.from = wallet.address;
        const expectedOut = (FIXTURE.quote[0] as { toTokenAmount: string }).toTokenAmount;
        server.plan.swap = swap;
        server.plan.simulation = {
          status: "SUCCESS",
          failReason: "",
          balanceChanges: [
            { contractAddress: NVDAB, tokenType: "Erc20", change: expectedOut, owner: freshAddress().toLowerCase() },
            { contractAddress: USDT, tokenType: "Erc20", change: (-ONE_USDT).toString(), owner: wallet.address.toLowerCase() },
          ],
          allowanceChanges: [],
        };
        try {
          const calls = server.upstreamCalls.length;
          const res = await quote(wallet.address, "203.0.113.73");
          return verdict("422 simulation_refused", [
            [server.upstreamCalls.slice(calls).includes("/api/v1/dex/pre-transaction/simulate"), "no simulation ran, so the check proves nothing"],
            [res.status === 422 && res.json.error === "simulation_refused", `answered ${res.status} ${String(res.json.error)}`],
          ]);
        } finally {
          server.plan.swap = FIXTURE.swap;
          server.plan.simulation = null;
        }
      },
    },
    {
      id: "C22",
      attack: "quote for TSLAB, a real bStock this vault does not list",
      run: async () => {
        const calls = server.upstreamCalls.length;
        const res = await quote(freshAddress(), "203.0.113.74", { stock: TSLAB });
        return verdict("400 not_listed, Web3 API never asked", [
          [res.status === 400 && res.json.error === "not_listed", `answered ${res.status} ${String(res.json.error)}`],
          [server.upstreamCalls.length === calls, "the Web3 API was called"],
        ]);
      },
    },
    {
      id: "C30",
      attack: "quote with no country from the hosting platform",
      run: async () => {
        const res = await quote(freshAddress(), "203.0.113.75", { country: null });
        return verdict("403 unknown_place", [[res.status === 403 && res.json.error === "unknown_place", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C19",
      attack: "quote while the Web3 API fails with secret detail in its error",
      run: async () => {
        server.plan.quoteFault = new Web3ApiError("/api/v1/dex/aggregator/quote", 500, "50000", UPSTREAM_SECRET);
        try {
          const res = await quote(freshAddress(), "203.0.113.76");
          return verdict("502 upstream_unavailable, no upstream text in the answer or the log", [
            [res.status === 502 && res.json.error === "upstream_unavailable", `answered ${res.status} ${String(res.json.error)}`],
            [!JSON.stringify(res).includes(UPSTREAM_SECRET) && !server.logLines.join("\n").includes(UPSTREAM_SECRET), "the upstream text leaked"],
          ]);
        } finally {
          server.plan.quoteFault = null;
        }
      },
    },
    {
      id: "C20",
      attack: "six crafted paths: dot segments, hex id, leading zero, query, encoded slash, a store key",
      run: async () => {
        const paths = ["/api/gift/1/../../stocks", "/api/gift/0x01", "/api/gift/01", "/api/stocks?x=1", "/api/wrap/1%2F..%2Fquote", "/api/wrap/1:moi:v1:56"];
        const answers = await Promise.all(paths.map((path, i) => server.send({ method: path.startsWith("/api/wrap") ? "POST" : "GET", path, ip: `203.0.113.${80 + i}` })));
        return verdict("404 not_found for all six", [[answers.every((a) => a.status === 404 && a.json.error === "not_found"), `answered ${answers.map((a) => a.status).join(",")}`]]);
      },
    },
    {
      id: "C14",
      attack: "stock list whose upstream logo is javascript:, plain http, a lookalike host or a foreign host",
      run: async () => {
        const bad = ["javascript:alert(document.domain)", "http://bin.bnbstatic.com/x.png", "https://bnbstatic.com.evil.example/x.png", "https://evil.example/x.png"];
        const logos: unknown[] = [];
        for (const [i, url] of bad.entries()) {
          server.plan.logoUrl = url;
          const res = await server.send({ method: "GET", path: "/api/stocks", ip: `203.0.113.${90 + i}` }, stocksWithFreshCache());
          logos.push((res.json.stocks as { logoUrl: unknown }[] | undefined)?.[0]?.logoUrl);
        }
        server.plan.logoUrl = "https://bin.bnbstatic.com/image/nvdab.png";
        const control = await server.send({ method: "GET", path: "/api/stocks", ip: "203.0.113.94" }, stocksWithFreshCache());
        server.plan.logoUrl = null;
        return verdict("logoUrl null for all four", [
          [(control.json.stocks as { logoUrl: unknown }[] | undefined)?.[0]?.logoUrl === "https://bin.bnbstatic.com/image/nvdab.png", "a good logo was dropped too, so the check proves nothing"],
          [logos.every((l) => l === null), `kept ${logos.filter((l) => l !== null).length} bad logos`],
        ]);
      },
    },
    {
      id: "C23",
      attack: "twenty stock-list requests from twenty addresses",
      run: async () => {
        const deps = stocksWithFreshCache();
        const before = server.upstreamCalls.filter((p) => p === "/api/v1/dex/market/rwa/tokens").length;
        const answers = [];
        for (let i = 0; i < 20; i += 1) answers.push(await server.send({ method: "GET", path: "/api/stocks", ip: `198.51.100.${100 + i}` }, deps));
        const asked = server.upstreamCalls.filter((p) => p === "/api/v1/dex/market/rwa/tokens").length - before;
        return verdict("the Web3 API was asked once; 19 answers came from the 60-second cache", [
          [answers.every((a) => a.status === 200), `answered ${[...new Set(answers.map((a) => a.status))].join(",")}`],
          [asked === 1, `the Web3 API was asked ${asked} times`],
        ]);
      },
    },
  ];
}
