"use client";

export type Failure = { heading: string; message: string; stillHeld: string | null };

/** A send that stopped: what happened, in the error's own words, and what the sender holds right now. */
export function ErrorPanel({ failure, onRestart }: { failure: Failure; onRestart: () => void }) {
  return (
    <section className="send-error send-rise" role="alert">
      <h2 className="send-error-title">{failure.heading}</h2>
      <p className="send-error-text">{failure.message}</p>
      {failure.stillHeld === null ? null : (
        <>
          <p className="send-label send-label-small">WHAT YOU HAVE NOW</p>
          <p className="send-error-text">{failure.stillHeld}</p>
        </>
      )}
      <button type="button" className="send-secondary send-secondary-inline" onClick={onRestart}>
        Start again
      </button>
    </section>
  );
}
