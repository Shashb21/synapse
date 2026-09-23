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
    (g) => g.status === "open" && g.priority_band === "high",
  );
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
