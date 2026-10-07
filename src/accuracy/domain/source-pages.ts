/** Lossless source slices. IDs always refer to the original persisted parse block. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ParseBlock, ProvenanceSpan } from "../store/quote-validator";

export const SOURCE_INSTRUCTION_RESERVE = 8000;
export function sourcePromptBudget(): number {
  const value = Number(process.env.SYNAPSE_EXTRACT_PROMPT_CHARS ?? 40000);
  if (!Number.isSafeInteger(value) || value < 10000 || value > 200000) {
    throw new Error("SYNAPSE_EXTRACT_PROMPT_CHARS must be an integer from 10000 to 200000.");
  }
  return value - SOURCE_INSTRUCTION_RESERVE;
}
/** Refuse an oversized request explicitly; source text is never silently truncated. */
export function sourcePromptUser(system: string, user: string): string {
  if (system.length + user.length > sourcePromptBudget() + SOURCE_INSTRUCTION_RESERVE) {
    throw new Error("Extraction instructions and source page exceed SYNAPSE_EXTRACT_PROMPT_CHARS.");
  }
  return user;
}
export const sourceUnitSchema = z.object({ block_id: z.string().min(1), char_start: z.number().int().nonnegative(), char_end: z.number().int().nonnegative() });
export const sourcePageInputSchema = z.object({ id: z.string().min(1), units: z.array(sourceUnitSchema).min(1) });
export type SourceUnit = z.infer<typeof sourceUnitSchema> & { text: string; heading: string | null };
export type SourcePage = { id: string; index: number; units: SourceUnit[]; prompt_chars: number };
export type SourcePageInput = z.infer<typeof sourcePageInputSchema>;
export const sourceHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? "null").digest("hex");
export function sourceUnitHeader(unit: Pick<SourceUnit, "block_id" | "char_start" | "char_end" | "heading">): string {
  return `### block_id=${unit.block_id} char_start=${unit.char_start} char_end=${unit.char_end}${unit.heading ? ` · ${unit.heading}` : ""}\n`;
}
export function buildSourcePages(blocks: ParseBlock[], budget: number): SourcePage[] {
  if (!Number.isSafeInteger(budget) || budget < 256 || budget > 200000) throw new Error("Source page budget must be an integer from 256 to 200000.");
  const sorted = [...blocks].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  if (new Set(sorted.map(b => b.id)).size !== sorted.length || sorted.some(b => b.workspace_id !== sorted[0].workspace_id || b.source_file_id !== sorted[0].source_file_id)) {
    throw new Error("Source pages require unique blocks from one workspace and source.");
  }
  const pages: SourcePage[] = [];
  let units: SourceUnit[] = [], prompt_chars = 0;
  const flush = () => {
    if (units.length) pages.push({ id: sourceHash(units), index: pages.length, units, prompt_chars });
    units = []; prompt_chars = 0;
  };
  for (const block of sorted) {
    let offset = 0;
    do {
      // Reserve the longest offset rendering, so every rendered page fits exactly.
      const base = { block_id: block.id, heading: block.heading, char_start: offset, char_end: block.text.length };
      const overhead = sourceUnitHeader(base).length + 2;
      if (overhead >= budget) throw new Error(`Block ${block.id} header exceeds source page budget.`);
      if (budget - prompt_chars <= overhead) flush();
      let end = Math.min(block.text.length, offset + budget - prompt_chars - overhead);
      // Do not bisect a UTF-16 surrogate pair at a page boundary.
      if (end < block.text.length && end > offset && /[\uD800-\uDBFF]/.test(block.text[end - 1])) end--;
      if (end === offset && block.text.length > offset) {
        if (!units.length) throw new Error(`Block ${block.id} cannot fit its next character in the source page budget.`);
        flush(); continue;
      }
      const unit = { ...base, char_end: end, text: block.text.slice(offset, end) };
      units.push(unit); prompt_chars += sourceUnitHeader(unit).length + unit.text.length + 2;
      offset = end;
      if (offset < block.text.length) flush();
    } while (offset < block.text.length);
  }
  flush();
  return pages;
}

