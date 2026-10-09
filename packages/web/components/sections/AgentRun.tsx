"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Grain } from "@/components/hero/Grain";
import { PROOF, txUrl } from "@/lib/proof";
import { ProofLine } from "./HowItWorks";
import "./sections.css";

const TYPE_MS_PER_CHARACTER = 28;
const LINE_STEP_MS = 180;
const VISIBLE_FRACTION = 0.4;

type RunLine = { kind: "command" | "output"; text: string };

// The words of the gift 2 mainnet run of 8 Oct 2026, from scratchpad/live/agent-gift-2.log. scratchpad/wo7e/clean-log.mjs drops npm's own echo
// lines and the blank lines, and cuts the drive and folders in front of the gifts folder from the saved-link path.
const RUN: readonly RunLine[] = [
  { kind: "command", text: "npm run moi --workspace=@moi/agent -- gift NVDA --use-held 0.004220084869347249 --note Happy Diwali! Your first share of Nvidia, from Moi. --yes" },
  { kind: "output", text: "Checking your Binance agent wallet." },
  { kind: "output", text: "Gifting 0.004220084869347249 NVDAB you already hold; nothing will be bought." },
  { kind: "output", text: "Binance previewed it: the simulation passed." },
  { kind: "output", text: "Binance previewed it: the simulation passed." },
  { kind: "output", text: "Gift 2 is locked in the vault. Paying the gift wrapping fee through b402." },
  { kind: "output", text: "Gift 2 is ready. The link is saved in gifts\\gift-2.txt. Send it to your friend." },
];

const COMMAND = RUN.find((line) => line.kind === "command")?.text ?? "";
const OUTPUT = RUN.filter((line) => line.kind === "output");
const KNOWN_HASHES: ReadonlySet<string> = new Set(Object.values(PROOF).map((hash) => hash.toLowerCase()));

/** Plain text, except that a transaction hash from PROOF becomes a link to BscScan. */
function withHashLinks(text: string): ReactNode {
  return text.split(/(0x[0-9a-fA-F]{64})/).map((part, index) =>
    KNOWN_HASHES.has(part.toLowerCase()) ? (
      <a className="gold-link" href={txUrl(part)} target="_blank" rel="noopener noreferrer" key={index}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}

// Types the command, then shows the output one line at a time. A blank line comes in with the line after it.
function playRun(terminal: HTMLElement, typed: HTMLElement, rows: readonly HTMLElement[]): () => void {
  const timers: number[] = [];
  let typedLength = 0;
  terminal.dataset.phase = "typing";
  const typing = window.setInterval(() => {
    typedLength += 1;
    typed.textContent = COMMAND.slice(0, typedLength);
    if (typedLength < COMMAND.length) return;
    window.clearInterval(typing);
    terminal.dataset.phase = "output";
    let step = 0;
    let blanks: HTMLElement[] = [];
    OUTPUT.forEach((line, index) => {
      const row = rows[index];
      if (!row) return;
      if (line.text === "") {
        blanks.push(row);
        return;
      }
      step += 1;
      const group = [...blanks, row];
      blanks = [];
      timers.push(
        window.setTimeout(() => {
          for (const member of group) member.dataset.shown = "true";
        }, step * LINE_STEP_MS),
      );
    });
    timers.push(
      window.setTimeout(() => {
        for (const member of blanks) member.dataset.shown = "true";
        terminal.dataset.phase = "done";
      }, (step + 1) * LINE_STEP_MS),
    );
  }, TYPE_MS_PER_CHARACTER);
  return () => {
    window.clearInterval(typing);
    for (const timer of timers) window.clearTimeout(timer);
  };
}

export function AgentRun() {
  const terminal = useRef<HTMLDivElement>(null);
  const typed = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = terminal.current;
    const typedText = typed.current;
    if (!element || !typedText) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rows = Array.from(element.querySelectorAll<HTMLElement>(".agent-line-output"));
    // Armed: the prompt waits empty and the output is hidden until the terminal is on screen.
    element.dataset.phase = "armed";
    typedText.textContent = "";
    let stop: () => void = () => undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        stop = playRun(element, typedText, rows);
      },
      { threshold: VISIBLE_FRACTION },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      stop();
      typedText.textContent = COMMAND;
      delete element.dataset.phase;
      for (const row of rows) delete row.dataset.shown;
    };
  }, []);

  return (
    <section className="agent" aria-labelledby="agent-title">
      <div className="agent-text">
        <p className="sec-label">THE AGENT</p>
        <h2 className="agent-title" id="agent-title">
          Or let your AI agent send it.
        </h2>
        <p className="agent-body">
          Moi&apos;s agent runs on the Binance Agentic Wallet. You set the spending limits in the Binance app. Inside them, the agent buys the
          share or gifts one it already holds, locks the gift and pays the 5-cent wrap with b402. Gift 2 on mainnet was made this way,
          from a share the agent already held.
        </p>
        <div className="agent-proofs">
          <ProofLine words="gift 2 wrapped with b402" hash={PROOF.gift2Wrapped} />
          <ProofLine words="gift 2 claimed" hash={PROOF.gift2Claimed} />
        </div>
      </div>

      <div className="agent-stage">
        <p className="agent-recorded">RECORDED FROM THE LIVE RUN, 8 OCT 2026</p>
        <div className="agent-terminal" ref={terminal}>
          <div className="agent-titlebar">moi · binance agentic wallet</div>
          <div className="agent-screen">
            <div className="agent-line agent-line-command">
              <span className="agent-prompt">$ </span>
              <span ref={typed}>{COMMAND}</span>
              <span className="agent-cursor agent-cursor-inline" aria-hidden="true" />
            </div>
            {OUTPUT.map((line, index) => (
              <div className="agent-line agent-line-output" key={index}>
                {line.text === "" ? " " : withHashLinks(line.text)}
              </div>
            ))}
            <div className="agent-line agent-line-end">
              <span className="agent-cursor" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
      <Grain />
    </section>
  );
}
