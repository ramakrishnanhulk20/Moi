"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { VMark } from "@/components/hero/VMark";
import "./nav.css";

/**
 * The top bar. On the landing page the wordmark is plain text and the "Send a gift" button is
 * shown. On the send page the button is hidden, the wordmark links home, and the in-page anchors
 * point back at the landing page. Below 768px the three text links fold into a MENU sheet.
 */
export function SiteNav({ page = "landing" }: { page?: "landing" | "send" }) {
  const onSend = page === "send";
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const sheetId = useId();
  const brand = (
    <>
      <VMark width={12} />
      <span className="site-wordmark">Moi</span>
    </>
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    // A tap on MENU itself is the toggle's job, so only taps elsewhere count as outside.
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (sheet.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <nav className="site-nav" aria-label="Main">
      {onSend ? (
        <Link className="site-brand site-brand-link" href="/" aria-label="Moi, home">
          {brand}
        </Link>
      ) : (
        <div className="site-brand">{brand}</div>
      )}
      <div className="site-nav-right">
        <div className="site-links">
          <a className="site-link" href={onSend ? "/#how" : "#how"}>
            How it works
          </a>
          <a className="site-link" href={onSend ? "/#judges" : "#judges"}>
            For judges
          </a>
          <Link className="site-link" href="/docs" prefetch={false}>
            Docs
          </Link>
        </div>
        <button
          type="button"
          className="site-menu-button"
          ref={button}
          aria-expanded={open}
          aria-controls={sheetId}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="site-menu-label">{open ? "CLOSE" : "MENU"}</span>
        </button>
        {onSend ? null : (
          <Link className="site-nav-cta" href="/send" prefetch={false}>
            Send a gift
          </Link>
        )}
      </div>
      <div className="site-sheet" id={sheetId} ref={sheet} hidden={!open}>
        <a className="site-sheet-link" href={onSend ? "/#how" : "#how"} onClick={close}>
          <span className="site-sheet-label">How it works</span>
        </a>
        <a className="site-sheet-link" href={onSend ? "/#judges" : "#judges"} onClick={close}>
          <span className="site-sheet-label">For judges</span>
        </a>
        <Link className="site-sheet-link" href="/docs" prefetch={false} onClick={close}>
          <span className="site-sheet-label">Docs</span>
        </Link>
        {onSend ? (
          <Link className="site-sheet-link" href="/" prefetch={false} onClick={close}>
            <span className="site-sheet-label">Home</span>
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
