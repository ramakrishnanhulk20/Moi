import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ClaimPage } from "@/components/claim/ClaimPage";

// The script nonce is per request, so this page must be rendered for each one.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "A gift for you",
  description: "Someone sent you a real share. Open it with Google: no wallet, no fees.",
  robots: { index: false, follow: false },
  // A page's own openGraph and twitter objects replace the layout's whole object, so the shared
  // type, site name and card size are repeated here.
  openGraph: { type: "website", siteName: "Moi", title: "A gift for you" },
  twitter: { card: "summary_large_image", title: "A gift for you" },
};

const GIFT_ID = /^[1-9][0-9]{0,9}$/;

export default async function GiftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GIFT_ID.test(id)) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <ClaimPage giftId={id} nonce={nonce} />;
}
