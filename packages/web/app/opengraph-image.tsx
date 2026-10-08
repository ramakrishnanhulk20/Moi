import { ImageResponse } from "next/og";
import { loadFonts, ShareCard } from "./og/og";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Moi: give someone their first stock with one link";

export default async function Image() {
  return new ImageResponse(<ShareCard meta="A GIFT IN ONE LINK" lineOne="Give someone" lineTwo="their first stock." />, {
    ...size,
    fonts: await loadFonts(),
  });
}
