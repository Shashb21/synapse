import { z } from "zod";
import { agenticModule } from "../_factory";
import { runCoverageDecide } from "./decide";
import { runCoverageCritic } from "./critic";
import { coverageDecisionSchema, coverageCriticOutputSchema } from "./schema";

export { coverageDecisionSchema, coverageCriticOutputSchema } from "./schema";
export { buildStateFromBlocks } from "./build-state-from-blocks";
export { testStubCoverageDecision, runCoverageDecide } from "./decide";
export { testStubCriticAccept, runCoverageCritic } from "./critic";
export {
  coverageRouteAllowsLlm,
  mapCoverageOverallToUi,
  type CoverageUiOverall,
} from "./overall-map";

const coverageDecideInputSchema = z.object({
  workspace_id: z.string(),
  gap_id: z.string(),
  tactic_id: z.string(),
  block_bundle_ids: z.array(z.string()),
});

export const coverageDecideModule = agenticModule({
  id: "coverage-decide.schema-v1",
  call_kind: "coverage_decide",
  title: "Coverage decide",
  summary: "Schema-locked pairwise coverage (no Jev).",
  inputSchema: coverageDecideInputSchema,
  outputSchema: coverageDecisionSchema,
  run: async (input, ctx) => {
    const result = await runCoverageDecide(input, ctx);
    ctx.run.note("coverage:mode", result.mode);
    return { output: result.output, summary: result.summary };
  },
});

export const coverageCriticModule = agenticModule({
  id: "coverage-critic.agent-v1",
  call_kind: "coverage_critic",
  title: "Coverage critic",
  summary: "Second pass on low-confidence pairs.",
  inputSchema: coverageDecisionSchema,
  outputSchema: coverageCriticOutputSchema,
  run: async (decision, ctx) => {
    const result = await runCoverageCritic(decision, ctx);
    ctx.run.note("coverage-critic:mode", result.mode);
    return { output: result.output, summary: result.summary };
  },
});
