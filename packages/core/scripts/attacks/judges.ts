// Attacks on POST /api/judge, the free judge gifts, through route(). The pool is two real gifts on
// the fork whose claim keys come from this run's judge seed, as the live pool's come from Ram's.
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { judgeWalletMessage } from "../../src/judge-message.js";
import type { Fork } from "./fork.js";
import { JUDGE_CODE, type Server } from "./server.js";
import { verdict, type Attack } from "./verdict.js";

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// The body a judge's page sends. The access token stands in for Privy's: the fake verifier reads it
// as the user id. The wallet is fresh and signs the exact message judge.ts checks.
async function judgeBody(userId: string, opts: { judgeCode?: string; issuedAtMs?: number } = {}) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const issuedAt = stamp(opts.issuedAtMs ?? Date.now() - 5_000);
  const walletProof = await wallet.signMessage({ message: judgeWalletMessage({ recipient: wallet.address, userId, issuedAt }) });
  return JSON.stringify({ accessToken: userId, recipient: wallet.address, walletProof, issuedAt, judgeCode: opts.judgeCode ?? JUDGE_CODE, declaration: true });
}

export function judgeAttacks(fork: Fork, server: Server): Attack[] {
  const ask = (body: string, ip: string) => server.send({ method: "POST", path: "/api/judge", body, ip });
  const judgeA = "did:privy:attackrunjudgea";
  const judgeB = "did:privy:attackrunjudgeb";
  server.identities.push(judgeA, judgeB);

  // Judge A's honest claim, which the next two attacks try to repeat. Not an attack itself.
  let first: Hex | null = null;
  const firstGift = async () => {
    if (first !== null) return first;
    const res = await ask(await judgeBody(judgeA), "203.0.113.41");
    if (res.status !== 200 || typeof res.json.txHash !== "string") throw new Error(`the honest judge claim failed: ${res.status} ${String(res.json.error)}`);
    const hash = res.json.txHash as Hex;
    first = hash;
    await fork.mined(hash);
    return hash;
  };

  return [
    {
      id: "C26",
      attack: "judge gift asked for with a wrong judge code",
      run: async () => {
        const res = await ask(await judgeBody("did:privy:attackrunguesser", { judgeCode: "MOI-2222-3333" }), "203.0.113.40");
        return verdict("403 bad_judge_code", [[res.status === 403 && res.json.error === "bad_judge_code", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C26",
      attack: "judge wallet proof issued 10 minutes ago",
      run: async () => {
        const res = await ask(await judgeBody("did:privy:attackrunlate", { issuedAtMs: Date.now() - 10 * 60_000 }), "203.0.113.40");
        return verdict("401 proof_expired", [[res.status === 401 && res.json.error === "proof_expired", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C26",
      attack: "the same judge asks for a second gift, with a new wallet from another network",
      run: async () => {
        await firstGift();
        const res = await ask(await judgeBody(judgeA), "203.0.113.42");
        return verdict("409 already_claimed", [[res.status === 409 && res.json.error === "already_claimed", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C26",
      attack: "a second judge asks from the same network on the same day",
      run: async () => {
        await firstGift();
        const res = await ask(await judgeBody(judgeB), "203.0.113.41");
        return verdict("429 too_many_from_network", [[res.status === 429 && res.json.error === "too_many_from_network", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
  ];
}
