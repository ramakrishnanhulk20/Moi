"use client";

import { MAX_NOTE_PLAINTEXT_BYTES } from "@moi/core/src/gift.js";
import { MAX_GIFT_USD, MIN_GIFT_USD } from "@moi/core/src/create.js";
import { useEffect, useId, useRef } from "react";
import type { Stock, StocksState } from "@/lib/stocks";
import { acceptAmountText, byteLength, clipToBytes, shortHex, truncateUnits, usd } from "./format";
import type { Balances } from "./reads";
import { isTradable, StockPicker } from "./StockPicker";

export type WalletView =
  | { kind: "unavailable" }
  | { kind: "loading" }
  | { kind: "disconnected"; onConnect: () => void }
  | { kind: "connected"; address: string; balances: Balances | null; onDisconnect: () => void };

export type AmountChoice = "1" | "5" | "10" | "25" | "other";
export type Days = 7 | 30 | 90;
export type StorageState = "checking" | "ok" | "blocked";

const STORAGE_NOTICE = "This browser is not saving site data, so Moi cannot keep your gift link safe. Allow site data for this site or use another browser.";
const CONNECT_FIRST = "Connect your wallet first.";
const CONNECT_BUTTON_ID = "send-connect-button";

/**
 * The line under a disabled send button: the first thing missing, in the order a sender would fix
 * it. A browser that cannot save the link comes first, because nothing else matters then. Nothing
 * is said while a send is running or done, or when nothing is missing.
 */
export function sendHintFor(state: { running: boolean; storage: StorageState; connected: boolean; stock: Stock | null; amountOk: boolean }): string | null {
  if (state.running) return null;
  if (state.storage === "blocked") return STORAGE_NOTICE;
  if (!state.connected) return CONNECT_FIRST;
  if (state.stock === null) return "Pick a stock.";
  if (!state.amountOk) return `Choose an amount from $${MIN_GIFT_USD} to $${MAX_GIFT_USD}.`;
  if (!isTradable(state.stock)) return "That stock's market is closed right now.";
  return null;
}

const PRESETS: readonly AmountChoice[] = ["1", "5", "10", "25"];
const LIFETIMES: readonly Days[] = [7, 30, 90];
// 0.0005 BNB in wei: under this a wallet cannot pay for the four or five transactions of a send.
const LOW_BNB = 500_000_000_000_000n;

/** Brings the Connect button to the middle of the screen and puts the keyboard on it. */
function showConnectButton() {
  const connect = document.getElementById(CONNECT_BUTTON_ID);
  if (connect === null) return;
  connect.scrollIntoView({ block: "center" });
  connect.focus({ preventScroll: true });
}

