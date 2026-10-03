import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson } from "@/accuracy/kernel/routing";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import type { ParseBlock } from "@/accuracy/store/quote-validator";
import { buildStateFromBlocks } from "./build-state-from-blocks";
import { COVERAGE_DECIDE_SYSTEM } from "./prompts";
import { coverageRouteAllowsLlm } from "./overall-map";
import { coverageDecisionSchema, type CoverageDecision } from "./schema";

export type CoverageDecideInput = {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  block_bundle_ids: string[];
  selected_versions?: {
    gap_version_id: string;
    tactic_version_id: string;
    gap_payload: Record<string, unknown>;
    tactic_payload: Record<string, unknown>;
  };
};

export function deterministicCoverageDecision(input: CoverageDecideInput): CoverageDecision {
  return {
    gap_id: input.gap_id,
    tactic_id: input.tactic_id,
    overall: "not_relevant",
    quote_block_ids: [],
    confidence: 0,
    rationale: "No LLM route; deterministic not_relevant stub",
  };
}

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
  if (process.env.SYNAPSE_TEST_STUB_LLM === "1" || !coverageRouteAllowsLlm(ctx.route)) {
    return {
      output: deterministicCoverageDecision(input),
      summary: "Coverage decision stub (no LLM)",
      mode: "stub",
    };
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
    labels: {
      gap: {
        statement: typeof input.selected_versions?.gap_payload.statement === "string"
          ? input.selected_versions.gap_payload.statement
          : undefined,
        name: typeof input.selected_versions?.gap_payload.name === "string"
          ? input.selected_versions.gap_payload.name
          : undefined,
      },
      tactic: {
        name: typeof input.selected_versions?.tactic_payload.name === "string"
          ? input.selected_versions.tactic_payload.name
          : undefined,
        evidence_question: typeof input.selected_versions?.tactic_payload.evidence_question === "string"
          ? input.selected_versions.tactic_payload.evidence_question
          : undefined,
        type: typeof input.selected_versions?.tactic_payload.type === "string"
          ? input.selected_versions.tactic_payload.type
          : undefined,
      },
    },
  });
  ctx.run.note("coverage:state", state);

  const raw = await completeJson(ctx.complete, {
    system: COVERAGE_DECIDE_SYSTEM,
    user: JSON.stringify(state),
    purpose: `coverage-decide:${input.gap_id}:${input.tactic_id}`,
  });
  const output = lockDecision({ input, raw });
  return {
    output,
    summary: `Coverage decision ${output.overall} (${output.confidence.toFixed(2)})`,
    mode: "llm",
  };
}
