"use client";

import { Badge } from "@/components/ui/badge";

export type ParseBlockPreviewModel = {
  id: string;
  index: number;
  kind: string;
  heading: string | null;
  text: string;
  parser: string;
};

/**
 * Side panel / expandable list of verbatim parse blocks for Sources quote audit.
 * Matches accuracy chrome: border panels, compact type, details disclosure.
 */
export function ParseBlockPreviewPanel({
  filename,
  blocks,
  emptyHint = "Select a source with parse blocks to preview verbatim text for quote audit.",
}: {
  filename?: string | null;
  blocks: ParseBlockPreviewModel[];
  emptyHint?: string;
}) {
  if (blocks.length === 0) {
    return (
      <aside
        className="border border-border bg-card/40 p-3"
        data-testid="parse-block-preview"
        aria-label="Parse block preview"
      >
        <h2 className="text-[13px] font-medium text-foreground">Parse blocks</h2>
        <p className="mt-2 text-[12px] text-muted-foreground">{emptyHint}</p>
      </aside>
    );
  }

  const parser = blocks[0]?.parser ?? "unknown";

  return (
    <aside
      className="border border-border bg-card/40 p-3"
      data-testid="parse-block-preview"
      aria-label="Parse block preview"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-foreground">Parse blocks</h2>
        <Badge variant="outline" className="text-[10px]">
          {parser}
        </Badge>
      </div>
      {filename ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{filename}</p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {blocks.length} block(s) · expand for verbatim text
      </p>
      <ul className="mt-3 grid max-h-[min(70vh,36rem)] gap-1 overflow-y-auto" role="list">
        {blocks.map((block) => (
          <li key={block.id}>
            <details className="group border border-border/80 bg-background/40 open:bg-background/60">
              <summary className="cursor-pointer list-none px-2 py-1.5 text-[11px] text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">#{block.index}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {block.kind}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate">
                    {block.heading?.trim() || block.text.replace(/\s+/g, " ").trim().slice(0, 72)}
                    {!block.heading && block.text.length > 72 ? "…" : ""}
                  </span>
                </span>
              </summary>
              <div className="border-t border-border/60 px-2 py-2">
                <p className="font-mono text-[10px] text-muted-foreground">{block.id}</p>
                {block.heading ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">{block.heading}</p>
                ) : null}
                <pre
                  className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground"
                  data-testid="parse-block-verbatim"
                >
                  {block.text}
                </pre>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </aside>
  );
}