export function ConnectRow({ wallet }: { wallet: WalletView }) {
  if (wallet.kind === "connected") {
    const { balances } = wallet;
    return (
      <div className="send-connect">
        <p className="send-wallet">
          <span>{shortHex(wallet.address)}</span>
          {balances === null ? null : (
            <>
              <span className="send-wallet-dot">{" · "}</span>
              <span>{truncateUnits(balances.usdt, balances.usdtDecimals, 2)} USDT</span>
              <span className="send-wallet-dot">{" · "}</span>
              <span>{truncateUnits(balances.bnb, 18, 4)} BNB</span>
            </>
          )}
          <button type="button" className="send-link send-link-small send-wallet-out" onClick={wallet.onDisconnect}>
            Disconnect
          </button>
        </p>
        {balances !== null && balances.bnb < LOW_BNB ? (
          <p className="send-pending-text">You need a little BNB for network fees, about five US cents&apos; worth.</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="send-connect">
      <button
        type="button"
        id={CONNECT_BUTTON_ID}
        className="send-primary send-primary-tall"
        disabled={wallet.kind !== "disconnected"}
        onClick={wallet.kind === "disconnected" ? wallet.onConnect : undefined}
      >
        Connect your wallet
      </button>
      <p className="send-hint">Binance Wallet or MetaMask, on BNB Chain. You pay in USDT.</p>
      {wallet.kind === "unavailable" ? <p className="send-pending-text">Wallet connection is not available right now. Try again later.</p> : null}
    </div>
  );
}

export type FormProps = {
  stocks: StocksState;
  selected: string | null;
  onSelect: (address: string) => void;
  onReloadStocks: () => void;
  stockName: string | null;
  price: number | null;
  choice: AmountChoice;
  otherText: string;
  onChoice: (choice: AmountChoice) => void;
  onOtherText: (text: string) => void;
  amount: number;
  shares: number;
  note: string;
  onNote: (text: string) => void;
  days: Days;
  onDays: (days: Days) => void;
  hint: string | null;
  canSend: boolean;
  onSend: () => void;
  locked: boolean;
};

export function SendFields(props: FormProps) {
  const { choice, otherText, amount, shares, stockName, price, note, days, locked } = props;
  const otherInput = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const left = MAX_NOTE_PLAINTEXT_BYTES - byteLength(note);

  useEffect(() => {
    if (choice === "other") otherInput.current?.focus();
  }, [choice]);

  return (
    <fieldset className="send-fields" disabled={locked}>
      <StockPicker state={props.stocks} selected={props.selected} onSelect={props.onSelect} onReload={props.onReloadStocks} />

      <div className="send-block">
        <div className="send-chips" role="group" aria-label="Amount in US dollars">
          {PRESETS.map((preset) => (
            <button type="button" className="send-chip" key={preset} aria-pressed={choice === preset} onClick={() => props.onChoice(preset)}>
              ${preset}
            </button>
          ))}
          {choice === "other" ? (
            <label className="send-chip send-chip-input" data-selected="true">
              <span aria-hidden="true">$</span>
              <input
                ref={otherInput}
                className="send-chip-field"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                aria-label="Amount in US dollars"
                placeholder="0.00"
                value={otherText}
                onChange={(event) => {
                  const next = acceptAmountText(event.target.value, Number(MAX_GIFT_USD));
                  if (next !== null) props.onOtherText(next);
                }}
              />
            </label>
          ) : (
            <button type="button" className="send-chip" aria-pressed={false} onClick={() => props.onChoice("other")}>
              Other
            </button>
          )}
        </div>
        {stockName !== null && price !== null && amount > 0 ? (
          <p className="send-hint">
            About {shares.toFixed(4)} shares of {stockName}
          </p>
        ) : choice === "other" && Number(otherText) > 0 && Number(otherText) < Number(MIN_GIFT_USD) ? (
          <p className="send-hint">A gift starts at ${MIN_GIFT_USD}.</p>
        ) : null}
      </div>

      <div className="send-block">
        <textarea
          className="send-textarea"
          rows={3}
          value={note}
          placeholder="Write them a note. Only they can read it."
          aria-label="A note for the person you are gifting"
          aria-describedby={noteId}
          onChange={(event) => props.onNote(clipToBytes(event.target.value, MAX_NOTE_PLAINTEXT_BYTES))}
        />
        <p className="send-counter" id={noteId}>
          {left} left
        </p>
      </div>

      <div className="send-block">
        <div className="send-chips" role="group" aria-label="How long the gift lasts">
          {LIFETIMES.map((option) => (
            <button type="button" className="send-chip" key={option} aria-pressed={days === option} onClick={() => props.onDays(option)}>
              {option} days
            </button>
          ))}
        </div>
        <p className="send-hint">If they don&apos;t open it in time, you can take it back.</p>
      </div>

      <dl className="send-summary">
        <div className="send-summary-row">
          <dt>THE SHARE</dt>
          <dd>{amount > 0 ? usd(amount) : "0.00"} USDT</dd>
        </div>
        <div className="send-summary-row">
          <dt>GIFT WRAP</dt>
          <dd>$0.05 (b402)</dd>
        </div>
        <div className="send-summary-row">
          <dt>NETWORK FEES</dt>
          <dd>a few cents of BNB</dd>
        </div>
      </dl>

      <button type="button" className="send-primary send-primary-tall" disabled={!props.canSend} onClick={props.onSend}>
        Send the gift
      </button>
      {props.hint === null ? null : (
        <p className="send-hint" role="status">
          {props.hint === CONNECT_FIRST ? (
            <button type="button" className="send-hint-button" onClick={showConnectButton}>
              {props.hint}
            </button>
          ) : (
            props.hint
          )}
        </p>
      )}
    </fieldset>
  );
}
