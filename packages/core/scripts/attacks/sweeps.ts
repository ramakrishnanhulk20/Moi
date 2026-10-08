// Checks run after every attack, over everything the run produced: what the relayer key signed,
// what left the server, and what the store kept.
import { createHash } from "node:crypto";
import { getAddress, slice, toFunctionSelector } from "viem";
import { giftVaultAbi } from "../../src/generated/giftVaultAbi.js";
import type { Fork } from "./fork.js";
import { JUDGE_CODE, type Server } from "./server.js";
import { verdict, type Attack } from "./verdict.js";

const claimFunction = giftVaultAbi.find((item) => item.type === "function" && item.name === "claim");
if (claimFunction === undefined) throw new Error("The generated GiftVault ABI has no claim function.");
const CLAIM_SELECTOR = toFunctionSelector(claimFunction);

export function sweepAttacks(fork: Fork, server: Server): Attack[] {
  return [
    {
      id: "C17",
      attack: "every transaction the relayer key signed during the run, checked for anything but vault.claim",
      run: async () => {
        const relayer = getAddress(fork.relayer.address);
        const latest = await fork.client.getBlockNumber();
        let claims = 0;
        const other: string[] = [];
        for (let n = fork.forkBlock + 1n; n <= latest; n += 1n) {
          const block = await fork.client.getBlock({ blockNumber: n, includeTransactions: true });
          for (const tx of block.transactions) {
            if (getAddress(tx.from) !== relayer) continue;
            const isClaim = tx.to !== null && getAddress(tx.to) === fork.vault && tx.value === 0n && tx.input.length >= 10 && slice(tx.input, 0, 4) === CLAIM_SELECTOR && tx.chainId === 56;
            if (isClaim) claims += 1;
            else other.push(tx.hash);
          }
        }
        const nonce = await fork.client.getTransactionCount({ address: relayer });
        return verdict(`nothing else: ${claims} of ${claims} were vault.claim with no value on chain 56`, [
          [claims > 0, "the relayer sent no claims, so the check proves nothing"],
          [other.length === 0, `${other.length} relayer transactions were not vault claims`],
          [nonce === claims, `the relayer's nonce is ${nonce} but only ${claims} claims were seen`],
        ]);
      },
    },
    {
      id: "C19",
      attack: "every response and log line of the run searched for the relayer key, judge seed, claim keys and judge code",
      run: async () => {
        const haystack = [...server.responses.map((r) => `${r.status} ${JSON.stringify(r.headers)} ${r.body}`), ...server.logLines].join("\n").toLowerCase();
        // The code's two groups are searched joined, never alone: four characters can turn up by chance
        // inside a long base64 payment header and would give a false hit.
        const code = JUDGE_CODE.toLowerCase();
        const needles = [...fork.secrets.map((s) => s.toLowerCase().replace(/^0x/, "")), code, code.replace(/-/g, ""), code.split("-").slice(1).join("-")];
        const hits = needles.filter((n) => haystack.includes(n)).length;
        return verdict(`0 hits for ${needles.length} secrets in ${server.responses.length} responses and ${server.logLines.length} log lines`, [
          [server.responses.length > 0 && server.logLines.length > 0, "nothing was recorded, so the search proves nothing"],
          [hits === 0, `${hits} secrets found`],
        ]);
      },
    },
    {
      id: "C46",
      attack: "every store key and value written during the run searched for client addresses and judge ids, plain or SHA-256",
      run: async () => {
        const haystack = server.storeWrites.join("\n").toLowerCase();
        const plain = [...new Set(server.identities)];
        const needles = plain.flatMap((p) => [p.toLowerCase(), createHash("sha256").update(p).digest("hex")]);
        const hits = needles.filter((n) => haystack.includes(n)).length;
        return verdict(`0 hits for ${plain.length} identities in ${server.storeWrites.length} store writes`, [
          [haystack.includes("ratelimit") && haystack.includes("judgeuser"), "no rate-limit or judge marks were written, so the search proves nothing"],
          [hits === 0, `${hits} identities found in the store`],
        ]);
      },
    },
  ];
}
