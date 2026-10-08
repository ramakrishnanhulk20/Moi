"use client";

import type { RecoveryLine } from "./recovery";

/** The state of a gift wrap started from the banner. `phase` is what the wallet is doing, when it is doing something. */
export type BannerWrap = { giftId: string; state: "running" | "done" | "failed"; phase: "in-wallet" | "confirming" | null; message: string | null };

function wrapText(wrap: BannerWrap): string {
  if (wrap.state === "done") return "The gift is wrapped. It can be opened now.";
  if (wrap.state === "failed") return wrap.message ?? "The gift wrap did not go through.";
  if (wrap.phase === "in-wallet") return "Confirm in your wallet";
  if (wrap.phase === "confirming") return "Confirming on BNB Chain";
  return "Wrapping the gift.";
}

/**
 * Shown at the top of the form when this browser holds a gift key from a send that did not finish.
 * "Find it" asks the chain whether that key made a gift, and the answer replaces the button's line.
 */
export function RecoveryBanner({
  lines,
  busy,
  wrap,
  onFind,
  onWrap,
}: {
  lines: RecoveryLine[] | null;
  busy: boolean;
  wrap: BannerWrap | null;
  onFind: () => void;
  onWrap: (giftId: bigint) => void;
}) {
  const again = lines === null || lines.some((line) => line.kind === "in-flight" || line.kind === "error");
  return (
    <section className="send-banner send-rise" aria-label="A gift that did not finish">
      <p className="send-banner-text">You have a gift that didn&apos;t finish.</p>
      <div role="status" aria-live="polite">
        {(lines ?? []).map((line, index) => {
          if (line.kind === "found") {
            const id = line.giftId.toString();
            const mine = wrap !== null && wrap.giftId === id ? wrap : null;
            return (
              <div className="send-banner-line" key={`${index}-${id}`}>
                <p className="send-banner-result">Found gift {id}. Its link is in your gifts below.</p>
                {mine === null || mine.state === "failed" ? (
                  <>
                    {mine === null ? null : <p className="send-banner-result">{wrapText(mine)}</p>}
                    <button type="button" className="send-link" onClick={() => onWrap(line.giftId)}>
                      Finish the gift wrap
                    </button>
                  </>
                ) : (
                  <p className="send-banner-result">{wrapText(mine)}</p>
                )}
              </div>
            );
          }
          if (line.kind === "in-flight") {
            return (
              <p className="send-banner-result" key={index}>
                Still in flight. Check again in a minute.
              </p>
            );
          }
          if (line.kind === "nothing") {
            return (
              <p className="send-banner-result" key={index}>
                No gift was made with that key, so nothing is waiting.
              </p>
            );
          }
          return (
            <p className="send-banner-result" key={index}>
              {line.message}
            </p>
          );
        })}
      </div>
      {again ? (
        <button type="button" className="send-secondary send-secondary-inline" onClick={onFind} disabled={busy}>
          Find it
        </button>
      ) : null}
    </section>
  );
}
