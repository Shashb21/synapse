/**
 * Pure helpers shared by the accuracy parse store and the main-app S1 source
 * blocks for human block edits. Client-safe: no database, no LLM.
 */

export const HUMAN_RATIONALE_MIN = 3;

export function requireEditRationale(rationale: string | null | undefined): string {
  const trimmed = (rationale ?? "").trim();
  if (trimmed.length < HUMAN_RATIONALE_MIN) {
    throw new Error("A short rationale (3+ characters) is required for every block edit.");
  }
  return trimmed;
}

/** Whitespace-collapsed text used for every containment check. */
export function squashText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when `quote` is a (whitespace-insensitive) span of `text`. */
export function containsQuote(text: string, quote: string): boolean {
  const q = squashText(quote);
  if (!q) return true;
  return squashText(text).includes(q);
}

/**
 * Human-confirmed paragraph split for typed/pasted sources: one block per
 * paragraph separated by a blank line. A lone short first line that ends
 * without punctuation is NOT promoted to a heading — the user decides that.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Split `text` at a character offset; both halves must be non-empty. */
export function splitAtOffset(text: string, offset: number): [string, string] {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= text.length) {
    throw new Error(`Split offset must be between 1 and ${Math.max(text.length - 1, 1)}.`);
  }
  const first = text.slice(0, offset).trim();
  const second = text.slice(offset).trim();
  if (!first || !second) throw new Error("Both halves of a split must contain text.");
  return [first, second];
}

/**
 * Resolve where to split: an explicit offset, or the first occurrence of a
 * marker string (the second block starts at the marker).
 */
export function resolveSplitOffset(text: string, args: { offset?: number; at_text?: string }): number {
  if (typeof args.offset === "number") return args.offset;
  const marker = (args.at_text ?? "").trim();
  if (!marker) throw new Error("Give a split offset or the text the second block starts with.");
  const at = text.indexOf(marker);
  if (at <= 0) throw new Error("The second block's opening text was not found after the start of the block.");
  return at;
}

export type QuoteDependent = { id: string; quote: string };

/**
 * Provenance guard. Given the quotes that cite text in the affected blocks,
 * returns the dependents whose quote no longer appears in any of the blocks
 * that will exist after the change. An empty list means the change is safe.
 */
export function orphanedQuotes(dependents: QuoteDependent[], afterTexts: string[]): QuoteDependent[] {
  return dependents.filter((dep) => !afterTexts.some((text) => containsQuote(text, dep.quote)));
}

export function describeOrphans(orphans: QuoteDependent[]): string {
  const list = orphans.map((o) => `${o.id} ("${squashText(o.quote).slice(0, 60)}")`).join(", ");
  return `This change would orphan ${orphans.length} cited quote(s): ${list}. Keep the quoted text in the block, or edit those records first. Nothing was saved.`;
}
