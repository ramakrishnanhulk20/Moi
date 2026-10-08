"use client";

import { useEffect, useState } from "react";
import { rowLabel, type Row, type Sheet } from "./rows";
import { shortHex } from "./format";

function StatusMark({ row }: { row: Row }) {
  switch (row.state) {
    case "waiting":
      return <span className="send-dot" role="img" aria-label="Waiting" />;
    case "working":
      return <span className="send-spin" role="img" aria-label="Working" />;
    case "in-wallet":
      return (
        <>
          <span className="send-ring" aria-hidden="true" />
          <span className="send-row-text">Confirm in your wallet</span>
        </>
      );
    case "confirming":
      return (
        <>
          <span className="send-spin" aria-hidden="true" />
          <span className="send-row-text">Confirming on BNB Chain</span>
        </>
      );
    case "done":
      return (
        <>
          <svg className="send-done" viewBox="0 0 16 16" width={16} height={16} role="img" aria-label="Done" focusable="false">
            <path d="M3 8.4 L6.5 11.6 L13 4.4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {row.hash === null ? null : (
            <a className="send-link send-link-small send-hash" href={`https://bscscan.com/tx/${row.hash}`} target="_blank" rel="noopener noreferrer">
              {shortHex(row.hash)}
            </a>
          )}
        </>
      );
    case "failed":
      return (
        <svg className="send-failed" viewBox="0 0 16 16" width={16} height={16} role="img" aria-label="Failed" focusable="false">
          <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
        </svg>
      );
  }
}

const LATE_AFTER_MS = 20_000;

// Not in the page at all until the row has waited 20 seconds, so a screen reader hears it only then.
function LateHint() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), LATE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return late ? <p className="send-row-late">BNB Chain can take up to a minute when busy.</p> : null;
}

/**
 * The list of steps a send walks through, one row each, with what each is doing now. A row that
 * stays active for 20 seconds adds a line saying BNB Chain can be slow; the count starts over
 * whenever the row changes what it is waiting for.
 */
export function CallSheet({ sheet, stockName }: { sheet: Sheet; stockName: string }) {
  return (
    <section className="send-sheet send-rise" aria-label="Sending">
      <p className="send-label send-label-small">SENDING</p>
      <ol className="send-rows">
        {sheet.rows
          .filter((row) => row.shown)
          .map((row) => {
            const active = row.state === "working" || row.state === "in-wallet" || row.state === "confirming";
            return (
              <li className="send-row" key={row.id} data-state={row.state} aria-current={active ? "step" : undefined}>
                <span className="send-row-label">{rowLabel(row.id, stockName)}</span>
                <span className="send-row-status">
                  <StatusMark row={row} />
                </span>
                {active ? <LateHint key={`${row.state}-${row.hash ?? ""}`} /> : null}
              </li>
            );
          })}
      </ol>
    </section>
  );
}
