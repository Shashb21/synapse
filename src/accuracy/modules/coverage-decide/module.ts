import { z } from "zod";
import { agenticModule } from "../_factory";

export const coverageDecisionSchema = z.object({
  gap_id: z.string(),
  tactic_id: z.string(),
  overall: z.enum(["full", "partial", "limited", "not_relevant"]),
  quote_block_ids: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export const coverageDecideModule = agenticModule({
  id: "coverage-decide.schema-v1",
  call_kind: "coverage_decide",
  title: "Coverage decide",
  summary: "Schema-locked pairwise coverage (no Jev).",
  inputSchema: z.object({
    workspace_id: z.string(),
    gap_id: z.string(),
    tactic_id: z.string(),
    block_bundle_ids: z.array(z.string()),
  }),
  outputSchema: coverageDecisionSchema,
  run: async (input) => ({
    output: {
      gap_id: input.gap_id,
      tactic_id: input.tactic_id,
      overall: "not_relevant" as const,
      quote_block_ids: [],
      confidence: 0,
      rationale: "Stub — await LLM decision path",
    },
    summary: "Coverage decision stub",
  }),
});

export const coverageCriticModule = agenticModule({
  id: "coverage-critic.agent-v1",
  call_kind: "coverage_critic",
  title: "Coverage critic",
  summary: "Low-confidence pair review.",
  inputSchema: coverageDecisionSchema,
  outputSchema: z.object({ accept: z.boolean(), issues: z.array(z.string()) }),
  run: async () => ({ output: { accept: true, issues: [] }, summary: "Coverage critic stub" }),
});
