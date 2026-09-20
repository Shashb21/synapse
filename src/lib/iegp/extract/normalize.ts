import { blocksFromLlamaResult, type LlamaParseResult } from "@/lib/ingest/llama-blocks";
import { splitSourceIntoBlocks } from "@/lib/iegp/engine";
import type { NormalizedBlock, NormalizedSource } from "./contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blockFromUnknown(row: unknown, index: number, sourceTitle: string): NormalizedBlock | null {
  const rec = asRecord(row);
  if (!rec) return null;
  const locationObj = asRecord(rec.location);
  const location =
    typeof rec.location === "string"
      ? rec.location
      : [locationObj?.kind, locationObj?.ref].filter(Boolean).join(" ") ||
        (typeof rec.heading === "string" ? rec.heading : sourceTitle);
  const text = String(rec.text ?? rec.md ?? rec.value ?? "").trim();
  if (!text) return null;
  return {
    id: String(rec.id ?? `B${String(index + 1).padStart(2, "0")}`),
    heading: String(rec.heading ?? rec.name ?? "Note"),
    text,
    location: location || "block",
    kind: String(rec.kind ?? rec.type ?? "paragraph"),
  };
}

function fromMarkdown(markdown: string, title: string): NormalizedBlock[] {
  return splitSourceIntoBlocks(markdown, title).map((section, i) => ({
    id: `B${String(i + 1).padStart(2, "0")}`,
    heading: section.heading,
    text: section.text,
    location: section.heading === "Note" ? "Uploaded note" : section.heading,
    kind: "paragraph",
  }));
}

function fromLlamaParse(json: LlamaParseResult, title: string): NormalizedBlock[] {
  const raw = blocksFromLlamaResult(json);
  if (raw.length === 0) return [];
  return raw.map((block, i) => ({
    id: `B${String(i + 1).padStart(2, "0")}`,
    heading: block.heading || title,
    text: block.text,
    location: `${block.location.kind} ${block.location.ref}`,
    kind: block.kind,
  }));
}

function looksLikeLlamaParse(json: Record<string, unknown>): boolean {
  return (
    typeof json.markdown_full === "string" ||
    typeof json.markdown === "string" ||
    Boolean(json.items) ||
    (typeof json.markdown === "object" && json.markdown !== null)
  );
}

/**
 * Canonical extractor input is structured JSON blocks (LlamaParse items / ParsedDocument).
 * Markdown is the fallback when only markdown_full exists.
 */
export function normalizeExtractInput(args: {
  format?: "markdown" | "json";
  markdown?: string;
  json?: unknown;
  title?: string;
  filename?: string;
}): NormalizedSource {
  const title = args.title?.trim() || args.filename?.replace(/\.[^.]+$/, "") || "Untitled source";
  const filename = args.filename?.trim() || `${title.replaceAll(/\s+/g, "_")}.md`;
  const json = args.json;
  const markdown = args.markdown?.trim() ?? "";
  const preferJson = args.format === "json" || (args.format !== "markdown" && json != null);

  if (preferJson && json != null) {
    const rec = asRecord(json);
    const blocksField = rec?.blocks;
    if (Array.isArray(blocksField) && blocksField.length > 0) {
      const blocks = blocksField
        .map((row, i) => blockFromUnknown(row, i, title))
        .filter((b): b is NormalizedBlock => Boolean(b));
      if (blocks.length === 0) {
        throw new Error("JSON document contained no extractable blocks.");
      }
      return {
        title: String(rec?.title ?? title),
        filename: String(rec?.filename ?? filename),
        format: "json",
        full_text: String(rec?.fullText ?? rec?.full_text ?? blocks.map((b) => b.text).join("\n\n")),
        blocks,
      };
    }
    if (rec && looksLikeLlamaParse(rec)) {
      const blocks = fromLlamaParse(rec as LlamaParseResult, title);
      if (blocks.length === 0) {
        const md =
          (typeof rec.markdown_full === "string" && rec.markdown_full) ||
          (typeof rec.markdown === "string" && rec.markdown) ||
          "";
        if (md.trim()) {
          const mdBlocks = fromMarkdown(md, title);
          return {
            title,
            filename,
            format: "markdown",
            full_text: md,
            blocks: mdBlocks,
          };
        }
        throw new Error("LlamaParse JSON contained no extractable text or chart data.");
      }
      return {
        title,
        filename,
        format: "json",
        full_text: blocks.map((b) => `[${b.location}] ${b.text}`).join("\n"),
        blocks,
      };
    }
    if (typeof json === "string" && json.trim()) {
      const mdBlocks = fromMarkdown(json, title);
      return { title, filename, format: "markdown", full_text: json, blocks: mdBlocks };
    }
    throw new Error("JSON input must be a ParsedDocument, LlamaParse result, or { blocks: [...] }.");
  }

  if (!markdown) {
    throw new Error("Provide markdown or JSON parsed output.");
  }
  const blocks = fromMarkdown(markdown, title);
  if (blocks.length === 0) {
    throw new Error("Markdown contained no extractable text.");
  }
  return { title, filename, format: "markdown", full_text: markdown, blocks };
}

export function packNormalizedSource(source: NormalizedSource): string {
  const blocks = source.blocks
    .map(
      (b) =>
        `[${b.id} | ${b.location} | ${b.kind}${b.heading ? ` | ${b.heading}` : ""}]\n${b.text}`,
    )
    .join("\n\n");
  return `Title: ${source.title}
Filename: ${source.filename}
Input format: ${source.format} (JSON blocks are preferred when LlamaParse items exist)

Source blocks:
${blocks}`;
}
