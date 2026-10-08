import { placementFromScores } from "@/modules/stages/s8-prioritization/scoring";
import { DEFAULT_AXES } from "@/modules/stages/s8-prioritization/axes";
/** Draft split and priority evidence contracts shared with replay terminal validation. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { provenanceSpanSchema } from "@/accuracy/store/quote-validator";
const id = z.string().trim().min(1);
export const splitChildSchema = z.object({
  id, parent_gap_id: id, statement: id, origin: z.literal("partial_split"),
  branch: z.enum(["addressed", "open"]), evidence_role: z.literal("source_context"),
  source_context: z.array(provenanceSpanSchema).min(1),
  split_run_id: id, split_rationale: id, support_tactic_ids: z.array(id).min(1), support_coverage_ids: z.array(id).min(1),
}).strict();
export const partialSplitOutputSchema = z.object({
  addressed_gap_id: id, open_residual_gap_id: id, addressed: splitChildSchema,
  residual: splitChildSchema, tactic_ids: z.array(id).min(1), coverage_ids: z.array(id).min(1), rationale: id,
}).strict();
export type PartialSplitOutput = z.infer<typeof partialSplitOutputSchema>;
/** Exact provenance identities created for each generated child's ordered context. */
export function splitContextEvidenceIds(child: z.infer<typeof splitChildSchema>): string[] {
  return child.source_context.map((span, index) => `prov_split_${createHash("sha256").update(JSON.stringify({ id: child.id, index, span })).digest("hex").slice(0, 40)}`);
}
export const priorityPlacementSchema = z.object({
  gap_id: id, band: z.enum(["high", "medium", "low", "defer"]),
  axis_scores: z.record(id, z.number().finite().min(0).max(100)), score: z.number().finite().min(0).max(100),
  rationale: id, mode: z.enum(["llm", "deterministic"]), scoring_identity: id,
}).strict();
export const PRIORITY_SCORING_IDENTITY = "s8-default-quadrants-v2";

/** Benchmark's fixed selection uses the same geometry as customer and live Accuracy. */
export function benchmarkPriorityGeometry(scores: Record<string, number>) {
  return placementFromScores(DEFAULT_AXES.axes.find(axis => axis.id === DEFAULT_AXES.x_axis)!,
    DEFAULT_AXES.axes.find(axis => axis.id === DEFAULT_AXES.y_axis)!, scores);
}
