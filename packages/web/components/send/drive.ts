import { SendGiftError, type PendingGift, type SendStep, type WrapStep } from "@moi/core/src/client/send.js";
import type { Hex } from "viem";

/** What the send run does besides drawing the call sheet. Each saving call says whether the browser kept the value. */
export type DriveIO = {
  onStep: (step: SendStep) => void;
  keepPending: (pending: PendingGift) => boolean;
  keepLink: (giftId: bigint, link: string) => boolean;
  dropPending: (claimKey: Hex) => void;
  dropDeclined: (claimKey: Hex) => void;
};

export type DriveResult = { ok: true } | { ok: false; error: unknown };

/**
 * Runs sendGift's steps in the order the claim key needs:
 * - key-pending: the record is saved first and only then does the run ask for the next step, so a
 *   closed tab after createGift is sent can never lose the key. If the browser will not keep it, the
 *   run stops before createGift;
 * - link-ready: the link is saved first, then the pending record is removed (and kept if the link
 *   could not be saved);
 * - a wallet refusal of createGift in this same run removes the pending record at once, because the
 *   transaction was never sent.
 * It never reads, logs or sends the claim key beyond handing it to `io`.
 */
export async function driveSend(gen: AsyncGenerator<SendStep, void, void>, io: DriveIO): Promise<DriveResult> {
  let outstanding: PendingGift | null = null;
  let last: SendStep["kind"] | null = null;
  try {
    for (;;) {
      const next = await gen.next();
      if (next.done === true) return { ok: true };
      const step = next.value;
      last = step.kind;
      if (step.kind === "key-pending") {
        if (!io.keepPending(step.pending)) {
          await gen.return();
          return {
            ok: false,
            error: new SendGiftError(
              "unexpected",
              "This browser would not save the gift key, so Moi stopped before locking anything.",
              "The stock you bought is in your wallet. The Moi vault may take exactly that amount, and no gift was made.",
              null,
            ),
          };
        }
        outstanding = step.pending;
      } else if (step.kind === "link-ready") {
        const saved = io.keepLink(step.giftId, step.link);
        if (saved && outstanding !== null) io.dropPending(outstanding.claimKey);
        outstanding = null;
      }
      io.onStep(step);
    }
  } catch (error) {
    if (outstanding !== null && last === "create" && error instanceof SendGiftError && error.code === "declined") {
      io.dropDeclined(outstanding.claimKey);
    }
    return { ok: false, error };
  }
}

export type WrapResult = { ok: true; hash: Hex } | { ok: false; error: unknown };

/** Runs wrapGift's steps and reports the settlement hash, or why it stopped. */
export async function driveWrap(gen: AsyncGenerator<WrapStep, Hex, void>, onStep: (step: WrapStep) => void): Promise<WrapResult> {
  try {
    for (;;) {
      const next = await gen.next();
      if (next.done === true) return { ok: true, hash: next.value };
      onStep(next.value);
    }
  } catch (error) {
    return { ok: false, error };
  }
}
