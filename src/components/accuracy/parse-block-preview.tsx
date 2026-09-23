import type { ParseBlockPreview as ParseBlockPreviewModel } from "@/accuracy/store/parse-preview";

/**
 * Sources parse-block preview. Renders stored `text` verbatim (whitespace preserved)
 * so copied quotes remain substring-validatable against `accuracy_parse_blocks`.
 */
export function ParseBlockPreview({
  blocks,
}: {
  blocks: ParseBlockPreviewModel[];
}) {
  if (blocks.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground" data-testid="parse-block-preview-empty">
        No parse blocks to preview.
      </p>
    );
  }

  return (
    <details className="mt-2 border border-border/70 bg-background/40 p-2" data-testid="parse-block-preview">
      <summary className="cursor-pointer text-[12px] text-foreground">
        Preview {blocks.length} parse block{blocks.length === 1 ? "" : "s"} (verbatim)
      </summary>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Quotes must be substrings of this text. One source file per preview — packs stay isolated.
      </p>
      <ol className="mt-2 grid max-h-80 gap-2 overflow-auto">
        {blocks.map((block) => (
          <li
            key={block.id}
            className="border border-border/60 bg-card/30 p-2"
            data-testid="parse-block-item"
            data-block-id={block.id}
            data-source-file-id={block.source_file_id}
          >
            <p className="text-[11px] text-muted-foreground">
              #{block.index} · {block.kind}
              {block.heading ? ` · ${block.heading}` : ""}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">{block.id}</p>
            <pre
              data-testid="parse-block-text"
              className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground"
            >
              {block.text}
            </pre>
          </li>
        ))}
      </ol>
    </details>
  );
}
