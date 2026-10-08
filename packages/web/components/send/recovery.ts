import { SendGiftError, type PendingGift } from "@moi/core/src/client/send.js";
import type { StoredPending } from "./storage";

/** What looking for one saved gift key came to. */
export type RecoveryLine =
  | { kind: "found"; giftId: bigint; link: string }
  | { kind: "in-flight" }
  | { kind: "nothing" }
  | { kind: "error"; message: string };

export type RecoveryIO = {
  /** core's recoverPendingGift, with the page's client, vault and origin already bound. */
  recover: (pending: PendingGift) => Promise<{ giftId: bigint; link: string } | null>;
  /** The latest block's time in Unix seconds. */
  latestBlockTime: () => Promise<number>;
  /** Saves the recovered link. Returns false when the browser would not keep it. */
  saveLink: (record: StoredPending, found: { giftId: bigint; link: string }) => boolean;
  removeRecord: (record: StoredPending) => void;
};

export const RECOVERY_UNREADABLE = "Moi could not check that gift just now. Try again in a minute.";
const LINK_NOT_SAVED = "Moi found the gift, but this browser would not save its link, so the saved gift key was kept. Try again.";

/**
 * Decides what happens to one saved gift key:
 * - a gift was found: its link is saved, and only then is the record removed;
 * - nothing was found and the latest block time is past `landsBefore` (the last moment createGift
 *   could still be mined), or the wallet had refused it: the record is removed;
 * - nothing was found but createGift could still land: the record stays and the gift is in flight;
 * - anything went wrong: the record stays, with the error's own message when core wrote one.
 */
export async function recoverRecord(record: StoredPending, io: RecoveryIO): Promise<RecoveryLine> {
  try {
    const found = await io.recover(record);
    if (found !== null) {
      if (!io.saveLink(record, found)) return { kind: "error", message: LINK_NOT_SAVED };
      io.removeRecord(record);
      return { kind: "found", giftId: found.giftId, link: found.link };
    }
    if (record.declined) {
      io.removeRecord(record);
      return { kind: "nothing" };
    }
    const now = await io.latestBlockTime();
    if (now > record.landsBefore) {
      io.removeRecord(record);
      return { kind: "nothing" };
    }
    return { kind: "in-flight" };
  } catch (error) {
    return { kind: "error", message: error instanceof SendGiftError ? error.message : RECOVERY_UNREADABLE };
  }
}