/** Resolve trusted slices against current original blocks; never accept client text. */
export function resolveSourcePage<T extends Pick<ParseBlock, "id" | "text" | "source_file_id">>(blocks: T[], page: SourcePageInput): (T & { char_start: number; char_end: number })[] {
  const seen = new Set<string>();
  return page.units.map(unit => {
    const block = blocks.find(b => b.id === unit.block_id);
    if (!block || seen.has(unit.block_id) || (unit.char_end <= unit.char_start && !(block.text.length === 0 && unit.char_start === 0 && unit.char_end === 0)) || unit.char_end > block.text.length) throw new Error("Invalid source page unit.");
    seen.add(unit.block_id);
    return { ...block, text: block.text.slice(unit.char_start, unit.char_end), char_start: unit.char_start, char_end: unit.char_end };
  });
}

/** Map all record/structured quote spans to original offsets, rejecting ambiguous evidence. */
export function locatePageEvidence<T>(value: T, blocks: (Pick<ParseBlock, "id" | "text" | "source_file_id"> & { char_start: number; char_end: number })[]): T {
  if (Array.isArray(value)) return value.map(v => locatePageEvidence(v, blocks)) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.block_id === "string" && typeof record.source_file_id === "string" && typeof record.quote === "string") {
    const span = record as ProvenanceSpan;
    const block = blocks.find(b => b.id === span.block_id && b.source_file_id === span.source_file_id);
    if (!block || !span.quote.trim()) throw new Error("quote_outside_page");
    const local = block.text.indexOf(span.quote);
    if (local < 0) throw new Error("quote_outside_page");
    const start = span.char_start ?? block.char_start + local;
    const end = span.char_end ?? start + span.quote.length;
    if ((span.char_start === undefined && block.text.indexOf(span.quote, local + 1) !== -1)
      || start < block.char_start || end > block.char_end || end !== start + span.quote.length
      || block.text.slice(start - block.char_start, end - block.char_start) !== span.quote) throw new Error("ambiguous_or_invalid_quote_offsets");
    return { ...record, char_start: start, char_end: end } as T;
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, locatePageEvidence(v, blocks)])) as T;
}

export type SourcePageAttempt = { state: "pending" | "running" | "successful" | "failed" | "incomplete"; run_id?: string; error?: string; token?: string; started_at?: string; claim_ids?: string[]; rejected_candidates?: { index: number; field: string; reason: string }[] };
export type SourceProgress = {
  version: 1; source_revision: string; selection_scope: "all" | "selected"; block_ids: string[];
  expected_blocks: number; expected_units: number; processed_units: number; failed_units: number;
  budget: number; complete: boolean; full_source_complete: boolean; next_cursor: string | null;
  upstream_dropped_units: { id: string; location: string; reason: string; text: string }[];
  pages: { id: string; index: number; units: z.infer<typeof sourceUnitSchema>[]; attempts: Record<string, SourcePageAttempt> }[];
};


export type SourceEntityIdentity = { source_revision: string; identity: string };
/** Accepted identities survive absorption by the existing merge owner. */
export function sourceEntityIdentities(metadata: Record<string, unknown>): SourceEntityIdentity[] {
  const values = [...(Array.isArray(metadata.extraction_aliases) ? metadata.extraction_aliases : []),
    { source_revision: metadata.extraction_source_revision, identity: metadata.extraction_identity }];
  const aliases = new Map<string, SourceEntityIdentity>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.source_revision === "string" && typeof candidate.identity === "string") {
      const alias = { source_revision: candidate.source_revision, identity: candidate.identity };
      aliases.set(sourceHash(alias), alias);
    }
  }
  return [...aliases.values()];
}
