import { z } from "zod";

export const gapStatusSchema = z.enum(["open", "partial", "addressed"]);

export type GapStatus = z.infer<typeof gapStatusSchema>;

export type CoverageOverall = "full" | "partial" | "limited" | "not_relevant";

export type CoverageJoinLite = {
  gap_id: string;
  tactic_id: string;
  overall: CoverageOverall | string;
  validated: boolean;
};

export type TacticLite = {
  id: string;
  status: "completed" | "ongoing" | "planned" | "proposed" | "cancelled";
};

const TACTIC_LIFECYCLES = new Set<TacticLite["status"]>([
  "completed",
  "ongoing",
  "planned",
  "proposed",
  "cancelled",
]);

export function asTacticLifecycle(value: unknown): TacticLite["status"] | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return TACTIC_LIFECYCLES.has(trimmed as TacticLite["status"])
    ? (trimmed as TacticLite["status"])
    : null;
}

const COMMITTED: ReadonlySet<string> = new Set(["completed", "ongoing", "planned"]);

/** Map stored / UI overall values onto the status-engine enum. */
export function normalizeCoverageOverall(value: string | null | undefined): CoverageOverall | null {
  switch ((value ?? "").trim().toLowerCase()) {
    case "full":
    case "covers":
      return "full";
    case "partial":
      return "partial";
    case "limited":
      return "limited";
    case "not_relevant":
    case "none":
      return "not_relevant";
    default:
      return null;
  }
}

function isCommitted(status: TacticLite["status"] | undefined): boolean {
  return Boolean(status && COMMITTED.has(status));
}

/**
 * Deterministic Open / Partial / Addressed from validated joins + tactic lifecycle.
 *
 * - Open: no qualifying (non-cancelled, relevant) joins
 * - Partial: limited/partial committed coverage, or proposed-only tactics
 * - Addressed: committed full coverage with no residual partial/limited on committed tactics
 */
export function deriveGapStatus(args: {
  gap_id: string;
  coverages: CoverageJoinLite[];
  tactics: TacticLite[];
}): GapStatus {
  const rows = args.coverages.filter((c) => c.gap_id === args.gap_id && c.validated);
  if (rows.length === 0) return "open";

  const tacticById = new Map(args.tactics.map((t) => [t.id, t]));
  const qualifying = rows.filter((c) => {
    const overall = normalizeCoverageOverall(String(c.overall));
    if (!overall || overall === "not_relevant") return false;
    const tactic = tacticById.get(c.tactic_id);
    if (!tactic) return false;
    if (tactic.status === "cancelled") return false;
    return true;
  });
  if (qualifying.length === 0) return "open";

  const committed = qualifying.filter((c) => isCommitted(tacticById.get(c.tactic_id)?.status));
  if (committed.length === 0) {
    const proposedOnly = qualifying.some((c) => tacticById.get(c.tactic_id)?.status === "proposed");
    return proposedOnly ? "partial" : "open";
  }

  const hasFull = committed.some((c) => normalizeCoverageOverall(String(c.overall)) === "full");
  const hasResidual = committed.some((c) => {
    const overall = normalizeCoverageOverall(String(c.overall));
    return overall === "partial" || overall === "limited";
  });
  if (hasFull && !hasResidual) return "addressed";
  return "partial";
}

export type DerivedGapStatusRow = {
  gap_id: string;
  /** Effective status (override wins when present). */
  status: GapStatus;
  computed: GapStatus;
  override: boolean;
};

export function effectiveGapStatus(args: {
  computed: GapStatus;
  override?: GapStatus | null;
}): { status: GapStatus; override: boolean } {
  if (args.override === "open" || args.override === "partial" || args.override === "addressed") {
    return { status: args.override, override: true };
  }
  return { status: args.computed, override: false };
}

export function deriveWorkspaceGapStatuses(args: {
  gap_ids: string[];
  coverages: CoverageJoinLite[];
  tactics: TacticLite[];
  overrides?: Record<string, GapStatus | null | undefined>;
}): DerivedGapStatusRow[] {
  return args.gap_ids.map((gap_id) => {
    const computed = deriveGapStatus({
      gap_id,
      coverages: args.coverages,
      tactics: args.tactics,
    });
    const effective = effectiveGapStatus({
      computed,
      override: args.overrides?.[gap_id],
    });
    return { gap_id, computed, status: effective.status, override: effective.override };
  });
}
