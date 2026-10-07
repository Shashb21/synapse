import { z } from "zod";
import { agenticModule } from "../_factory";
import { runCoverageDecide } from "./decide";
import { runCoverageCritic } from "./critic";
import { coverageDecisionSchema, coverageCriticOutputSchema } from "./schema";
import { assemblyExecutionScope } from "@/accuracy/kernel/assembly-context";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import { approvedLiveInventory } from "@/accuracy/store/assembly-review-store";

export { coverageDecisionSchema, coverageCriticOutputSchema } from "./schema";
export { buildStateFromBlocks } from "./build-state-from-blocks";
export { deterministicCoverageDecision, runCoverageDecide } from "./decide";
export { deterministicCriticAccept, runCoverageCritic } from "./critic";
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
  selected_versions: z.object({
    gap_version_id: z.string(),
    tactic_version_id: z.string(),
    gap_payload: z.record(z.string(), z.unknown()),
    tactic_payload: z.record(z.string(), z.unknown()),
  }).optional(),
});

type CoverageDecideInput = z.infer<typeof coverageDecideInputSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

async function approvedCoverageInput(input: CoverageDecideInput): Promise<CoverageDecideInput> {
  if (assemblyExecutionScope().kind !== "production") return input;
  const live = await approvedLiveInventory(input.workspace_id);
  if (!live) return input;
  const gap = live.selected_items.find((item) => item.claim_id === input.gap_id && item.claim_type === "gap");
  const tactic = live.selected_items.find((item) => item.claim_id === input.tactic_id && item.claim_type === "tactic");
  if (!gap || !tactic) {
    throw new AssemblyReviewError("approval_required", "Coverage decision requires claims from the current approved assembly.");
  }
  const selected_versions = {
    gap_version_id: gap.item_version_id,
    tactic_version_id: tactic.item_version_id,
    gap_payload: gap.payload,
    tactic_payload: tactic.payload,
  };
  if (input.selected_versions && !sameJson(input.selected_versions, selected_versions)) {
    throw new AssemblyReviewError("conflict", "Supplied selected versions differ from the current approved assembly.");
  }
  return { ...input, selected_versions };
}

export const coverageDecideModule = agenticModule({
  id: "coverage-decide.schema-v1",
  call_kind: "coverage_decide",
  title: "Coverage decide",
  summary: "Schema-locked pairwise coverage (no Jev).",
  inputSchema: coverageDecideInputSchema,
  outputSchema: coverageDecisionSchema,
  run: async (input, ctx) => {
    const result = await runCoverageDecide(await approvedCoverageInput(input), ctx);
    ctx.run.note("coverage:mode", result.mode);
    return { output: result.output, summary: result.summary };
  },
});

export const coverageCriticModule = agenticModule({
  id: "coverage-critic.agent-v1",
  call_kind: "coverage_critic",
  title: "Coverage critic",
  summary: "Second pass on low-confidence pairs.",
  // Kernel ownership checks require the trusted workspace for retained critic calls.
  inputSchema: coverageDecisionSchema.extend({ workspace_id: z.string().optional() }),
  outputSchema: coverageCriticOutputSchema,
  run: async (decision, ctx) => {
    const result = await runCoverageCritic(decision, ctx);
    ctx.run.note("coverage-critic:mode", result.mode);
    return { output: result.output, summary: result.summary };
  },
});
