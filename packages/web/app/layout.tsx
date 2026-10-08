import type { Metadata } from "next";
import { Fraunces, JetBrains_Mono, Manrope } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  variable: "--font-display",
  display: "swap",
});

const body = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

// Each response has its own script nonce from proxy.ts, and only a page rendered for that request
// can carry it; a page prerendered at build time would have its scripts blocked.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.MOI_PUBLIC_ORIGIN || "http://localhost:3000"),
  title: { default: "Moi: give someone their first stock", template: "%s · Moi" },
  description: "Send a real share of Nvidia, Apple or the S&P 500 as a link. Your friend opens it, signs in with Google, and owns it.",
  openGraph: { type: "website", siteName: "Moi" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="bg-bg text-ink font-body antialiased">{children}</body>
    </html>
  );
}
