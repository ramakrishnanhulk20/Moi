import type { SendStep, WrapStep } from "@moi/core/src/client/send.js";
import type { Hex } from "viem";
import type { WalletPhase } from "./signer";

export type RowId = "quote" | "approve-usdt" | "swap" | "approve-vault" | "create" | "wrap" | "link";

/** "working" is a wait on Moi's server or a settlement, with no wallet involved. */
export type RowState = "waiting" | "working" | "in-wallet" | "confirming" | "done" | "failed";

export type Row = { id: RowId; shown: boolean; state: RowState; hash: Hex | null };

/** The call sheet: one row per step, and which row is the one on screen now. */
export type Sheet = { rows: Row[]; active: RowId | null };

// The order the spec gives. The approve-usdt row only shows once the quote asks for it.
const ORDER: readonly RowId[] = ["quote", "approve-usdt", "swap", "approve-vault", "create", "wrap", "link"];

export function newSheet(): Sheet {
  return { rows: ORDER.map((id) => ({ id, shown: id !== "approve-usdt", state: "waiting", hash: null })), active: null };
}

export function rowLabel(id: RowId, stockName: string): string {
  switch (id) {
    case "quote":
      return "Price check";
    case "approve-usdt":
      return "Allow USDT for the trade";
    case "swap":
      return `Buy ${stockName}`;
    case "approve-vault":
      return "Let the vault hold it";
    case "create":
      return "Seal the gift";
    case "wrap":
      return "Gift wrap, 5 cents";
    case "link":
      return "Link ready";
  }
}

function set(sheet: Sheet, id: RowId, patch: Partial<Row>): Sheet {
  return { ...sheet, rows: sheet.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) };
}

function finish(sheet: Sheet, id: RowId): Sheet {
  const row = sheet.rows.find((entry) => entry.id === id);
  return row === undefined || row.state === "done" ? sheet : set(sheet, id, { state: "done" });
}

function activate(sheet: Sheet, id: RowId, state: RowState): Sheet {
  return { ...set(sheet, id, { state, hash: null, shown: true }), active: id };
}

/** Moves the sheet on when sendGift or wrapGift yields a step: the step before it is done, this one is active. */
export function applyStep(sheet: Sheet, step: SendStep | WrapStep): Sheet {
  switch (step.kind) {
    case "quote":
      return activate(sheet, "quote", "working");
    case "approve-usdt":
      return activate(finish(sheet, "quote"), "approve-usdt", "in-wallet");
    case "swap":
      return activate(finish(finish(sheet, "quote"), "approve-usdt"), "swap", "in-wallet");
    case "approve-vault":
      return activate(finish(sheet, "swap"), "approve-vault", "in-wallet");
    case "key-pending":
      return finish(sheet, "approve-vault");
    case "create":
      return activate(sheet, "create", "in-wallet");
    case "link-ready":
      // The link comes before the wrap, so the wrap row starts working while the link row is done.
      return activate(finish(finish(sheet, "create"), "link"), "wrap", "working");
    case "wrap":
      return step.stage === "pay" ? activate(sheet, "wrap", "in-wallet") : { ...set(sheet, "wrap", { state: "confirming" }), active: "wrap" };
    case "approve-permit2":
      return activate(sheet, "wrap", "in-wallet");
    case "done":
      return { ...set(sheet, "wrap", { state: "done", hash: step.wrapTxHash }), active: null };
  }
}

/** The wallet reported what it is doing for the active row. */
export function applyWallet(sheet: Sheet, phase: WalletPhase, hash?: Hex): Sheet {
  if (sheet.active === null) return sheet;
  if (phase === "in-wallet") return set(sheet, sheet.active, { state: "in-wallet" });
  if (phase === "confirming") return set(sheet, sheet.active, { state: "confirming" });
  return set(sheet, sheet.active, { state: "confirming", hash: hash ?? null });
}

/** A wrap run on its own ends with the settlement's hash. */
export function wrapDone(sheet: Sheet, hash: Hex): Sheet {
  return { ...set(sheet, "wrap", { hash, state: "done" }), active: null };
}

/** The active row, if there is one, is where it stopped. */
export function failSheet(sheet: Sheet): Sheet {
  return sheet.active === null ? sheet : { ...set(sheet, sheet.active, { state: "failed" }), active: null };
}

/** A wrap that is run again starts its row over. */
export function restartWrap(sheet: Sheet): Sheet {
  return { ...set(sheet, "wrap", { state: "working", hash: null }), active: "wrap" };
}
