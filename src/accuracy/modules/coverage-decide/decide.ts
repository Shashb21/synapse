import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson } from "@/accuracy/kernel/routing";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import type { ParseBlock } from "@/accuracy/store/quote-validator";
import { completeAll, isTestStub } from "@/modules/kernel/llm";
import { NoRouteError, ProviderError } from "@/modules/llm/provider";
import { buildStateFromBlocks } from "./build-state-from-blocks";
import { COVERAGE_DECIDE_SYSTEM } from "./prompts";
import { coverageRouteAllowsLlm } from "./overall-map";
import { coverageDecisionSchema, type CoverageDecision } from "./schema";

export type CoverageDecideInput = {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  block_bundle_ids: string[];
  facts?: { gap: { statement: string; structured: unknown; factual_revision?: string; fields?: Record<string, unknown> }; tactic: { statement: string; structured: unknown; lifecycle: string; factual_revision?: string; fields?: Record<string, unknown> } };
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
  if (parsed.quote_block_ids.some((id) => !allowed.has(id))) throw new Error("Coverage citation is outside the permitted pair evidence.");
  return {
    ...parsed,
    quote_block_ids: [...new Set(parsed.quote_block_ids)],
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
      "Coverage decisions need a live LLM. Set XAI_API_KEY or ANTHROPIC_API_KEY in the server environment and run it again.",
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
    labels: input.facts ? { gap: { statement: input.facts.gap.statement }, tactic: { name: input.facts.tactic.statement } } : undefined,
    facts: input.facts,
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
        // A provider failure (no credit, rejected key) is not an invalid answer: asking again hides it (KAN-68).
        if (error instanceof NoRouteError || error instanceof ProviderError) throw error;
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
