import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson } from "@/accuracy/kernel/routing";
import {
  coverageCriticOutputSchema,
  coverageDecisionSchema,
  type CoverageCriticOutput,
  type CoverageDecision,
} from "./schema";
import { coverageRouteAllowsLlm } from "./overall-map";
import { COVERAGE_CRITIC_SYSTEM } from "./prompts";

export function deterministicCriticAccept(): CoverageCriticOutput {
  return { accept: true, issues: [] };
}

export async function runCoverageCritic(
  decision: CoverageDecision,
  ctx: AccuracyModuleContext,
): Promise<{ output: CoverageCriticOutput; summary: string; mode: "llm" | "stub" }> {
  const parsedDecision = coverageDecisionSchema.parse(decision);

  if (process.env.SYNAPSE_TEST_STUB_LLM === "1" || !coverageRouteAllowsLlm(ctx.route)) {
    return {
      output: deterministicCriticAccept(),
      summary: "Coverage critic skipped (no LLM)",
      mode: "stub",
    };
  }

  const raw = await completeJson(ctx.complete, {
    system: COVERAGE_CRITIC_SYSTEM,
    user: JSON.stringify({ decision: parsedDecision }),
    purpose: `coverage-critic:${parsedDecision.gap_id}:${parsedDecision.tactic_id}`,
  });
  const output = coverageCriticOutputSchema.parse(raw);
  return {
    output,
    summary: output.accept ? "Coverage critic accepted" : `Coverage critic flagged ${output.issues.length} issue(s)`,
    mode: "llm",
  };
}
