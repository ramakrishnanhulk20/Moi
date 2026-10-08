"use client";

import { useEffect, useRef } from "react";
import { useShareFigure } from "@/lib/stocks";
import { useMediaQuery } from "./useMediaQuery";
import { V_MARK_PATH } from "./VMark";
import "./certificate.css";

const WIDTH = 880;
const HEIGHT = 568;
const SHEEN_ANGLE = 35;
// The "SHARES OF ..." line is squeezed to this width when a long name would run past the inner frame.
const HOLDING_MAX_WIDTH = 640;

// A single stroke, "a friend" in cursive, drawn in a 190 by 66 box. The pen never lifts.
const HAND_PATH =
  "M 18 32 C 8 26 2 36 4 43 C 6 50 16 50 22 38 C 24 34 24 30 22 28 C 21 38 22 46 28 47 C 33 48 38 42 42 40 " +
  "C 48 38 56 10 64 6 C 70 3 72 12 66 24 C 60 38 54 56 52 60 C 50 64 44 62 48 56 C 52 50 62 44 76 44 " +
  "C 79 42 80 34 81 30 C 85 30 89 32 91 36 C 92 40 90 44 96 44 C 100 44 100 36 101 31 C 102 40 102 44 108 45 " +
  "C 112 45 114 38 118 34 C 126 30 124 40 116 40 C 112 40 116 48 124 46 C 128 45 130 36 132 30 " +
  "C 133 38 134 44 137 44 C 140 44 140 36 142 32 C 143 40 144 46 148 46 C 152 46 154 40 158 38 " +
  "C 160 36 152 34 150 40 C 148 47 158 50 162 40 C 164 34 164 20 168 6 C 171 2 174 8 170 20 " +
  "C 167 32 166 44 170 46 C 174 47 180 44 186 38";

const fixed = (value: number) => value.toFixed(1);

type Edge = { vertical: boolean; centre: number; from: number; to: number };

// The four bands between the inner frame line and the inner border line.
const EDGES: readonly Edge[] = [
  { vertical: false, centre: 58, from: 24, to: 856 },
  { vertical: false, centre: 510, from: 24, to: 856 },
  { vertical: true, centre: 58, from: 24, to: 544 },
  { vertical: true, centre: 822, from: 24, to: 544 },
];

// One sine wave as joined quadratic curves, one per half wave. The first curve starts a little
// before the band does, by the phase, and the clip path hides whatever runs past the band.
function sineWave(edge: Edge, half: number, amplitude: number, phaseTurns: number): string {
  const at = (along: number, across: number) => (edge.vertical ? `${fixed(across)} ${fixed(along)}` : `${fixed(along)} ${fixed(across)}`);
  let position = edge.from - phaseTurns * half * 2;
  let path = `M${at(position, edge.centre)}Q${at(position + half / 2, edge.centre - 2 * amplitude)} ${at(position + half, edge.centre)}`;
  position += half;
  while (position < edge.to + half) {
    position += half;
    path += `T${at(position, edge.centre)}`;
  }
  return path;
}

// Six waves of one length, shifted against each other, weave into a braid; two fine ripples sit on top.
const BAND_WAVES: readonly string[] = EDGES.flatMap((edge) => [
  ...[0, 1, 2, 3, 4, 5].map((step) => sineWave(edge, 34, 15, step / 6)),
  ...[0, 0.5].map((step) => sineWave(edge, 17, 5, step)),
]);

// A rosette: a circle whose radius swells and shrinks, repeated at turning angles so the curves overlap.
function rosette(radius: number, depth: number, petals: number, turn: number): string {
  const steps = 72;
  let path = "";
  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    const r = radius + depth * Math.sin(petals * angle + turn);
    path += `${step === 0 ? "M" : "L"}${fixed(r * Math.cos(angle))} ${fixed(r * Math.sin(angle))}`;
  }
  return `${path}Z`;
}

