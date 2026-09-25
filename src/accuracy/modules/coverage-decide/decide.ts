import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson } from "@/accuracy/kernel/routing";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import type { ParseBlock } from "@/accuracy/store/quote-validator";
import { completeAll, isTestStub } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import { buildStateFromBlocks } from "./build-state-from-blocks";
import { COVERAGE_DECIDE_SYSTEM } from "./prompts";
import { coverageRouteAllowsLlm } from "./overall-map";
import { coverageDecisionSchema, type CoverageDecision } from "./schema";

export type CoverageDecideInput = {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  block_bundle_ids: string[];
};

/**
 * Test stub only (SYNAPSE_TEST_STUB_LLM): fixed, labelled output so tests can run
 * the pipeline without a model. Never a production decision.
 */
export function testStubCoverageDecision(input: CoverageDecideInput): CoverageDecision {
  return {
    gap_id: input.gap_id,
    tactic_id: input.tactic_id,
    overall: "not_relevant",
    quote_block_ids: [],
    confidence: 0,
    rationale: "Test stub (SYNAPSE_TEST_STUB_LLM): no model was asked",
  };
}

/** Schema-validates a model answer and pins it to the pair; throws when invalid. */
function lockDecision(args: {
  input: CoverageDecideInput;
  raw: unknown;
}): CoverageDecision {
  const merged = {
    ...(typeof args.raw === "object" && args.raw !== null ? args.raw : {}),
    gap_id: args.input.gap_id,
    tactic_id: args.input.tactic_id,
  };
  const parsed = coverageDecisionSchema.parse(merged);
  const allowed = new Set(args.input.block_bundle_ids);
  return {
    ...parsed,
    quote_block_ids: parsed.quote_block_ids.filter((id) => allowed.has(id)),
  };
}

export async function runCoverageDecide(
  input: CoverageDecideInput,
  ctx: AccuracyModuleContext,
  blocks?: Pick<ParseBlock, "id" | "heading" | "text">[],
): Promise<{ output: CoverageDecision; summary: string; mode: "llm" | "stub" }> {
  if (isTestStub()) {
    return {
      output: testStubCoverageDecision(input),
      summary: "Coverage decision test stub (SYNAPSE_TEST_STUB_LLM)",
      mode: "stub",
    };
  }
  if (!coverageRouteAllowsLlm(ctx.route)) {
    throw new NoRouteError(
      "Coverage decisions need a connected LLM. Connect Grok or Claude in /admin/control and run it again.",
    );
  }

  const bundleBlocks =
    blocks ??
    (await readParseBlocksByIds(input.workspace_id, input.block_bundle_ids)).map((row) => ({
      id: row.id,
      heading: row.heading,
      text: row.text,
    }));

  const state = buildStateFromBlocks({
    gap_id: input.gap_id,
    tactic_id: input.tactic_id,
    block_bundle_ids: input.block_bundle_ids,
    blocks: bundleBlocks,
  });
  ctx.run.note("coverage:state", state);

  // Re-ask when the answer is off-schema; never substitute a verdict.
  const pair = `${input.gap_id}:${input.tactic_id}`;
  const answers = await completeAll<CoverageDecision>({
    ids: [pair],
    what: "coverage decision",
    describe: () => `gap ${input.gap_id} × tactic ${input.tactic_id}`,
    remedy: "run coverage assist again or switch the coverage_decide route in /admin/control.",
    ask: async (_missing, attempt) => {
      const out = new Map<string, CoverageDecision>();
      try {
        const raw = await completeJson(ctx.complete, {
          system: COVERAGE_DECIDE_SYSTEM,
          user: JSON.stringify(state),
          purpose: `coverage-decide:${input.gap_id}:${input.tactic_id}${attempt > 1 ? `:retry${attempt}` : ""}`,
        });
        out.set(pair, lockDecision({ input, raw }));
      } catch (error) {
        if (error instanceof NoRouteError) throw error;
        ctx.run.note("coverage:invalid-answer", {
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
    summary: `Coverage decision ${output.overall} (${output.confidence.toFixed(2)})`,
    mode: "llm",
  };
}
