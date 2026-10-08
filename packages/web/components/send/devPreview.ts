import { SendGiftError, type SendStep, type WrapStep } from "@moi/core/src/client/send.js";
import type { Address, Hex } from "viem";
import type { GiftsFixture } from "./MyGifts";
import type { Balances } from "./reads";
import { applyStep, applyWallet, failSheet, newSheet, type Sheet } from "./rows";
import type { Run } from "./run";
import type { StoredLink } from "./storage";

/**
 * Development only. `?sendPreview=<name>` on /send shows one made-up state with no wallet, no
 * network call and no storage, so each screen can be looked at. The caller only reaches this when
 * NODE_ENV is not "production", so none of it is in the production build. Every address, hash and
 * key below is invented.
 */
export type PreviewName = "connected" | "buy" | "seal" | "link" | "wrapfail" | "error" | "recovery" | "gifts";

export type SendPreview = {
  name: PreviewName;
  address: Address;
  balances: Balances;
  run: Run;
  pendingCount: number;
  links: StoredLink[];
  gifts: GiftsFixture | null;
};

const NAMES: readonly PreviewName[] = ["connected", "buy", "seal", "link", "wrapfail", "error", "recovery", "gifts"];

const ADDRESS: Address = "0x7a3F1c9d52B0e84A6f3dC1a9B7E20c4D5e6F8a91";
const BALANCES: Balances = { usdt: 42_170_000_000_000_000_000n, usdtDecimals: 18, bnb: 12_300_000_000_000_000n };
const FAKE_KEY = "0x" + "9f3b2c1d4e5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9".slice(0, 64);

const hash = (seed: string): Hex => `0x${seed.repeat(64).slice(0, 64)}`;
const tx = { to: ADDRESS, data: "0x", value: 0n } as const;

function runSteps(steps: (SendStep | WrapStep | { sent: Hex })[], last?: "in-wallet" | "confirming"): Sheet {
  let sheet = newSheet();
  for (const step of steps) sheet = "sent" in step ? applyWallet(sheet, "sent", step.sent) : applyStep(sheet, step);
  return last === undefined ? sheet : applyWallet(sheet, last);
}

const BEFORE_CREATE: (SendStep | { sent: Hex })[] = [
  { kind: "quote" },
  { kind: "swap", tx },
  { sent: hash("a1") },
  { kind: "approve-vault", tx },
  { sent: hash("b2") },
  { kind: "key-pending", pending: { senderAddress: ADDRESS, claimKey: FAKE_KEY as Hex, sealedNote: "0x", createdAt: 1, landsBefore: 2 } },
  { kind: "create", tx },
];

function linkRun(origin: string, wrap: "running" | "failed"): Run {
  const link = `${origin}/g/12#${FAKE_KEY.slice(2)}`;
  const sheet = runSteps([...BEFORE_CREATE, { sent: hash("c3") }, { kind: "link-ready", giftId: 12n, link }]);
  return wrap === "running"
    ? { phase: "linked", sheet, giftId: "12", link, wrap: "running", wrapMessage: null }
    : {
        phase: "linked",
        sheet: failSheet(sheet),
        giftId: "12",
        link,
        wrap: "failed",
        wrapMessage: "The wrapping fee is paid in U, USD1, USDT or USDC on BNB Smart Chain, and this wallet holds too little of each. Add some and try wrapping again; nothing was paid.",
      };
}

function giftsFixture(origin: string, now: number): { links: StoredLink[]; gifts: GiftsFixture } {
  const link = (id: string, symbol: string, createdAt: number): StoredLink => ({ giftId: id, link: `${origin}/g/${id}#${FAKE_KEY.slice(2)}`, symbol, createdAt });
  return {
    links: [link("14", "NVDAB", 4), link("13", "TSLAB", 3), link("12", "AAPLB", 2), link("9", "NVDAB", 1)],
    gifts: {
      chainTime: now,
      statuses: {
        "14": { state: "Open", expiry: now + 20 * 86_400, symbol: "NVDAB" },
        "13": { state: "Open", expiry: now - 3_600, symbol: "TSLAB" },
        "12": { state: "Claimed", expiry: now + 5 * 86_400, symbol: "AAPLB" },
        "9": { state: "Refunded", expiry: now - 9 * 86_400, symbol: "NVDAB" },
      },
    },
  };
}

/** The scenario named in `?sendPreview=`, or null when there is none or the name is unknown. */
export function previewScenario(search: string, origin: string): SendPreview | null {
  const name = new URLSearchParams(search).get("sendPreview");
  if (name === null || !(NAMES as readonly string[]).includes(name)) return null;
  const base = { address: ADDRESS, balances: BALANCES, pendingCount: 0, links: [] as StoredLink[], gifts: null as GiftsFixture | null };
  switch (name as PreviewName) {
    case "connected":
      return { name: "connected", ...base, run: { phase: "form" } };
    case "buy":
      return { name: "buy", ...base, run: { phase: "sending", sheet: runSteps([{ kind: "quote" }, { kind: "swap", tx }], "in-wallet") } };
    case "seal":
      return { name: "seal", ...base, run: { phase: "sending", sheet: runSteps([...BEFORE_CREATE, { sent: hash("c3") }], "confirming") } };
    case "link":
      return { name: "link", ...base, run: linkRun(origin, "running") };
    case "wrapfail":
      return { name: "wrapfail", ...base, run: linkRun(origin, "failed") };
    case "error": {
      const sheet = failSheet(runSteps([{ kind: "quote" }, { kind: "approve-usdt", tx }, { sent: hash("d4") }, { kind: "swap", tx }], "in-wallet"));
      const error = new SendGiftError(
        "quote_refused",
        "Binance's price for this stock did not pass Moi's checks just now. Try again in a minute.",
        "Your 5 USDT is still in your wallet. The trading router may spend exactly that amount of it.",
        null,
      );
      return { name: "error", ...base, run: { phase: "failed", sheet, failure: { heading: "That stopped", message: error.message, stillHeld: error.stillHeld } } };
    }
    case "recovery":
      return { name: "recovery", ...base, pendingCount: 1, run: { phase: "form" } };
    case "gifts": {
      const fixture = giftsFixture(origin, 1_791_500_000);
      return { name: "gifts", ...base, links: fixture.links, gifts: fixture.gifts, run: { phase: "form" } };
    }
  }
}