const ROSETTES: readonly string[] = [0, 1, 2, 3, 4].map((index) => rosette(21, 5, 9, (index * Math.PI) / 9 / 2.5));
const CORNERS: readonly (readonly [number, number])[] = [
  [58, 58],
  [822, 58],
  [58, 510],
  [822, 510],
];

// The ring the guilloché is clipped to: outer edge inset 30, inner edge inset 86.
const BAND_CLIP = "M30 30H850V538H30Z M86 86H794V482H86Z";

const SEAL = { x: 440, y: 432, r: 34 };
const SEAL_ARC = `M${SEAL.x - 26} ${SEAL.y} a26 26 0 1 1 52 0 a26 26 0 1 1 -52 0`;

/**
 * What a certificate shows when it is not the hero's own. `figure` is the share count, `holding`
 * the whole "SHARES OF ..." line and `worth` the whole worth line, or null to leave that line out.
 * Left out, each one falls back to the live NVIDIA figure the hero shows.
 */
export type CertificateProps = { figure?: string; holding?: string; worth?: string | null };

/**
 * The share certificate drawn as one SVG. The figure is 1 / the live NVDAB price; while it loads
 * there is a grey bar, and if the price cannot be read the figure and the worth line are left out.
 * The handwriting is drawn by the hero's scroll progress (--p on the hero section, read in CSS), not
 * by a timer, and a light sheen follows the cursor on desktop once the certificate has landed.
 */
