/**
 * BeOne / IEGP domain rules aligned with reference deck behavior and accuracy-first architecture.
 *
 * Final saved IEGP truth:
 * - All material gaps appear in the ledger (from sources).
 * - Tactics from reference materials = inventory (extract), not ideation.
 * - Only HIGH-priority (validated) open gaps receive newly CREATED tactics (ideation).
 * - Medium/low gaps may stay open without ideated tactics in the published plan.
 */

export type PriorityBand = "high" | "medium" | "low";

export type TacticOrigin = "inventory" | "ideated";

export type GapRecord = {
  id: string;
  priority_band?: PriorityBand | null;
  status: "open" | "partial" | "addressed";
  /** When false, skip ideation. Undefined is treated as eligible (unit tests / pre-ledger). */
  validated?: boolean;
};

export type TacticRecord = {
  id: string;
  origin: TacticOrigin;
  status: "proposed" | "planned" | "ongoing" | "completed" | "cancelled";
};

export type GapTacticAssignment = {
  gap_id: string;
  tactic_id: string;
};

/** Ideation runs only for validated high-priority open gaps. */
export function gapsEligibleForIdeation(gaps: GapRecord[]): GapRecord[] {
  return gaps.filter(
    (g) =>
      g.status === "open" &&
      g.priority_band === "high" &&
      g.validated !== false,
  );
}

/** Product lock: treat "critical" as the high band. */
export function resolvePriorityBand(raw: unknown): PriorityBand | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "high" || value === "critical") return "high";
  if (value === "medium") return "medium";
  if (value === "low") return "low";
  return null;
}

/** Ledger statuses other than partial/addressed count as open for ideation eligibility. */
export function resolveGapStatus(status: string): GapRecord["status"] {
  if (status === "partial" || status === "addressed") return status;
  return "open";
}

/**
 * Final Gantt / export surface: show tactic assignments for high-priority gaps;
 * inventory tactics may address any gap via coverage joins; ideated tactics only attach to high-priority gaps they were created for.
 */
export function tacticAllowedOnGapInFinalPlan(args: {
  gap: GapRecord;
  tactic: TacticRecord;
  assignment?: GapTacticAssignment;
}): boolean {
  if (args.tactic.origin === "inventory") {
    return Boolean(args.assignment && args.assignment.gap_id === args.gap.id);
  }
  if (args.tactic.origin === "ideated") {
    return (
      args.gap.priority_band === "high" &&
      args.gap.status === "open" &&
      args.tactic.status !== "cancelled" &&
      Boolean(args.assignment && args.assignment.gap_id === args.gap.id)
    );
  }
  return false;
}

/** Eval: ideated tactics must not claim verbatim quotes from reference parse blocks unless user marked hybrid. */
export function ideatedTacticExpectsNoSourceQuote(origin: TacticOrigin): boolean {
  return origin === "ideated";
}

/** Source-recall evals score inventory extract only — never ideated tactics. */
export function includeTacticInSourceRecall(origin: TacticOrigin): boolean {
  return origin === "inventory";
}

export function filterInventoryForSourceRecall<T extends { origin: TacticOrigin }>(
  tactics: T[],
): T[] {
  return tactics.filter((tactic) => includeTacticInSourceRecall(tactic.origin));
}

/** Deck inventory IDs (Tisle `G:n`, BGB `NSCLC_*_*`) must stay on extract, not ideation. */
export function looksLikeInventoryIdentifier(value: string): boolean {
  const v = value.trim();
  return /^(G:\d+|NSCLC_[A-Z]{2}_\d{2})$/i.test(v);
}
