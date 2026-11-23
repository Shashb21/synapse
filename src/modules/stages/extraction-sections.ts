/** Source windows shared by the production gap and tactic extractors. */
import type { RunHandle } from "../kernel/contracts";
import type { ParsedDocumentRecord } from "./s1-parse/module";

// Preserve the previous per-call source budget. Overlap carries sentences across hard cuts.
export const EXTRACTION_SOURCE_LIMIT = 40_000;
const OVERLAP = 1_000;

export type ExtractionSection = {
  document: ParsedDocumentRecord;
  number: number;
  total: number;
  body: string;
  blocks: { id: string; text: string }[];
};

/** Keep blocks intact when possible and carry context across both block and hard text cuts. */
export function extractionSections(document: ParsedDocumentRecord): ExtractionSection[] {
  const parts: string[] = [];
  const blocks: { id: string; textStart: number; start: number; end: number }[] = [];
  let offset = 0;
  for (const block of document.blocks) {
    const header = `## ${block.heading} [block_id=${block.id}]\n`;
    const body = header + block.text;
    blocks.push({ id: block.id, start: offset, textStart: offset + header.length, end: offset + body.length });
    parts.push(body);
    offset += body.length + 2;
  }
  const source = parts.join("\n\n");
  if (!blocks.length) throw new Error(`Incomplete extraction: document ${document.id} has no parsed blocks.`);
  const sections: ExtractionSection[] = [];
  let first = 0;
  let start = 0;
  while (start < source.length) {
    const limit = Math.min(source.length, start + EXTRACTION_SOURCE_LIMIT);
    while (first < blocks.length && blocks[first].end <= start) first++;
    let end = limit;
    // Prefer a complete block. A boundary within the carried overlap cannot advance coverage.
    if (limit < source.length) {
      for (let i = first; i < blocks.length && blocks[i].end <= limit; i++) {
        if (blocks[i].end > start + OVERLAP) end = blocks[i].end;
      }
    }
    const fragments: ExtractionSection["blocks"] = [];
    for (let i = first; i < blocks.length && blocks[i].start < end; i++) {
      const block = blocks[i];
      fragments.push({ id: block.id, text: source.slice(Math.max(start, block.textStart), Math.min(end, block.end)) });
    }
    sections.push({ document, number: sections.length + 1, body: source.slice(start, end), blocks: fragments, total: 0 });
    if (end === source.length) break;
    start = end - OVERLAP;
  }
  for (const section of sections) section.total = sections.length;
  return sections;
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/** Resolve the full quotation against the blocks actually shown for this candidate. */
export function quotedBlock(section: ExtractionSection, quote: string, reportedId?: unknown): string | null {
  const needle = normalize(quote);
  if (!needle) return null;
  const matches = section.blocks.filter(block => normalize(block.text).includes(needle));
  if (matches.length === 1) return matches[0].id;
  return matches.find(block => block.id === reportedId)?.id ?? null;
}

type Proposal = { document_id: string; source_section?: number; block_id?: string | null; source_quote: string };

/** Remove the same sourced proposal repeated across windows, preserving distinct findings and sources. */
export function reconcileSections<T extends Proposal>(rows: T[], fields: (row: T) => string[]): T[] {
  const firstSection = new Map<string, number>();
  return rows.filter(row => {
    if (!row.source_section || !row.block_id) return true;
    const key = JSON.stringify([row.document_id, row.block_id, ...[row.source_quote, ...fields(row)].map(normalize)]);
    const previous = firstSection.get(key);
    if (previous !== undefined) return previous === row.source_section;
    firstSection.set(key, row.source_section);
    return true;
  });
}

/** Complete each source window before returning any proposals. Preserve provider and replay errors. */
export async function proposeSections<T>(
  run: RunHandle, sections: ExtractionSection[], propose: (section: ExtractionSection) => Promise<T[]>,
): Promise<T[]> {
  const proposals: T[] = [];
  for (const [index, section] of sections.entries()) {
    const label = `${section.document.id} section ${section.number}/${section.total}`;
    try {
      const rows = await run.step(`extract:${label}`, () => propose(section));
      proposals.push(...rows);
    } catch (error) {
      run.note("extraction:incomplete", {
        document_id: section.document.id, section: section.number, document_sections: section.total,
        completed_sections: index, total_sections: sections.length,
      });
      throw error;
    }
  }
  return proposals;
}
