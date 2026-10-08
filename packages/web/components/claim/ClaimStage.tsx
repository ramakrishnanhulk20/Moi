"use client";

import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import { Certificate, type CertificateProps } from "@/components/hero/Certificate";
import { EnvelopeFallback } from "@/components/hero/EnvelopeFallback";
import { HeroStage } from "@/components/hero/HeroStage";
import { useMediaQuery } from "@/components/hero/useMediaQuery";

/**
 * What the envelope is doing. "closed" and "dimmed" rest with the seal on. "opening" plays the
 * opening and holds with the certificate half out until the claim returns. "half-open" is the same
 * hold with the glow off (a claim that was sent and then failed). "opened" finishes the story.
 * "claimed" is the finished picture, shown at once, for a gift somebody has already opened.
 */
export type SceneState = "closed" | "dimmed" | "opening" | "half-open" | "opened" | "claimed";

// Seconds into the opening story that EnvelopeScene reads from progress.value (claim layout).
const HOLD_AT = 1.6;
const SETTLE_AT = 2.8;
const HAND_END = 4.2;
const HAND_SECONDS = HAND_END - SETTLE_AT;

type Pose = "closed" | "open" | "done";

function poseOf(state: SceneState): Pose {
  if (state === "opened" || state === "claimed") return "done";
  if (state === "opening" || state === "half-open") return "open";
  return "closed";
}

/**
 * The box above the panel that holds the envelope and the certificate. The 3D scene is the hero's,
 * in its claim layout, and this component drives it with a timeline of seconds. Under reduced
 * motion no scene is mounted: each state is a still picture and a change between states is a
 * 200 ms fade.
 */
export function ClaimStage({ state, certificate }: { state: SceneState; certificate: CertificateProps | undefined }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const root = useRef<HTMLDivElement>(null);
  const [progress] = useState(() => ({ value: state === "claimed" ? HAND_END : 0 }));
  // The state in which the certificate reached the hold. The glow shows only while that is the state on screen.
  const [heldIn, setHeldIn] = useState<SceneState | null>(null);

  useEffect(() => {
    if (reduced) return;
    const box = root.current;
    if (!box) return;
    const showHand = () => box.style.setProperty("--hand", String(Math.min(1, Math.max(0, (progress.value - SETTLE_AT) / HAND_SECONDS))));
    // Every change goes through the timeline, so nothing here sets React state or the progress directly.
    const timeline = gsap.timeline({ onUpdate: showHand });
    const markHeld = (held: boolean) => () => setHeldIn(held ? state : null);
    // The story runs at one second per second, so each step lasts as long as the distance it covers.
    const toHold = (onComplete?: () => void) =>
      timeline.to(progress, { value: HOLD_AT, duration: Math.max(0, HOLD_AT - progress.value), ease: "none", onComplete });

    timeline.call(markHeld(false), [], 0);
    if (state === "claimed") {
      timeline.set(progress, { value: HAND_END }, 0).call(showHand, [], 0);
    } else if (state === "closed" || state === "dimmed") {
      if (progress.value > 0) timeline.to(progress, { value: 0, duration: progress.value, ease: "none" });
      else timeline.call(showHand, [], 0);
    } else if (state === "opening") {
      toHold(markHeld(true));
    } else if (state === "half-open") {
      toHold();
    } else {
      toHold();
      timeline.to(progress, { value: SETTLE_AT, duration: SETTLE_AT - HOLD_AT, ease: "none" });
      timeline.to(progress, { value: HAND_END, duration: HAND_SECONDS, ease: "none" });
    }
    return () => {
      timeline.kill();
    };
  }, [state, reduced, progress]);

  const glow = heldIn === state && state === "opening";

  const pose = poseOf(state);

  return (
    <div className="claim-stage" ref={root} data-state={state} data-glow={glow ? "on" : "off"} data-pose={pose} aria-hidden="true">
      {reduced ? (
        <div className="claim-static">
          <div className="claim-static-closed">
            <EnvelopeFallback open={false} />
          </div>
          <div className="claim-static-open">
            <EnvelopeFallback open />
          </div>
          <div className="claim-static-cert">
            <Certificate {...certificate} />
          </div>
        </div>
      ) : (
        <HeroStage layout="claim" progress={progress} certificate={certificate} />
      )}
      {state === "claimed" ? <span className="claim-stamp">OPENED</span> : null}
    </div>
  );
}
