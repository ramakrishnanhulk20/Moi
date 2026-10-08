import { useSyncExternalStore } from "react";

/**
 * True when the media query matches in the browser. The server and the first hydration render
 * both answer false, so markup never differs between server and client.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
