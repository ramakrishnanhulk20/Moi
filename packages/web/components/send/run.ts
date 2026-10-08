import { SendGiftError, type SendStep } from "@moi/core/src/client/send.js";
import type { Hex } from "viem";
import type { Failure } from "./ErrorPanel";
import type { WrapProgress } from "./LinkCard";
import { applyStep, applyWallet, failSheet, newSheet, type Sheet } from "./rows";
import type { WalletPhase } from "./signer";

/** Where the send page is: filling in the form, walking the steps, holding a link, or stopped. */
export type Run =
  | { phase: "form" }
  | { phase: "sending"; sheet: Sheet }
  | { phase: "linked"; sheet: Sheet; giftId: string; link: string; wrap: WrapProgress; wrapMessage: string | null }
  | { phase: "failed"; sheet: Sheet; failure: Failure };

export const UNTYPED_MESSAGE = "Something went wrong on our side. Try again in a minute.";

/** core's own errors say what happened and what the sender holds; anything else gets the plain fallback. */
export function failureOf(error: unknown): Failure {
  if (error instanceof SendGiftError) return { heading: "That stopped", message: error.message, stillHeld: error.stillHeld };
  return { heading: "That didn't work", message: UNTYPED_MESSAGE, stillHeld: null };
}

export function messageOf(error: unknown): string {
  return error instanceof SendGiftError ? error.message : UNTYPED_MESSAGE;
}

/** What the page shows after sendGift yields a step: the sheet moves on, and link-ready turns the run into a held link. */
export function advanceRun(run: Run, step: SendStep): Run {
  if (run.phase === "sending") {
    const sheet = applyStep(run.sheet, step);
    if (step.kind === "link-ready") return { phase: "linked", sheet, giftId: step.giftId.toString(), link: step.link, wrap: "running", wrapMessage: null };
    return { ...run, sheet };
  }
  if (run.phase === "linked") {
    const sheet = applyStep(run.sheet, step);
    return step.kind === "done" ? { ...run, sheet, wrap: "done" } : { ...run, sheet };
  }
  return run;
}

/** The wallet reported what it is doing for the active row. */
export function walletOnRun(run: Run, phase: WalletPhase, hash?: Hex): Run {
  return run.phase === "sending" || run.phase === "linked" ? { ...run, sheet: applyWallet(run.sheet, phase, hash) } : run;
}

/** The run stopped: before the link it becomes the error panel, after the link only the wrap has failed. */
export function stopRun(run: Run, error: unknown): Run {
  if (run.phase === "linked") return { ...run, sheet: failSheet(run.sheet), wrap: "failed", wrapMessage: messageOf(error) };
  return { phase: "failed", sheet: failSheet(run.phase === "sending" ? run.sheet : newSheet()), failure: failureOf(error) };
}
