"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useEffect } from "react";

/** The element a link like /#judges names, or null when the address has no hash or nothing on the page matches it. */
function hashTarget(): HTMLElement | null {
  const raw = window.location.hash.slice(1);
  if (raw === "") return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // A broken escape in the address: the raw text is the best guess.
  }
  return document.getElementById(id);
}

/**
 * Starts Lenis and hands its scroll position to GSAP ScrollTrigger, so pinned scenes follow the
 * smoothed scroll. Under reduced motion nothing starts: the page scrolls natively.
 *
 * It also lands a page that was opened with a hash (/#how, /#judges). The browser jumps to the
 * hash before the pinned scenes have added their spacing, so it ends up in the wrong place. Once
 * fonts are ready and the pins are measured, this jumps again to where the section really is.
 */
export function SmoothScroll() {
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const instance = reduced ? null : new Lenis({ lerp: 0.1, smoothWheel: true });
    let tick: ((time: number) => void) | null = null;
    if (instance) {
      instance.on("scroll", ScrollTrigger.update);
      tick = (time: number) => instance.raf(time * 1000);
      gsap.ticker.add(tick);
      // Lenis already smooths the motion; a catch-up pause after a slow frame would make it stutter.
      gsap.ticker.lagSmoothing(0);
    }

    let cancelled = false;
    let frame = 0;
    const land = () => {
      if (cancelled) return;
      const target = hashTarget();
      if (target === null) return;
      ScrollTrigger.refresh();
      if (instance) {
        // The pins just made the page taller. Lenis caps a jump at the height it last measured.
        instance.resize();
        instance.scrollTo(target, { immediate: true, offset: 0 });
      } else {
        target.scrollIntoView({ block: "start", behavior: "instant" });
      }
    };
    // Two frames after fonts are ready, so the other sections have made their pins before the measure.
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(land);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (tick) gsap.ticker.remove(tick);
      instance?.destroy();
    };
  }, []);
  return null;
}
