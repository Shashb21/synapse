import type { ParsedBlock } from "@/lib/schema";

type LlamaItem = {
  type?: string;
  name?: string;
  value?: string;
  md?: string;
  rows?: unknown;
  heading?: string;
};

type LlamaPage = {
  page?: number;
  markdown?: string;
  items?: LlamaItem[];
};

export type LlamaParseResult = {
  markdown_full?: string;
  markdown?: string | { pages?: LlamaPage[] };
  items?: { pages?: LlamaPage[] } | LlamaPage[];
};

function pageRef(page: number | undefined, fallback: number): string {
  return `Slide ${page ?? fallback}`;
}

function flattenRows(rows: unknown): string {
  if (!Array.isArray(rows)) return "";
  return rows
    .map((row) =>
      Array.isArray(row)
        ? row.map((c) => String(c ?? "").trim()).filter(Boolean).join(" | ")
        : String(row ?? ""),
    )
    .filter(Boolean)
    .join("\n");
}

function pageMarkdown(result: LlamaParseResult): { page: number; md: string }[] {
  if (typeof result.markdown === "string" && result.markdown.trim()) {
    return splitMarkdownPages(result.markdown);
  }
  if (typeof result.markdown_full === "string" && result.markdown_full.trim()) {
    return splitMarkdownPages(result.markdown_full);
  }
  const pages = typeof result.markdown === "object" ? result.markdown?.pages : undefined;
  if (pages?.length) {
    return pages.map((p, i) => ({
      page: p.page ?? i + 1,
      md: p.markdown ?? "",
    }));
  }
  return [];
}

function splitMarkdownPages(md: string): { page: number; md: string }[] {
  const chunks = md
    .split(/\n(?=#{1,3}\s)|(?:^|\n)---+\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length <= 1) {
    return [{ page: 1, md: md.trim() }];
  }
  return chunks.map((chunk, i) => ({ page: i + 1, md: chunk }));
}

function itemPages(result: LlamaParseResult): LlamaPage[] {
  if (Array.isArray(result.items)) return result.items;
  return result.items?.pages ?? [];
}

function kindFor(text: string, itemType?: string): ParsedBlock["kind"] {
  if (itemType && /chart|figure|graph/i.test(itemType)) return "chart";
  if (itemType && /table/i.test(itemType)) return "table_cell";
  if (/^\|.*\|$/m.test(text) || /chart|figure/i.test(text.slice(0, 80))) {
    return "chart";
  }
  const first = text.split("\n")[0] ?? text;
  if (first.length < 80 && text.length < 90) return "title";
  if (text.length > 180) return "paragraph";
  return "bullet";
}

export function blocksFromLlamaResult(result: LlamaParseResult): Omit<ParsedBlock, "id">[] {
  const blocks: Omit<ParsedBlock, "id">[] = [];
  const mdPages = pageMarkdown(result);
  mdPages.forEach((page, idx) => {
    const parts = page.md
      .split(/\n{2,}/)
      .map((p) => p.replace(/^#+\s*/, "").trim())
      .filter(Boolean);
    const heading = parts[0];
    parts.forEach((text, i) => {
      blocks.push({
        location: { kind: "slide", ref: pageRef(page.page, idx + 1) },
        heading: i === 0 ? "Title" : heading,
        text,
        kind: i === 0 ? "title" : kindFor(text),
      });
    });
  });

  itemPages(result).forEach((page, idx) => {
    for (const item of page.items ?? []) {
      const table = flattenRows(item.rows);
      const text = [item.heading, item.name, item.value, item.md, table]
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) continue;
      if (/chart|figure|graph|table/i.test(item.type ?? "") || table) {
        blocks.push({
          location: { kind: "slide", ref: pageRef(page.page, idx + 1) },
          heading: item.heading || item.name || item.type,
          text,
          kind: /chart|figure|graph/i.test(item.type ?? "") ? "chart" : "table_cell",
        });
      }
    }
  });

  return blocks;
}

export const LLAMA_CHART_PROMPT = `This is a biopharma brand readout (PowerPoint, Word, or Excel).
Extract every visible string: titles, bullets, footnotes, speaker notes, table cells, axis titles, legends, callouts, and numbers inside charts or graphics.
Render each chart or graph as a markdown table of categories × series with units. Do not invent values that are not visible on the slide.`;
