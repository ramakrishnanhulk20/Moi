import type { PendingGift } from "@moi/core/src/client/send.js";

/**
 * What this browser keeps for a sender, in localStorage. Every access is inside try/catch because a
 * browser can block storage. A claim key or a link is never logged, never sent anywhere and never
 * put in an address (C12): these functions only read and write the browser's own storage.
 */

/** A gift key saved before its createGift was sent. `declined` is set when the wallet refused and the record could not be removed. */
export type StoredPending = PendingGift & { declined: boolean };

/** The last state a gift reaches. Once a gift is in one of these, nothing about it can change, so its link is not kept. */
export type FinalState = "Claimed" | "Refunded";

/** A sent gift. `link` is null once the gift is Claimed or Refunded: the key has done its job and is erased. */
export type StoredLink = { giftId: string; link: string | null; symbol: string; createdAt: number; final?: FinalState };

const PENDING_PREFIX = "moi:pending:";
const LINKS_PREFIX = "moi:links:";
const PROBE_KEY = "moi:probe";

const ADDRESS_TEXT = /^0x[0-9a-fA-F]{40}$/;
const KEY_TEXT = /^0x[0-9a-fA-F]{64}$/;
const HEX_TEXT = /^0x([0-9a-fA-F]{2})*$/;

function pendingKey(sender: string): string {
  return `${PENDING_PREFIX}${sender.toLowerCase()}`;
}

function linksKey(sender: string): string {
  return `${LINKS_PREFIX}${sender.toLowerCase()}`;
}

