"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import dynamic from "next/dynamic";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Certificate, type CertificateProps } from "./Certificate";
import { EnvelopeFallback } from "./EnvelopeFallback";
import type { HeroLayout } from "./EnvelopeScene";
import { useMediaQuery } from "./useMediaQuery";

// The 3D code is a separate download, started only after the first paint, so the hero copy never waits on it.
const EnvelopeScene = dynamic(() => import("./EnvelopeScene").then((module) => module.EnvelopeScene), { ssr: false });

// The claim page's scene fills its own box: the envelope rests in the middle and the certificate lands
// in the middle at 0.92 of the box width.
const CLAIM_LAYOUT: HeroLayout = { restX: 0.5, restY: 0.5, finalX: 0.5, finalY: 0.5, finalW: 0.92 };

/** A browser with no WebGL makes the canvas throw. This keeps that from taking the page down with it. */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

// The numbers behind the poses live in lab.css as custom properties on the hero section, so the
// closed-envelope fallback and the reduced-motion composite use the very same positions.
function readLayout(section: HTMLElement, layout: HeroLayout): void {
  const style = getComputedStyle(section);
  const read = (name: string, fallback: number) => {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };
  layout.restX = read("--rest-x", layout.restX);
  layout.restY = read("--rest-y", layout.restY);
  layout.finalX = read("--final-x", layout.finalX);
  layout.finalY = read("--final-y", layout.finalY);
  layout.finalW = read("--final-w", layout.finalW);
}

/**
 * Everything behind the copy: the stage light, the 3D envelope and certificate, and the closed
 * envelope drawing that stands in until the first frame. It also owns the scroll: it pins the hero,
 * publishes the progress as --p on the hero section (CSS reads it, React never re-renders per
 * frame) and hands the same number to the scene. Reduced motion gets a still composite instead:
 * no canvas, no pin, the certificate already in its final pose.
 */
export function HeroStage({
  layout = "hero",
  progress: driven,
  certificate,
}: {
  layout?: "hero" | "claim";
  progress?: { value: number };
  certificate?: CertificateProps;
} = {}) {
  const claim = layout === "claim";
  const compact = useMediaQuery("(max-width: 1023px)");
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const stage = useRef<HTMLDivElement>(null);
  const cardLayer = useRef<HTMLDivElement>(null);
  const [ownProgress] = useState(() => ({ value: 0 }));
  // In the claim layout the claim page drives the scene by time and hands its own progress in.
  const progress = driven ?? ownProgress;
  const [sceneLayout] = useState<HeroLayout>(() =>
    claim ? { ...CLAIM_LAYOUT } : { restX: 0.74, restY: 0.5, finalX: 0.68, finalY: 0.58, finalW: 0.54 },
  );
  const [sceneMounted, setSceneMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [inView, setInView] = useState(true);

  useEffect(() => {
    if (claim) return;
    const element = stage.current;
    const section = element?.closest("section");
    if (!element || !section) return;
    const apply = () => {
      readLayout(section, sceneLayout);
      // The spotlight sits on the certificate's final centre. Phones centre it in the box.
      section.style.setProperty("--cx", compact ? "50%" : `${(sceneLayout.finalX * 100).toFixed(2)}%`);
      section.style.setProperty("--cy", compact ? "50%" : `${(sceneLayout.finalY * 100).toFixed(2)}%`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [claim, compact, sceneLayout]);

  useEffect(() => {
    if (reduced) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSceneMounted(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [reduced]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || claim) return;
    const element = stage.current;
    const section = element?.closest("section");
    if (!element || !section) return;
    gsap.registerPlugin(ScrollTrigger);
    const context = gsap.context(() => {
      gsap.to(progress, {
        value: 1,
        ease: "none",
        onUpdate: () => section.style.setProperty("--p", progress.value.toFixed(4)),
        scrollTrigger: compact
          ? {
              // On phones and tablets only the scene box is pinned, once it sits mid-screen.
              trigger: element,
              start: "center center",
              end: () => `+=${Math.round(window.innerHeight * 1.4)}`,
              pin: true,
              // The hero is a flex column, and ScrollTrigger skips the spacing under a flex parent unless it is asked outright.
              pinSpacing: true,
              scrub: 0.6,
              anticipatePin: 1,
              invalidateOnRefresh: true,
            }
          : {
              trigger: section,
              start: "top top",
              end: () => `+=${Math.round(window.innerHeight * 2.2)}`,
              pin: true,
              scrub: 0.6,
              anticipatePin: 1,
              invalidateOnRefresh: true,
            },
      });
    }, section);
    // Fonts change the height of the copy, which moves the pin points.
    void document.fonts.ready.then(() => ScrollTrigger.refresh());
    return () => {
      context.revert();
      section.style.removeProperty("--p");
      progress.value = 0;
    };
  }, [reduced, claim, compact, progress]);

  return (
    <div className="hero-stage" ref={stage}>
      {claim ? null : (
        <>
          <div className="hero-light hero-light-a" aria-hidden="true" />
          <div className="hero-light hero-light-b" aria-hidden="true" />
        </>
      )}
      {reduced && !claim ? (
        <div className="hero-static">
          <div className="hero-static-envelope" aria-hidden="true">
            <EnvelopeFallback open />
          </div>
          <div className="hero-static-cert">
            <Certificate />
          </div>
        </div>
      ) : (
        <>
          <div className="hero-stage-canvas" aria-hidden="true">
            {sceneMounted ? (
              <SceneBoundary>
                <EnvelopeScene
                  progress={progress}
                  layout={sceneLayout}
                  compact={compact}
                  mode={layout}
                  certificate={certificate}
                  active={inView}
                  layer={cardLayer}
                  onFirstFrame={() => setReady(true)}
                />
              </SceneBoundary>
            ) : null}
            <div className="hero-card-layer" ref={cardLayer} />
          </div>
          <div className="hero-fallback" data-gone={ready ? "true" : "false"}>
            <EnvelopeFallback open={false} />
          </div>
        </>
      )}
    </div>
  );
}
