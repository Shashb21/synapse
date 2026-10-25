/** Shared, backwards-compatible S9 recommendation metadata and unresolved outcomes. */
import { z } from "zod";

const reason = z.string().trim().min(3);
/** Current generation requires meaningful reasoning; historical saved records may omit it. */
export const ideationRecommendationSchema = z.object({
  remaining_need: reason,
  incremental_contribution: reason,
  alternatives_rationale: reason,
  feasibility: z.object({
    status: z.enum(["credible", "conditional", "infeasible", "unknown"]),
    required_checks: z.array(reason),
  }),
  coverage_discrepancy: reason.nullable(),
  deadline: z.object({status: z.enum(["timely", "conditional", "late", "unknown"]), explanation: reason}),
}).superRefine((value, ctx) => {
  if (value.coverage_discrepancy !== null && value.feasibility.status === "credible") {
    ctx.addIssue({code: "custom", path: ["feasibility", "status"], message: "Resolve the recorded-coverage discrepancy before claiming credible feasibility."});
  }
  if ((["conditional", "unknown"].includes(value.feasibility.status) || value.coverage_discrepancy !== null || value.deadline.status === "conditional") && value.feasibility.required_checks.length === 0) {
    ctx.addIssue({code: "custom", path: ["feasibility", "required_checks"], message: "Conditional feasibility, timing or coverage discrepancies require visible checks."});
  }
});

export type IdeationRecommendation = z.infer<typeof ideationRecommendationSchema>;

/** A gap can remain unresolved even when later useful activity is proposed. */
export const ideationGapOutcomeSchema = z.object({
  gap_id: z.string().min(1),
  status: z.enum(["options", "no_credible_option", "no_timely_option"]),
  explanation: reason,
});
export type IdeationGapOutcome = z.infer<typeof ideationGapOutcomeSchema>;
