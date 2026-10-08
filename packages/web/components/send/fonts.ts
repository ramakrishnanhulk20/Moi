import { Fraunces } from "next/font/google";

// The root layout loads Fraunces upright only, so the italic cut is loaded here, the same way the
// hero loads it. Without it the browser would slant the upright letters and the title would look faked.
export const displayItalic = Fraunces({
  subsets: ["latin"],
  style: ["italic"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});
