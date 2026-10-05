/** Draft split and priority evidence contracts shared with replay terminal validation. */
import { z } from "zod";
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
export const priorityPlacementSchema = z.object({
  gap_id: id, band: z.enum(["high", "medium", "low"]),
  axis_scores: z.record(id, z.number().finite().min(0).max(100)), score: z.number().finite().min(0).max(100),
  rationale: id, mode: z.enum(["llm", "deterministic"]), scoring_identity: id,
}).strict();
export const PRIORITY_SCORING_IDENTITY = "s8-default-weighted-cues-v1";
