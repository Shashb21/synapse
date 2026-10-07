import { z } from "zod";
import { computeCoverageStatus, type StatusAssessment } from "@/lib/iegp/coverage-status";
import { canonicalCoverageOverall } from "@/accuracy/domain/coverage-overall";

export const gapStatusSchema = z.enum(["open", "partial", "addressed"]);

export type GapStatus = z.infer<typeof gapStatusSchema>;

export type CoverageOverall = "full" | "partial" | "limited" | "not_relevant";

export type CoverageJoinLite = {
  gap_id: string;
  tactic_id: string;
  overall: CoverageOverall | string;
  validated: boolean;
  freshness?: StatusAssessment["freshness"];
};

export type TacticLite = {
  id: string;
  status: "completed" | "ongoing" | "planned" | "proposed" | "cancelled" | "unknown";
};

const TACTIC_LIFECYCLES = new Set<TacticLite["status"]>([
  "completed",
  "ongoing",
  "planned",
  "proposed",
  "cancelled",
  "unknown",
]);

export function asTacticLifecycle(value: unknown): TacticLite["status"] | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return TACTIC_LIFECYCLES.has(trimmed as TacticLite["status"])
    ? (trimmed as TacticLite["status"])
    : null;
}

/** Compatibility vocabulary adapter; pending/unknown never become supporting coverage. */
export function normalizeCoverageOverall(value: string | null | undefined): CoverageOverall | null {
  const overall = canonicalCoverageOverall(value);
  return overall === "pending" ? null : overall;
}

export function deriveGapStatus(args: {
  gap_id: string;
  coverages: CoverageJoinLite[];
  tactics: TacticLite[];
}): GapStatus {
  const byId = new Map(args.tactics.map((t) => [t.id, t]));
  return computeCoverageStatus(args.coverages.filter((c) => c.gap_id === args.gap_id).map((c) => ({
    overall: canonicalCoverageOverall(c.overall),
    lifecycle: byId.get(c.tactic_id)?.status,
    validated: c.validated,
    freshness: c.freshness,
  })));
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
