import type { Metadata } from "next";
import { headers } from "next/headers";
import { MoiPrivy } from "@/components/privy/MoiPrivy";
import { SendPage } from "@/components/send/SendPage";

// The script nonce is per request, so this page must be rendered for each one.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Send a gift",
  description: "Pick a stock, pay in USDT, and get one link your friend opens with Google.",
};

export default async function Send() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <MoiPrivy nonce={nonce}>
      <SendPage />
    </MoiPrivy>
  );
}
