import { z } from "zod";

export const coverageDecisionSchema = z.object({
  gap_id: z.string(),
  tactic_id: z.string(),
  overall: z.enum(["full", "partial", "limited", "not_relevant"]),
  quote_block_ids: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export type CoverageDecision = z.infer<typeof coverageDecisionSchema>;

export const coverageCriticOutputSchema = z.object({
  accept: z.boolean(),
  issues: z.array(z.string()),
});

export type CoverageCriticOutput = z.infer<typeof coverageCriticOutputSchema>;