export function Certificate({ figure: given, holding, worth }: CertificateProps = {}) {
  const live = useShareFigure();
  const figure = given === undefined ? live : ({ state: "ready", text: given } as const);
  const worthLine = worth === undefined ? (figure.state === "ready" ? "WORTH $1.00 TODAY" : null) : worth;
  const holdingText = useRef<SVGTextElement>(null);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const desktop = useMediaQuery("(hover: hover) and (pointer: fine) and (min-width: 1024px)");
  const root = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLDivElement>(null);
  const hand = useRef<SVGPathElement>(null);

  // The dash pattern needs the real length of the pen stroke. It is measured once here and read by CSS.
  useEffect(() => {
    const path = hand.current;
    if (path) path.style.setProperty("--hand-len", path.getTotalLength().toFixed(1));
  }, []);

  // A name that would run past the inner frame is squeezed to fit. Measured after the font loads.
  useEffect(() => {
    const text = holdingText.current;
    if (!text || holding === undefined) return;
    const fit = () => {
      text.removeAttribute("textLength");
      text.removeAttribute("lengthAdjust");
      if (text.getComputedTextLength() > HOLDING_MAX_WIDTH) {
        text.setAttribute("textLength", String(HOLDING_MAX_WIDTH));
        text.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    };
    fit();
    void document.fonts.ready.then(fit);
  }, [holding]);

  useEffect(() => {
    const element = root.current;
    const band = sheen.current;
    if (!element || !band || !desktop || reduced) return;
    const angle = (SHEEN_ANGLE * Math.PI) / 180;
    let target = -40;
    let current = -40;
    let frame = 0;
    const step = () => {
      current += (target - current) * 0.12;
      band.style.setProperty("--sheen", `${current.toFixed(2)}%`);
      frame = Math.abs(target - current) > 0.05 ? requestAnimationFrame(step) : 0;
    };
    const onMove = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const length = box.width * Math.sin(angle) + box.height * Math.cos(angle);
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      target = Math.min(130, Math.max(-30, ((dx * Math.sin(angle) - dy * Math.cos(angle)) / length + 0.5) * 100));
      if (frame === 0) frame = requestAnimationFrame(step);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [desktop, reduced]);

  return (
    <div className="cert" ref={root}>
      <svg className="cert-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={holding === undefined ? "A Moi certificate: a friend owns shares of NVIDIA Corporation" : `A Moi certificate: a friend owns ${holding}`}>
        <defs>
          <clipPath id="cert-band-clip">
            <path d={BAND_CLIP} clipRule="evenodd" />
          </clipPath>
          <radialGradient id="cert-glow" cx="50%" cy="45%" r="70%">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.06" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.28" />
          </radialGradient>
          <linearGradient id="cert-seal-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--gold)" }} />
            <stop offset="0.6" style={{ stopColor: "var(--gold)" }} />
            <stop offset="1" style={{ stopColor: "var(--gold-deep)" }} />
          </linearGradient>
          <g id="cert-rosette">
            {ROSETTES.map((d, index) => (
              <path key={index} d={d} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
          <path id="cert-seal-arc" d={SEAL_ARC} />
        </defs>

        <rect width={WIDTH} height={HEIGHT} className="cert-paper" />
        <rect width={WIDTH} height={HEIGHT} fill="url(#cert-glow)" />

        <g clipPath="url(#cert-band-clip)" className="cert-guilloche">
          {BAND_WAVES.map((d, index) => (
            <path key={index} d={d} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        {CORNERS.map(([x, y]) => (
          <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
            <circle r={27} className="cert-paper" />
            <use href="#cert-rosette" className="cert-guilloche" />
          </g>
        ))}

        <rect x={14} y={14} width={WIDTH - 28} height={HEIGHT - 28} className="cert-frame cert-frame-outer" />
        <rect x={24} y={24} width={WIDTH - 48} height={HEIGHT - 48} className="cert-frame cert-frame-inner" />
        <rect x={86} y={86} width={WIDTH - 172} height={HEIGHT - 172} className="cert-frame cert-frame-edge" />

        <path d={V_MARK_PATH} transform="translate(425.8 97) scale(1.18)" className="cert-vmark" />
        <text x={440 + 5.7} y={158} textAnchor="middle" className="cert-moi">
          MOI
        </text>

        <text x={440} y={190} textAnchor="middle" className="cert-mono cert-mono-12">
          THIS CERTIFIES THAT
        </text>

        <g transform="translate(352 195) scale(0.95)">
          <path d={HAND_PATH} className="cert-hand" ref={hand} />
        </g>

        <text x={440} y={278} textAnchor="middle" className="cert-mono cert-mono-12">
          OWNS
        </text>

        {figure.state === "ready" ? (
          <text x={440} y={338} textAnchor="middle" className="cert-figure">
            {figure.text}
          </text>
        ) : figure.state === "loading" ? (
          <rect x={366} y={296} width={148} height={46} rx={4} className="skeleton-svg" />
        ) : null}

        <text x={440} y={366} textAnchor="middle" className="cert-mono cert-mono-13" ref={holdingText}>
          {holding ?? "SHARES OF NVIDIA CORPORATION"}
        </text>

        {worthLine !== null ? (
          <text x={440} y={386} textAnchor="middle" className="cert-mono cert-mono-11">
            {worthLine}
          </text>
        ) : null}

        <text x={190} y={426} textAnchor="middle" className="cert-mono cert-mono-10">
          HELD ON
        </text>
        <text x={190} y={444} textAnchor="middle" className="cert-mono cert-mono-10">
          BNB CHAIN
        </text>
        <text x={690} y={426} textAnchor="middle" className="cert-mono cert-mono-10">
          CLAIMED
        </text>
        <text x={690} y={444} textAnchor="middle" className="cert-mono cert-mono-10">
          WITH ONE LINK
        </text>

        <circle cx={SEAL.x} cy={SEAL.y} r={SEAL.r} fill="url(#cert-seal-gold)" className="cert-seal" />
        <circle cx={SEAL.x} cy={SEAL.y} r={SEAL.r - 2.5} className="cert-seal-ring" />
        <circle cx={SEAL.x} cy={SEAL.y} r={21} className="cert-seal-ring" />
        <text className="cert-seal-text">
          <textPath href="#cert-seal-arc" textLength={158} lengthAdjust="spacing">
            MOI · MOI · MOI · MOI ·
          </textPath>
        </text>
        <path d={V_MARK_PATH} transform={`translate(${SEAL.x - 13.2} ${SEAL.y - 8}) scale(1.2)`} className="cert-seal-v" />
      </svg>
      <div className="cert-sheen" ref={sheen} aria-hidden="true" />
    </div>
  );
}
