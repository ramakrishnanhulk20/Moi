"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";

type Drawn = { svg: string; minWidth: number } | "failed" | null;

// The fence is drawn in the browser only, because mermaid needs a real page to measure its text.
// A diagram that cannot be drawn falls back to its source and says nothing in the console.
export function Mermaid({ chart }: { chart: string }) {
  const id = `moi-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn>(null);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        // next/font names its families with a hash, so the plain word "Manrope" would match nothing.
        const bodyFont = getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          logLevel: 5,
          suppressErrorRendering: true,
          themeVariables: {
            background: "#0E0809",
            primaryColor: "#1A1012",
            primaryTextColor: "#F6EFE6",
            primaryBorderColor: "#F2B13D",
            lineColor: "#B9AEA4",
            secondaryColor: "#4A1420",
            tertiaryColor: "#1A1012",
            edgeLabelBackground: "#1A1012",
            fontFamily: bodyFont || "Manrope, sans-serif",
          },
        });
        const { svg } = await mermaid.render(id, chart);
        const width = Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) /.exec(svg)?.[1] ?? 0);
        // On a narrow screen the drawing may shrink to 1 / 1.6 of its own width and no further, so its text stays readable.
        if (current) setDrawn({ svg, minWidth: Math.round(width / 1.6) });
      } catch {
        // A failed render can leave a stray element on the page behind.
        document.getElementById(`d${id}`)?.remove();
        if (current) setDrawn("failed");
      }
    })();
    return () => {
      current = false;
    };
  }, [chart, id]);

  if (drawn === "failed") {
    return (
      <pre className="docs-mermaid-source" tabIndex={0}>
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <figure className="docs-mermaid" aria-label="Diagram">
      {drawn === null ? (
        <div className="docs-mermaid-wait" aria-hidden="true" />
      ) : (
        <div
          className="docs-mermaid-inner"
          style={{ "--mermaid-min": `${drawn.minWidth}px` } as CSSProperties}
          dangerouslySetInnerHTML={{ __html: drawn.svg }}
        />
      )}
    </figure>
  );
}
