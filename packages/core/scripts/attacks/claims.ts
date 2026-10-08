// Attacks on POST /api/claim, GET /api/gift and the claim page's own code, all through route().
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { claimGift, loadGift } from "../../src/client/claim.js";
import { LinkError, newClaimKey, openNote, signClaim } from "../../src/gift.js";
import { keys } from "../../src/store.js";
import { readGift } from "../../src/vault.js";
import { USDT, type Fork, type Gift } from "./fork.js";
import { ORIGIN, type Server } from "./server.js";
import { freshAddress, verdict, type Attack } from "./verdict.js";

export const NOTE_TEXT = "Happy Diwali from the attack run";

/** One gift per attack that changes a gift's state, so no attack leans on another's leftovers. */
export type ClaimGifts = { open: Gift; blocked: Gift; replayed: Gift; raced: Gift; noted: Gift; flow: Gift; expiring: Gift };

async function claimBody(fork: Fork, gift: Gift, recipient: `0x${string}`, overrides: { key?: Hex; giftIdText?: string } = {}): Promise<string> {
  const signature = await signClaim(overrides.key ?? gift.key, fork.vault, 56, gift.giftId, recipient);
  return JSON.stringify({ giftId: overrides.giftIdText ?? gift.giftId.toString(), recipient, signature, declaration: true });
}

const relayerNonce = (fork: Fork) => fork.client.getTransactionCount({ address: fork.relayer.address });

// Starts the attack at the top of a fresh minute when fewer than five seconds are left, so 31
// requests can never straddle two rate-limit windows.
async function freshMinute(): Promise<void> {
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 55_000) await new Promise((r) => setTimeout(r, 60_000 - intoMinute + 250));
}

