const NOISE_TILE = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>" +
    "<filter id='n' x='0' y='0' width='100%' height='100%'>" +
    "<feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/>" +
    "<feColorMatrix type='saturate' values='0'/>" +
    "</filter>" +
    "<rect width='100%' height='100%' filter='url(#n)'/></svg>",
);

/**
 * Film grain over a whole hero section. The parent section must be position: relative. The layer
 * is larger than the section by a few pixels so the jitter never shows an edge; the section clips it.
 * Opacity, blend mode and the jitter live in lab.css under .hero-grain.
 */
export function Grain() {
  return <div className="hero-grain" aria-hidden="true" style={{ backgroundImage: `url("data:image/svg+xml,${NOISE_TILE}")` }} />;
}
