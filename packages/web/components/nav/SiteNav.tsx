import Link from "next/link";
import { VMark } from "@/components/hero/VMark";
import "./nav.css";

/**
 * The top bar. On the landing page the wordmark is plain text and the "Send a gift" button is
 * shown. On the send page the button is hidden, the wordmark links home, and the in-page anchors
 * point back at the landing page.
 */
export function SiteNav({ page = "landing" }: { page?: "landing" | "send" }) {
  const onSend = page === "send";
  const brand = (
    <>
      <VMark width={12} />
      <span className="site-wordmark">Moi</span>
    </>
  );

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
        {onSend ? null : (
          <Link className="site-nav-cta" href="/send" prefetch={false}>
            Send a gift
          </Link>
        )}
      </div>
    </nav>
  );
}