function area(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when this browser lets the page write, read back and delete a value. */
export function storageWorks(): boolean {
  // The layout's guard swapped in a memory-only store, which loses everything on reload.
  if ((globalThis as { __moiStorageBlocked?: boolean }).__moiStorageBlocked === true) return false;
  try {
    const storage = area();
    if (storage === null) return false;
    storage.setItem(PROBE_KEY, "1");
    const same = storage.getItem(PROBE_KEY) === "1";
    storage.removeItem(PROBE_KEY);
    return same;
  } catch {
    return false;
  }
}

let checked: boolean | null = null;

/** storageWorks, asked once: the answer cannot change while the page is open, and a hook may ask on every render. */
export function storageChecked(): boolean {
  checked ??= storageWorks();
  return checked;
}

// A value that is not a JSON list is treated as empty: it holds nothing this page could use, and
// the next write replaces it. Entries this page does not recognise are kept as they are.
function readRaw(key: string): unknown[] | null {
  try {
    const storage = area();
    if (storage === null) return null;
    const text = storage.getItem(key);
    if (text === null) return [];
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

function writeRaw(key: string, list: unknown[]): boolean {
  try {
    const storage = area();
    if (storage === null) return false;
    if (list.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function asPending(value: unknown): StoredPending | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.senderAddress !== "string" || !ADDRESS_TEXT.test(v.senderAddress)) return null;
  if (typeof v.claimKey !== "string" || !KEY_TEXT.test(v.claimKey)) return null;
  if (typeof v.sealedNote !== "string" || !HEX_TEXT.test(v.sealedNote)) return null;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return null;
  if (typeof v.landsBefore !== "number" || !Number.isFinite(v.landsBefore)) return null;
  return {
    senderAddress: v.senderAddress as PendingGift["senderAddress"],
    claimKey: v.claimKey as PendingGift["claimKey"],
    sealedNote: v.sealedNote as PendingGift["sealedNote"],
    createdAt: v.createdAt,
    landsBefore: v.landsBefore,
    declined: v.declined === true,
  };
}

function asLink(value: unknown): StoredLink | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.giftId !== "string" || !/^[1-9][0-9]{0,9}$/.test(v.giftId)) return null;
  if (typeof v.symbol !== "string") return null;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return null;
  if (v.final === "Claimed" || v.final === "Refunded") {
    // A link left beside a final state is ignored, so it never reaches the screen.
    return { giftId: v.giftId, link: null, symbol: v.symbol, createdAt: v.createdAt, final: v.final };
  }
  if (typeof v.link !== "string") return null;
  return { giftId: v.giftId, link: v.link, symbol: v.symbol, createdAt: v.createdAt };
}

const sameKey = (entry: unknown, claimKey: string): boolean =>
  typeof entry === "object" && entry !== null && typeof (entry as { claimKey?: unknown }).claimKey === "string" && (entry as { claimKey: string }).claimKey.toLowerCase() === claimKey.toLowerCase();

/** The unfinished gifts saved for this sender, oldest first. */
export function listPending(sender: string): StoredPending[] {
  const list = readRaw(pendingKey(sender)) ?? [];
  return list.map(asPending).filter((entry): entry is StoredPending => entry !== null);
}

/** Saves a gift key. Returns false when the browser would not keep it. */
export function addPending(sender: string, pending: PendingGift): boolean {
  const list = readRaw(pendingKey(sender));
  if (list === null) return false;
  const rest = list.filter((entry) => !sameKey(entry, pending.claimKey));
  return writeRaw(pendingKey(sender), [...rest, { ...pending, declined: false }]);
}

/** Forgets one saved gift key. Returns false when the browser would not let it go. */
export function removePending(sender: string, claimKey: string): boolean {
  const list = readRaw(pendingKey(sender));
  if (list === null) return false;
  return writeRaw(
    pendingKey(sender),
    list.filter((entry) => !sameKey(entry, claimKey)),
  );
}

/** Marks a saved key as one whose createGift the wallet refused. */
export function markDeclined(sender: string, claimKey: string): boolean {
  const list = readRaw(pendingKey(sender));
  if (list === null) return false;
  return writeRaw(
    pendingKey(sender),
    list.map((entry) => (sameKey(entry, claimKey) ? { ...(entry as object), declined: true } : entry)),
  );
}

/**
 * The wallet refused createGift in this same run, so the key can never have been used. The record
 * is removed at once; if the browser will not let it go, it is marked declined instead, so a later
 * look-up may drop it without waiting.
 */
export function dropDeclined(sender: string, claimKey: string): void {
  if (!removePending(sender, claimKey)) markDeclined(sender, claimKey);
}

/** The links saved for this sender, newest first. */
export function listLinks(sender: string): StoredLink[] {
  const list = readRaw(linksKey(sender)) ?? [];
  return list
    .map(asLink)
    .filter((entry): entry is StoredLink => entry !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Saves a gift link. A link already saved for the same gift is replaced, except when that gift is
 * already final: the key is not put back on the device then. Returns false when the browser would
 * not keep it.
 */
export function addLink(sender: string, link: StoredLink): boolean {
  const list = readRaw(linksKey(sender));
  if (list === null) return false;
  if (list.some((entry) => asLink(entry)?.giftId === link.giftId && asLink(entry)?.final !== undefined)) return true;
  const rest = list.filter((entry) => asLink(entry)?.giftId !== link.giftId);
  return writeRaw(linksKey(sender), [...rest, link]);
}

/**
 * Rewrites the record of each gift in `finals` without its link, keeping the gift's id, symbol and
 * creation time and adding the final state, so no key stays on the device for a gift that can no
 * longer be opened. Records for other gifts, and entries this page does not recognise, are left as
 * they are. Returns true when at least one record changed and was saved.
 */
export function sealFinished(sender: string, finals: Readonly<Record<string, FinalState>>): boolean {
  const list = readRaw(linksKey(sender));
  if (list === null) return false;
  let changed = false;
  const next = list.map((entry) => {
    const link = asLink(entry);
    const final = link === null ? undefined : finals[link.giftId];
    if (link === null || final === undefined) return entry;
    // Already final and already without a link: nothing to rewrite.
    if (link.final !== undefined && !("link" in (entry as object))) return entry;
    changed = true;
    return { giftId: link.giftId, symbol: link.symbol, createdAt: link.createdAt, final };
  });
  return changed && writeRaw(linksKey(sender), next);
}
