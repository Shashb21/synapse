"use client";

import { useEffect, useId, useRef } from "react";
import mermaid from "mermaid";

type Part = { kind: "prose" | "mermaid"; text: string };

export function splitSpec(markdown: string): Part[] {
  const parts: Part[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown))) {
    if (match.index > last) {
      parts.push({ kind: "prose", text: markdown.slice(last, match.index) });
    }
    parts.push({ kind: "mermaid", text: match[1]!.trim() });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) {
    parts.push({ kind: "prose", text: markdown.slice(last) });
  }
  return parts.filter((part) => part.text.trim().length > 0);
}

function MermaidBlock({ chart, index }: { chart: string; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");

  useEffect(() => {
    let cancelled = false;
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    const id = `mmd-${reactId}-${index}`;
    void mermaid
      .render(id, chart)
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch((error: unknown) => {
        if (ref.current) {
          ref.current.textContent =
            error instanceof Error ? error.message : "Diagram failed to render.";
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, index, reactId]);

  return (
    <div
      ref={ref}
      className="overflow-x-auto border border-border bg-card p-4 text-[12px] text-foreground"
    />
  );
}

export function SpecBody({ markdown }: { markdown: string }) {
  const parts = splitSpec(markdown);
  return (
    <div className="space-y-4">
      {parts.map((part, index) =>
        part.kind === "mermaid" ? (
          <MermaidBlock key={index} chart={part.text} index={index} />
        ) : (
          <pre
            key={index}
            className="overflow-auto border border-border bg-card p-4 font-mono text-[12px] leading-5 whitespace-pre-wrap text-foreground/90"
          >
            {part.text.trim()}
          </pre>
        ),
      )}
    </div>
  );
}
