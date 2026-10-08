"use client";

import { displayName, type Stock, type StocksState } from "@/lib/stocks";
import { opensText, usd } from "./format";

/** True unless the market is known to be closed. Binance sends no market status for some tokens, and the quote step checks the rest. */
export function isTradable(stock: Stock): boolean {
  return stock.market.open !== false;
}

function Logo({ stock }: { stock: Stock }) {
  // A plain img on purpose: the address was already checked to be https on Binance's static host.
  return stock.logoUrl === null ? (
    <span className="send-logo send-logo-blank" aria-hidden="true">
      {stock.symbol.slice(0, 1)}
    </span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="send-logo" src={stock.logoUrl} alt="" width={28} height={28} loading="lazy" referrerPolicy="no-referrer" />
  );
}

function Check() {
  return (
    <svg className="send-tile-check" viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
      <path d="M2.5 7.5 L5.6 10.5 L11.5 3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StockPicker({ state, selected, onSelect, onReload }: { state: StocksState; selected: string | null; onSelect: (address: string) => void; onReload: () => void }) {
  if (state.status === "loading") {
    return (
      <div className="send-grid" aria-busy="true" aria-label="Loading stocks">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span className="send-tile send-tile-skeleton" key={index} aria-hidden="true" />
        ))}
      </div>
    );
  }
  if (state.status === "failed" || state.stocks.length === 0) {
    return (
      <div className="send-soft">
        <p className="send-note-text">Stocks could not load. Try again in a minute.</p>
        <button type="button" className="send-link" onClick={onReload}>
          Reload
        </button>
      </div>
    );
  }
  const now = new Date();
  return (
    <div className="send-grid" role="group" aria-label="Stock">
      {state.stocks.map((stock) => {
        const open = isTradable(stock);
        const picked = selected === stock.address;
        return (
          <button
            type="button"
            className="send-tile"
            key={stock.address}
            disabled={!open}
            aria-pressed={picked}
            data-selected={picked ? "true" : undefined}
            data-closed={open ? undefined : "true"}
            onClick={() => onSelect(stock.address)}
          >
            <Logo stock={stock} />
            <span className="send-tile-text">
              <span className="send-tile-name">{displayName(stock.name)}</span>
              <span className="send-tile-symbol">{stock.symbol}</span>
              {open ? null : <span className="send-tile-opens">{opensText(stock.market.nextOpenTime, now)}</span>}
            </span>
            <span className="send-tile-price">{stock.priceUsd === null ? "" : `$${usd(stock.priceUsd)}`}</span>
            {picked ? <Check /> : null}
          </button>
        );
      })}
    </div>
  );
}
