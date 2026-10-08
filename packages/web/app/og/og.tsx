import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageResponse } from "next/og";

// Font sources (all SIL Open Font License, licence text sits next to each file):
// Fraunces-Bold.woff: https://cdn.jsdelivr.net/npm/@fontsource/fraunces@5.3.0/files/fraunces-latin-700-normal.woff
// Fraunces-BoldItalic.woff: https://cdn.jsdelivr.net/npm/@fontsource/fraunces@5.3.0/files/fraunces-latin-700-italic.woff
// JetBrainsMono-Medium.ttf: https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/ttf/JetBrainsMono-Medium.ttf
// The card renderer cannot read variable fonts, which is why these are fixed-weight files.
type CardFonts = NonNullable<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]>;

let fonts: Promise<CardFonts> | undefined;

export function loadFonts(): Promise<CardFonts> {
  fonts ??= (async () => {
    const read = (file: string) => readFile(join(process.cwd(), "app", "og", file));
    const [bold, boldItalic, mono] = await Promise.all([
      read("Fraunces-Bold.woff"),
      read("Fraunces-BoldItalic.woff"),
      read("JetBrainsMono-Medium.ttf"),
    ]);
    return [
      { name: "Fraunces", data: bold, weight: 700, style: "normal" },
      { name: "Fraunces", data: boldItalic, weight: 700, style: "italic" },
      { name: "JetBrains Mono", data: mono, weight: 500, style: "normal" },
    ];
  })();
  return fonts;
}

const BG = "#0E0809";
const GOLD = "#F2B13D";
const PAPER = "#F6EFE6";
const MUTED = "#B9AEA4";

const V_MARK_PATH = "M1 1 L12 12 L23 1";

function VMarkSvg({ width, color }: { width: number; color: string }) {
  return (
    <svg width={width} height={(width * 14) / 24} viewBox="0 0 24 14" fill="none">
      <path d={V_MARK_PATH} stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const ENVELOPE_W = 380;
const ENVELOPE_H = 250;
const FLAP_Y = ENVELOPE_H * 0.55;
const SEAL = 64;
const SEAL_MARK_W = 32;
const SEAL_MARK_H = (SEAL_MARK_W * 14) / 24;

function Envelope() {
  return (
    <div
      style={{
        position: "absolute",
        left: 930 - ENVELOPE_W / 2,
        top: 330 - ENVELOPE_H / 2,
        width: ENVELOPE_W,
        height: ENVELOPE_H,
        display: "flex",
        transform: "rotate(-6deg)",
      }}
    >
      <svg width={ENVELOPE_W} height={ENVELOPE_H} viewBox={`0 0 ${ENVELOPE_W} ${ENVELOPE_H}`} fill="none">
        <rect x={2} y={2} width={ENVELOPE_W - 4} height={ENVELOPE_H - 4} fill="#1A1012" stroke={GOLD} strokeWidth={4} />
        <path
          d={`M2 2 L${ENVELOPE_W / 2} ${FLAP_Y} L${ENVELOPE_W - 2} 2`}
          stroke={GOLD}
          strokeWidth={4}
          strokeLinejoin="round"
          fill="none"
        />
        <circle cx={ENVELOPE_W / 2} cy={FLAP_Y} r={SEAL / 2} fill={GOLD} />
        <g transform={`translate(${ENVELOPE_W / 2 - SEAL_MARK_W / 2} ${FLAP_Y - SEAL_MARK_H / 2}) scale(${SEAL_MARK_W / 24})`}>
          <path d={V_MARK_PATH} stroke={BG} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>
      </svg>
    </div>
  );
}

export function ShareCard({ lineOne, lineTwo, meta }: { lineOne: string; lineTwo: string; meta: string }) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        width: 1200,
        height: 630,
        backgroundColor: BG,
        backgroundImage:
          "radial-gradient(circle at 72% 45%, rgba(242,177,61,0.16) 0%, rgba(242,177,61,0) 55%), radial-gradient(circle at 15% 90%, rgba(74,20,32,0.5) 0%, rgba(74,20,32,0) 45%)",
      }}
    >
      <div style={{ position: "absolute", left: 64, top: 56, display: "flex", alignItems: "center" }}>
        <VMarkSvg width={18} color={GOLD} />
        <div style={{ marginLeft: 12, fontFamily: "Fraunces", fontWeight: 700, fontSize: 30, color: PAPER }}>Moi</div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 64,
          top: 0,
          width: 640,
          height: 630,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: "JetBrains Mono",
            fontWeight: 500,
            fontSize: 18,
            letterSpacing: 3.24,
            color: MUTED,
            textTransform: "uppercase",
            marginBottom: 28,
          }}
        >
          {meta}
        </div>
        <div style={{ display: "flex", fontFamily: "Fraunces", fontWeight: 700, fontSize: 70, lineHeight: 1, color: PAPER }}>
          {lineOne}
        </div>
        <div
          style={{
            display: "flex",
            fontFamily: "Fraunces",
            fontStyle: "italic",
            fontWeight: 700,
            fontSize: 70,
            lineHeight: 1.05,
            color: GOLD,
          }}
        >
          {lineTwo}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 930 - 150,
          top: 470 - 15,
          width: 300,
          height: 30,
          borderRadius: 150,
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
      />
      <Envelope />

      <div
        style={{
          position: "absolute",
          left: 64,
          bottom: 48,
          display: "flex",
          fontFamily: "JetBrains Mono",
          fontWeight: 500,
          fontSize: 14,
          letterSpacing: 2.52,
          color: MUTED,
        }}
      >
        REAL SHARES ON BNB CHAIN
      </div>
    </div>
  );
}
