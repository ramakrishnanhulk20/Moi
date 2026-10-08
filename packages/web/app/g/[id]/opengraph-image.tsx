import { ImageResponse } from "next/og";
import { loadFonts, ShareCard } from "../../og/og";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "A Moi gift: open it with Google, no wallet needed";

export default async function Image() {
  return new ImageResponse(<ShareCard meta="A GIFT FOR YOU" lineOne="Someone sent you" lineTwo="a real share." />, {
    ...size,
    fonts: await loadFonts(),
  });
}
