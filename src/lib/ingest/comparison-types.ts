/** Durable document comparison outcomes and progress, separate from parser records. */
export type ComparisonOutcome = {
  block_id: string; passage: string; match: "same" | "overlaps" | "new";
  judgment: "support" | "conflict" | "unknown";
  gap_id: string | null; tactic_id: string | null; coverage_id: string | null; rationale: string;
};
export type SourceComparison = {
  source_id: string; version: string; status: "pending" | "completed" | "failed" | "ai_disabled";
  /** Hash of all source text and plan records the model examined. */
  basis_version: string; updated_at: string; error: string | null;
  /** Saved before the first canonical source-review write; null means no model reply yet. */
  outcomes: ComparisonOutcome[] | null; review_ids: string[];
};
export type SourceComparisonView = SourceComparison & { basis_current: boolean };
