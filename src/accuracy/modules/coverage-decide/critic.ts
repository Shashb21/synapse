import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson } from "@/accuracy/kernel/routing";
import { completeAll, isTestStub } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import {
  coverageCriticOutputSchema,
  coverageDecisionSchema,
  type CoverageCriticOutput,
  type CoverageDecision,
} from "./schema";
import { coverageRouteAllowsLlm } from "./overall-map";
import { COVERAGE_CRITIC_SYSTEM } from "./prompts";

/**
 * Test stub only (SYNAPSE_TEST_STUB_LLM): the critic is skipped and says so.
 * Production never auto-accepts a decision.
 */
export function testStubCriticAccept(): CoverageCriticOutput {
  return { accept: true, issues: ["test_stub:not_reviewed_by_model"] };
}

export async function runCoverageCritic(
  decision: CoverageDecision,
  ctx: AccuracyModuleContext,
): Promise<{ output: CoverageCriticOutput; summary: string; mode: "llm" | "stub" }> {
  const parsedDecision = coverageDecisionSchema.parse(decision);

  if (isTestStub()) {
    return {
      output: testStubCriticAccept(),
      summary: "Coverage critic test stub (SYNAPSE_TEST_STUB_LLM)",
      mode: "stub",
    };
  }
  if (!coverageRouteAllowsLlm(ctx.route)) {
    throw new NoRouteError(
      "The coverage critic needs a connected LLM. Connect Grok or Claude in /control and run it again.",
    );
  }

  const pair = `${parsedDecision.gap_id}:${parsedDecision.tactic_id}`;
  const answers = await completeAll<CoverageCriticOutput>({
    ids: [pair],
    what: "coverage critique",
    describe: () => `gap ${parsedDecision.gap_id} × tactic ${parsedDecision.tactic_id}`,
    remedy: "run the critic again or switch the coverage_critic route in /control.",
    ask: async (_missing, attempt) => {
      const out = new Map<string, CoverageCriticOutput>();
      try {
        const raw = await completeJson(ctx.complete, {
          system: COVERAGE_CRITIC_SYSTEM,
          user: JSON.stringify({ decision: parsedDecision }),
          purpose: `coverage-critic:${parsedDecision.gap_id}:${parsedDecision.tactic_id}${attempt > 1 ? `:retry${attempt}` : ""}`,
        });
        out.set(pair, coverageCriticOutputSchema.parse(raw));
      } catch (error) {
        if (error instanceof NoRouteError) throw error;
        ctx.run.note("coverage-critic:invalid-answer", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return out;
    },
  });
  const output = answers.get(pair)!;
  return {
    output,
    summary: output.accept ? "Coverage critic accepted" : `Coverage critic flagged ${output.issues.length} issue(s)`,
    mode: "llm",
  };
}
