// npm run attacks: every server-side attack in docs/security/attacks/README.md, run in process
// through route(), the dispatcher the website and the local server share. The chain is an anvil
// fork of BSC mainnet at its latest block with a freshly deployed vault, and the store is an
// in-process memory store, so the shared Upstash store, the live vault and the running dev server
// are never touched and no .env is read. Prints one line per attack, "C<n> <attack>: REFUSED
// <how>", and exits 0 only when every attack was refused.
// Not covered here: the contract attacks on the live vault (packages/contracts/test/attacks), Privy's
// own token check (a fake verifier reads the token as the user id; privy.test.ts covers the real one),
// b402's own signature checks (a fake facilitator, as in claim.fork.test.ts), and the website's pages.
import { claimAttacks, clockAttacks, NOTE_TEXT, type ClaimGifts } from "./claims.js";
import { startFork, type Fork } from "./fork.js";
import { judgeAttacks } from "./judges.js";
import { quoteAttacks } from "./quotes.js";
import { startServer } from "./server.js";
import { sweepAttacks } from "./sweeps.js";
import type { Verdict } from "./verdict.js";
import { wrapAttacks, type WrapGifts } from "./wraps.js";

// Every printed line passes through here, so a key can never reach the output even inside an
// error message.
function scrub(text: string, fork: Fork): string {
  let out = text;
  for (const secret of fork.secrets) out = out.replace(new RegExp(secret.replace(/^0x/, ""), "gi"), "<hidden>");
  return out;
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "a non-error was thrown";
  return `${err.name}: ${err.message.split("\n")[0]?.slice(0, 200) ?? ""}`;
}

async function main(): Promise<number> {
  const fork = await startFork();
  try {
    const server = await startServer(fork);
    const { sponsor, payer } = fork;
    const claimGifts: ClaimGifts = {
      open: await fork.makeGift(sponsor),
      blocked: await fork.makeGift(sponsor),
      replayed: await fork.makeGift(sponsor),
      raced: await fork.makeGift(sponsor),
      noted: await fork.makeGift(sponsor, { note: NOTE_TEXT }),
      flow: await fork.makeGift(sponsor, { note: NOTE_TEXT }),
      // Just over the vault's one-hour minimum, so the clock attacks can reach its expiry.
      expiring: await fork.makeGift(sponsor, { lifetimeSeconds: 3_600n + 40n }),
    };
    const wrapGifts: WrapGifts = {
      paid: await fork.makeGift(payer),
      oldHash: await fork.makeGift(payer),
      paidNothing: await fork.makeGift(payer),
      replayed: await fork.makeGift(payer),
      tampered: await fork.makeGift(payer),
    };
    console.log(`# Moi server attacks through route(): anvil fork of BSC block ${fork.forkBlock}, fresh vault ${fork.vault}, in-process memory store`);

    const attacks = [
      ...claimAttacks(fork, server, claimGifts),
      ...judgeAttacks(fork, server),
      ...wrapAttacks(fork, server, wrapGifts),
      ...quoteAttacks(fork, server),
      ...clockAttacks(fork, server, claimGifts),
      ...sweepAttacks(fork, server),
    ];
    let refused = 0;
    for (const attack of attacks) {
      let outcome: Verdict;
      try {
        outcome = await attack.run();
      } catch (err) {
        outcome = { refused: false, result: `the attack could not run: ${describeError(err)}` };
      }
      if (outcome.refused) refused += 1;
      console.log(scrub(`${attack.id} ${attack.attack}: ${outcome.refused ? "REFUSED" : "NOT REFUSED"} ${outcome.result}`, fork));
    }
    console.log(`# ${attacks.length} attacks, ${refused} refused`);
    return refused === attacks.length ? 0 : 1;
  } finally {
    await fork.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`attack run stopped before the attacks: ${describeError(err)}`);
    process.exit(1);
  },
);
