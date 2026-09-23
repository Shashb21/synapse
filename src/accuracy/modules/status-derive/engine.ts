import { z } from "zod";

export const gapStatusSchema = z.enum(["open", "partial", "addressed"]);

export type GapStatus = z.infer<typeof gapStatusSchema>;

export type CoverageJoinLite = {
  gap_id: string;
  tactic_id: string;
  overall: "full" | "partial" | "limited" | "not_relevant";
  validated: boolean;
};

export type TacticLite = {
  id: string;
  status: "completed" | "ongoing" | "planned" | "proposed" | "cancelled";
};

/** Deterministic Open / Partial / Addressed from validated joins (accuracy-first status engine). */
export function deriveGapStatus(args: {
  gap_id: string;
  coverages: CoverageJoinLite[];
  tactics: TacticLite[];
}): GapStatus {
  const rows = args.coverages.filter((c) => c.gap_id === args.gap_id && c.validated);
  if (rows.length === 0) return "open";
  const qualifying = rows.filter((c) => c.overall !== "not_relevant");
  if (qualifying.length === 0) return "open";
  const hasFull = qualifying.some((c) => c.overall === "full");
  const hasPartial = qualifying.some((c) => c.overall === "partial" || c.overall === "limited");
  const tacticById = new Map(args.tactics.map((t) => [t.id, t]));
  const committed = qualifying.some((c) => {
    const t = tacticById.get(c.tactic_id);
    return t && t.status !== "proposed" && t.status !== "cancelled";
  });
  if (hasFull && committed && !hasPartial) return "addressed";
  if (hasPartial || (hasFull && !committed)) return "partial";
  if (hasFull) return "addressed";
  return "partial";
}