export function claimAttacks(fork: Fork, server: Server, gifts: ClaimGifts): Attack[] {
  const post = (body: string | null, ip: string, extra: { country?: string | null; headers?: Record<string, string> } = {}) =>
    server.send({ method: "POST", path: "/api/claim", body, ip, ...extra });

  return [
    {
      id: "C36",
      attack: "claim signed by a key that is not the gift's",
      run: async () => {
        const nonce = await relayerNonce(fork);
        const wrong = newClaimKey();
        fork.secrets.push(wrong.privateKey);
        const res = await post(await claimBody(fork, gifts.open, freshAddress(), { key: wrong.privateKey }), "203.0.113.11");
        const lock = await server.deps.store.get(keys.claimLock(fork.vault, gifts.open.giftId));
        return verdict("400 bad_signature, no claim lock taken, relayer sent nothing", [
          [res.status === 400 && res.json.error === "bad_signature", `answered ${res.status} ${String(res.json.error)}`],
          [lock === null, "a claim lock was taken"],
          [(await relayerNonce(fork)) === nonce, "the relayer sent a transaction"],
        ]);
      },
    },
    {
      id: "C16",
      attack: "valid claim to a contract recipient (the USDT token contract)",
      run: async () => {
        const nonce = await relayerNonce(fork);
        const res = await post(await claimBody(fork, gifts.open, USDT), "203.0.113.12");
        return verdict("400 bad_recipient, relayer sent nothing", [
          [res.status === 400 && res.json.error === "bad_recipient", `answered ${res.status} ${String(res.json.error)}`],
          [(await relayerNonce(fork)) === nonce, "the relayer sent a transaction"],
        ]);
      },
    },
    {
      id: "C8",
      attack: "valid claim naming the vault itself as recipient",
      run: async () => {
        const res = await post(await claimBody(fork, gifts.open, fork.vault), "203.0.113.12");
        return verdict("400 bad_recipient", [[res.status === 400 && res.json.error === "bad_recipient", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C30",
      attack: "valid claim from the United States",
      run: async () => {
        const res = await post(await claimBody(fork, gifts.open, freshAddress()), "203.0.113.13", { country: "US" });
        return verdict("403 restricted_place", [[res.status === 403 && res.json.error === "restricted_place", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C25",
      attack: "claim whose gift id carries a store key (1:moi:v1:56:...:ratelimit)",
      run: async () => {
        const giftIdText = "1:moi:v1:56:0x0000000000000000000000000000000000000000:ratelimit";
        const res = await post(await claimBody(fork, gifts.open, freshAddress(), { giftIdText }), "203.0.113.13");
        return verdict("400 bad_gift_id", [[res.status === 400 && res.json.error === "bad_gift_id", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C49",
      attack: "claim body over 8 KB",
      run: async () => {
        const body = JSON.parse(await claimBody(fork, gifts.open, freshAddress())) as Record<string, unknown>;
        const res = await post(JSON.stringify({ ...body, pad: "a".repeat(9_000) }), "203.0.113.13");
        return verdict("413 body_too_large", [[res.status === 413 && res.json.error === "body_too_large", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
    {
      id: "C23",
      attack: "31 claim requests in a minute from one address, each with a new X-Forwarded-For",
      run: async () => {
        await freshMinute();
        const statuses: number[] = [];
        let retryAfter: string | undefined;
        for (let i = 0; i < 31; i += 1) {
          const res = await post(null, "198.51.100.23", { headers: { "x-forwarded-for": `10.0.${i}.${i + 1}` } });
          statuses.push(res.status);
          retryAfter = res.headers["Retry-After"];
        }
        return verdict("the 31st answered 429 rate_limited with Retry-After", [
          [statuses.slice(0, 30).every((s) => s === 400), `the first 30 answered ${[...new Set(statuses.slice(0, 30))].join(",")}`],
          [statuses[30] === 429 && retryAfter !== undefined, `the 31st answered ${statuses[30]}`],
        ]);
      },
    },
    {
      id: "C7",
      attack: "claim of a gift whose sender Binance has just blocklisted",
      run: async () => {
        await fork.setBlocked(fork.sponsor.address, true);
        try {
          const nonce = await relayerNonce(fork);
          const res = await post(await claimBody(fork, gifts.blocked, freshAddress()), "203.0.113.14");
          return verdict("409 sender_blocked, relayer sent nothing", [
            [res.status === 409 && res.json.error === "sender_blocked", `answered ${res.status} ${String(res.json.error)}`],
            [(await relayerNonce(fork)) === nonce, "the relayer sent a transaction"],
          ]);
        } finally {
          await fork.setBlocked(fork.sponsor.address, false);
        }
      },
    },
    {
      id: "C18",
      attack: "a landed claim sent again",
      run: async () => {
        const body = await claimBody(fork, gifts.replayed, freshAddress());
        const first = await post(body, "203.0.113.15");
        if (first.status !== 200 || typeof first.json.txHash !== "string") throw new Error(`the honest claim was refused: ${first.status} ${String(first.json.error)}`);
        await fork.mined(first.json.txHash as Hex);
        const nonce = await relayerNonce(fork);
        const again = await post(body, "203.0.113.16");
        return verdict("no second broadcast: 200 reused with the first hash, relayer nonce unchanged", [
          [again.status === 200 && again.json.reused === true && again.json.txHash === first.json.txHash, `answered ${again.status} reused=${String(again.json.reused)}`],
          [(await relayerNonce(fork)) === nonce, "the relayer sent a second transaction"],
        ]);
      },
    },
    {
      id: "C18",
      attack: "three identical claims raced at the same moment",
      run: async () => {
        const nonce = await relayerNonce(fork);
        const body = await claimBody(fork, gifts.raced, freshAddress());
        const answers = await Promise.all([21, 22, 23].map((n) => post(body, `203.0.113.${n}`)));
        const hashes = new Set(answers.map((a) => a.json.txHash));
        const fresh = answers.filter((a) => a.json.reused === false).length;
        const [hash] = [...hashes];
        if (typeof hash === "string") await fork.mined(hash as Hex);
        return verdict("one broadcast; all three answered 200 with the same hash", [
          [answers.every((a) => a.status === 200), `answered ${answers.map((a) => a.status).join(",")}`],
          [hashes.size === 1 && fresh === 1, `${hashes.size} hashes, ${fresh} fresh broadcasts`],
          [(await relayerNonce(fork)) === nonce + 1, "the relayer sent more than one transaction"],
        ]);
      },
    },
    {
      id: "C15",
      attack: "a real gift id opened on the claim page with a key that is not its own",
      run: async () => {
        const wrong = newClaimKey();
        fork.secrets.push(wrong.privateKey);
        const api = { fetch: server.routeFetch("203.0.113.17", []), origin: ORIGIN };
        const shown = await loadGift(api, gifts.noted.giftId, wrong.privateKey);
        const control = await loadGift(api, gifts.noted.giftId, gifts.noted.key);
        return verdict("keyMatches false: no amount, token or note shown", [
          [shown.keyMatches === false && shown.gift === null && shown.note === null, "the page showed the gift"],
          [control.keyMatches === true && control.note === NOTE_TEXT, "the gift's own key did not open it, so the check proves nothing"],
        ]);
      },
    },
    {
      id: "C9",
      attack: "the note read from /api/gift and opened without the link's key",
      run: async () => {
        const res = await server.send({ method: "GET", path: `/api/gift/${gifts.noted.giftId}`, ip: "203.0.113.18" });
        const sealed = res.json.sealedNote as Hex;
        const wrong = newClaimKey();
        fork.secrets.push(wrong.privateKey);
        let refusal = "opened";
        try {
          await openNote(wrong.privateKey, sealed);
        } catch (err) {
          refusal = err instanceof LinkError ? `LinkError ${err.kind}` : "another error";
        }
        return verdict("LinkError invalid; /api/gift carries ciphertext only", [
          [res.status === 200 && typeof sealed === "string" && sealed.length > 2, `answered ${res.status}`],
          [!res.text.includes(NOTE_TEXT) && !res.text.includes(Buffer.from(NOTE_TEXT).toString("hex")), "the note's text is in the response"],
          [refusal === "LinkError invalid", `a wrong key gave: ${refusal}`],
          [(await openNote(gifts.noted.key, sealed)) === NOTE_TEXT, "the gift's own key did not open it, so the check proves nothing"],
        ]);
      },
    },
    {
      id: "C12",
      attack: "the whole claim flow recorded, every Moi and chain request searched for the claim key",
      run: async () => {
        const moi: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
        const chain: string[] = [];
        const publicClient = createPublicClient({
          chain: bsc,
          pollingInterval: 250,
          transport: http(fork.rpc, {
            onFetchRequest: (request, init) => {
              chain.push(`${request.url} ${typeof init.body === "string" ? init.body : ""}`);
            },
          }),
        }) as PublicClient;
        const api = { fetch: server.routeFetch("203.0.113.19", moi), origin: ORIGIN };
        const loaded = await loadGift(api, gifts.flow.giftId, gifts.flow.key);
        const claimed = await claimGift({ ...api, publicClient, vault: fork.vault }, { giftId: gifts.flow.giftId, claimKey: gifts.flow.key, recipient: freshAddress(), declaration: true });
        const bare = gifts.flow.key.slice(2).toLowerCase();
        const haystack = [...moi.map((r) => `${r.url} ${JSON.stringify(r.headers)} ${r.body ?? ""}`), ...chain].join("\n").toLowerCase();
        return verdict(`0 hits in ${moi.length} Moi requests and ${chain.length} chain requests, and the gift was claimed`, [
          [loaded.keyMatches && claimed.claimed, "the flow did not complete, so the search proves nothing"],
          [!haystack.includes(bare), "the claim key is in a request"],
        ]);
      },
    },
  ];
}

/** C37 and C8 at the API: run last, because they move the fork's clock forward. */
export function clockAttacks(fork: Fork, server: Server, gifts: ClaimGifts): Attack[] {
  const post = (body: string, ip: string) => server.send({ method: "POST", path: "/api/claim", body, ip });
  return [
    {
      id: "C37",
      attack: "valid claim 30 seconds before the gift expires",
      run: async () => {
        const expiry = (await readGift(fork.client, fork.vault, gifts.expiring.giftId)).expiry;
        await fork.setTime(expiry - 30n);
        const nonce = await relayerNonce(fork);
        const res = await post(await claimBody(fork, gifts.expiring, freshAddress()), "203.0.113.31");
        return verdict("409 gift_expiring, relayer sent nothing", [
          [res.status === 409 && res.json.error === "gift_expiring", `answered ${res.status} ${String(res.json.error)}`],
          [(await relayerNonce(fork)) === nonce, "the relayer sent a transaction"],
        ]);
      },
    },
    {
      id: "C8",
      attack: "valid claim one second after the gift expired",
      run: async () => {
        const expiry = (await readGift(fork.client, fork.vault, gifts.expiring.giftId)).expiry;
        await fork.setTime(expiry + 1n);
        const res = await post(await claimBody(fork, gifts.expiring, freshAddress()), "203.0.113.32");
        return verdict("409 gift_expired", [[res.status === 409 && res.json.error === "gift_expired", `answered ${res.status} ${String(res.json.error)}`]]);
      },
    },
  ];
}

