import { V_MARK_PATH } from "./VMark";

// One world unit of the 3D scene is 150 units here, so this drawing lines up with the canvas.
const BODY = { w: 360, h: 225 };
const FLAP_TIP_CLOSED = 142.5;
const FLAP_TIP_OPEN = -134;
const SEAL = { x: 180, y: 120, r: 30 };

/**
 * The envelope drawn as plain SVG, in the lacquer colours. Closed, it stands in until the 3D canvas
 * has drawn its first frame. Open, with the gold lining and no seal, it is the envelope in the
 * reduced-motion composite. The drawing may spill outside its box, which is the body alone, so the
 * open flap can rise above it.
 */
export function EnvelopeFallback({ open }: { open: boolean }) {
  const flapTip = open ? FLAP_TIP_OPEN : FLAP_TIP_CLOSED;
  const flapPoints = `0,0 ${BODY.w},0 ${BODY.w / 2},${flapTip}`;
  return (
    <svg
      className="envelope-fallback"
      viewBox={`0 0 ${BODY.w} ${BODY.h}`}
      role="img"
      aria-label="A black envelope with a gold border, sealed with a gold V"
    >
      <defs>
        <linearGradient id="fallback-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.1" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="fallback-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--gold)" }} />
          <stop offset="0.6" style={{ stopColor: "var(--gold)" }} />
          <stop offset="1" style={{ stopColor: "var(--gold-deep)" }} />
        </linearGradient>
      </defs>

      <rect width={BODY.w} height={BODY.h} fill="#1E0E10" />
      <rect width={BODY.w} height={BODY.h} fill="url(#fallback-sheen)" />
      <rect x={12} y={12} width={BODY.w - 24} height={BODY.h - 24} fill="none" stroke="url(#fallback-gold)" strokeWidth="3" />

      <polygon
        points={flapPoints}
        fill={open ? "var(--gold-deep)" : "#1E0E10"}
        stroke="url(#fallback-gold)"
        strokeWidth="3"
        strokeLinejoin="round"
      />

      {open ? null : (
        <>
          <circle cx={SEAL.x} cy={SEAL.y} r={SEAL.r} fill="url(#fallback-gold)" />
          <circle cx={SEAL.x} cy={SEAL.y} r={SEAL.r - 5} fill="none" stroke="var(--gold-deep)" strokeWidth="1.5" />
          <path
            d={V_MARK_PATH}
            transform={`translate(${SEAL.x - 13} ${SEAL.y - 8}) scale(1.08)`}
            stroke="#1E0E10"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </>
      )}
    </svg>
  );
}
