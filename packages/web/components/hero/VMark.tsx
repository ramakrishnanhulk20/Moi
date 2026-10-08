/** The chevron of an envelope flap seen from the front. Same path as public/v-mark.svg. */
export const V_MARK_PATH = "M1 1 L12 12 L23 1";

export function VMark({ width = 12 }: { width?: number }) {
  return (
    <svg viewBox="0 0 24 14" width={width} height={(width * 14) / 24} fill="none" aria-hidden="true" focusable="false" style={{ color: "var(--gold)", flex: "none" }}>
      <path d={V_MARK_PATH} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
