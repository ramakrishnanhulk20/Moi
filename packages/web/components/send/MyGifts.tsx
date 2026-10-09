"use client";

import { useEffect, useRef, useState } from "react";
import { readChainTime, readGiftStatus, type GiftStatus } from "./reads";
import type { FinalState, StoredLink } from "./storage";

/** Gifts shown at most; the vault's newest first. Each one costs a request to Moi's server. */
const MAX_ROWS = 20;

type RefundState = { phase: "in-wallet" | "confirming" } | { phase: "error"; message: string };

/** Development only: fixed answers so the screen can be shot without a wallet or the network. */
export type GiftsFixture = { statuses: Record<string, GiftStatus>; chainTime: number };

// Without the chain's time an Open gift cannot be called expired, so it is shown as waiting.
function labelOf(status: GiftStatus, chainTime: number | null): string {
  return chainTime !== null && status.expiry <= chainTime ? "Expired" : "Waiting to be opened";
}

// The same chips as the home page's latest gifts. A gift in one of these states has no link to copy.
const CHIPS: Readonly<Record<FinalState, { text: string; tone: string }>> = {
  Claimed: { text: "OPENED", tone: "opened" },
  Refunded: { text: "TAKEN BACK", tone: "taken-back" },
};

/**
 * The sender's gifts, newest first, each with what the vault says about it now. A gift that is still
 * Open but past its expiry can be taken back: the sender's wallet sends the vault's refund call.
 * A gift that is opened or taken back shows a state chip and no copy button: its link is erased
 * from this browser. `onRefund` resolves with null on success, or with the sentence to show when it
 * did not work.
 */
export function MyGifts({
  entries,
  canRefund,
  onRefund,
  fixture,
}: {
  entries: StoredLink[];
  canRefund: boolean;
  onRefund: (giftId: string, onPhase: (phase: "in-wallet" | "confirming") => void) => Promise<string | null>;
  fixture: GiftsFixture | null;
}) {
  const [statuses, setStatuses] = useState<Record<string, GiftStatus | "failed">>({});
  const [chainTime, setChainTime] = useState<number | null>(null);
  const [refunds, setRefunds] = useState<Record<string, RefundState>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const shown = entries.slice(0, MAX_ROWS);
  // A finished gift needs no look-up, unless it was saved without a symbol and the server can supply one.
  const ids = shown
    .filter((entry) => entry.final === undefined || entry.symbol === "")
    .map((entry) => entry.giftId)
    .join(",");

  useEffect(() => {
    if (fixture !== null || ids === "") return;
    let alive = true;
    const list = ids.split(",");
    void Promise.all([readChainTime().catch(() => null), Promise.all(list.map((id) => readGiftStatus(id)))]).then(([time, answers]) => {
      if (!alive) return;
      setChainTime(time);
      setStatuses(Object.fromEntries(list.map((id, index) => [id, answers[index] ?? "failed"])));
    });
    return () => {
      alive = false;
    };
  }, [fixture, ids]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (entry: StoredLink) => {
    if (entry.link === null) return;
    try {
      await navigator.clipboard.writeText(entry.link);
      setCopied(entry.giftId);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  const takeBack = async (giftId: string) => {
    setRefunds((current) => ({ ...current, [giftId]: { phase: "in-wallet" } }));
    const problem = await onRefund(giftId, (phase) => setRefunds((current) => ({ ...current, [giftId]: { phase } })));
    if (problem !== null) {
      setRefunds((current) => ({ ...current, [giftId]: { phase: "error", message: problem } }));
      return;
    }
    const [status, time] = await Promise.all([readGiftStatus(giftId), readChainTime().catch(() => null)]);
    setStatuses((current) => ({ ...current, [giftId]: status ?? "failed" }));
    if (time !== null) setChainTime(time);
    setRefunds((current) => {
      const rest = { ...current };
      delete rest[giftId];
      return rest;
    });
  };

  const statusMap = fixture === null ? statuses : fixture.statuses;
  const time = fixture === null ? chainTime : fixture.chainTime;
  if (shown.length === 0) return null;

  return (
    <section className="send-gifts send-rise" aria-label="Your gifts">
      <p className="send-label">YOUR GIFTS</p>
      <ul className="send-gift-list">
        {shown.map((entry) => {
          const status = statusMap[entry.giftId];
          const known = status !== undefined && status !== "failed" ? status : null;
          const refund = refunds[entry.giftId];
          const final: FinalState | undefined = entry.final ?? (known?.state === "Claimed" ? "Claimed" : known?.state === "Refunded" ? "Refunded" : undefined);
          const canTake = known !== null && known.state === "Open" && time !== null && known.expiry <= time && canRefund && (refund === undefined || refund.phase === "error");
          return (
            <li className="send-gift" key={entry.giftId}>
              <span className="send-gift-id">#{entry.giftId}</span>
              <span className="send-gift-symbol">{known?.symbol || entry.symbol}</span>
              <span className="send-gift-state">
                {final !== undefined ? (
                  <span className={`send-gift-chip send-gift-chip-${CHIPS[final].tone}`}>{CHIPS[final].text}</span>
                ) : status === undefined ? (
                  "Checking"
                ) : known === null ? (
                  "Could not check"
                ) : (
                  labelOf(known, time)
                )}
              </span>
              <span className="send-gift-actions">
                {final === undefined && entry.link !== null ? (
                  <button type="button" className="send-link send-link-small" onClick={() => void copy(entry)}>
                    {copied === entry.giftId ? "Copied" : "Copy link"}
                  </button>
                ) : null}
                {canTake ? (
                  <button type="button" className="send-link send-link-small" onClick={() => void takeBack(entry.giftId)}>
                    Take it back
                  </button>
                ) : null}
              </span>
              {refund === undefined ? null : (
                <p className="send-gift-note" role="status">
                  {refund.phase === "error" ? refund.message : refund.phase === "in-wallet" ? "Confirm in your wallet" : "Confirming on BNB Chain"}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
