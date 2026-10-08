/** Source-bound draft splitting and shared S8 quadrant priority placement. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { agenticModule } from "../_factory";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { accuracyTransactionActive } from "@/accuracy/store/db";
import { readAccuracySplitInputs, splitProposalSchema, validateAccuracySplitProposal, type SplitProposal } from "@/accuracy/store/partial-split-store";
import { claimMetadata } from "@/accuracy/store/claim-store";
import { readStructuredFields } from "@/accuracy/domain/structured-fields";
import { proposePartialSplit } from "@/modules/stages/s6-partial-split/module";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { isTestStub } from "@/modules/kernel/llm";

/** Only proposes. All persistence is owned by the explicit, human-confirmed store boundary. */
export async function proposeAccuracySplit(args: { workspace_id: string; gap_id: string }, ctx: AccuracyModuleContext): Promise<SplitProposal | null> {
  if (accuracyTransactionActive()) throw new Error("Split providers must run outside Accuracy transactions.");
  if (args.workspace_id !== ctx.workspace_id) throw new Error("Split context belongs to another workspace.");
  const state = await readAccuracySplitInputs(args);
  const countingIds = new Set(state.supporting.map(c => c.tactic_id));
  const revisions = state.revisions;
  const result = await proposePartialSplit({
    gap: { id: state.parent.id, name: String(claimMetadata(state.parent).name ?? state.parent.statement), statement: state.parent.statement },
    evidence_needs: [{ structured: readStructuredFields(state.parent), inherited_context: state.evidence }],
    mapped_tactics: state.effective.map(c => { const t = state.tactics.find(t => t.id === c.tactic_id); return {
      id: c.tactic_id, statement: t?.statement, structured: t ? readStructuredFields(t) : null,
      status: t ? claimMetadata(t).tactic_status : "unknown", counts_toward_addressing: countingIds.has(c.tactic_id),
      coverage: { overall: c.overall, rationale: c.rationale, human_locked: c.validated, freshness: c.freshness, dimensions: c.dimensions },
    }; }),
    coverage_dimensions: COVERAGE_DIMENSIONS,
    require_slice_evidence: true, permitted_evidence: state.evidence, revisions,
  }, countingIds, {
    workspace_id: ctx.workspace_id, actor: ctx.actor, role: ctx.role, ai: true, run: ctx.run,
    route: { ...ctx.route, stage: "S6" },
    complete: async (request) => JSON.parse((await ctx.complete(request)).raw),
  }, (raw) => {
    const row = raw as Record<string, unknown>;
    const parsed = splitProposalSchema.safeParse({ ...row, ...revisions, workspace_id: args.workspace_id, parent_gap_id: args.gap_id,
      confirmed: false, rationale: typeof row?.rationale === "string" ? [row.rationale] : row?.rationale });
    if (!parsed.success) return false;
    try { validateAccuracySplitProposal(parsed.data, state); return true; } catch { return false; }
  });
  const proposal = result.output.proposal;
  // The shared labelled test stub has no direct evidence; it cannot fabricate a confirmable proposal.
  if (!proposal || isTestStub()) return null;
  return splitProposalSchema.parse({ ...proposal, ...revisions, workspace_id: args.workspace_id, confirmed: false });
}
import { completeJson } from "@/accuracy/kernel/routing";
import { listDownstreamClaims, updateClaimMetadata } from "@/accuracy/store/claim-store";
import { assemblyExecutionScope } from "@/accuracy/kernel/assembly-context";
import { listCoverageJoins } from "@/accuracy/store/coverage-store";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { provenanceSpanSchema } from "@/accuracy/store/quote-validator";
import { DEFAULT_AXES } from "@/modules/stages/s8-prioritization/axes";
import { suggestPriorities } from "@/modules/stages/s8-prioritization/scoring";
import { partialSplitOutputSchema, priorityPlacementSchema, PRIORITY_SCORING_IDENTITY } from "./schema";
import { PARTIAL_SPLIT_SYSTEM } from "./prompts";
import { effectiveGapStatus, gapStatusSchema } from "@/accuracy/modules/status-derive/engine";

/** Child identities remain stable across retries of the same reserved kernel run. */
export function splitChildIds(run_id: string, parent_gap_id: string) {
  const prefix = createHash("sha256").update(JSON.stringify({ run_id, parent_gap_id })).digest("hex").slice(0, 36);
  return { addressed_gap_id: `gap_split_${prefix}_A`, open_residual_gap_id: `gap_split_${prefix}_R` };
}
export const partialSplitModule = agenticModule({
  id: "partial-split.agent-v1", call_kind: "partial_split", title: "Partial split", summary: "Draft two source-bound children from committed partial coverage.",
  inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string() }), outputSchema: z.union([partialSplitOutputSchema, z.object({ proposal: splitProposalSchema.nullable() })]),
  async run(input, ctx) {
    if (assemblyExecutionScope().kind !== "experiment" && ctx.evaluation_context !== "experiment") return { output: { proposal: await proposeAccuracySplit(input, ctx) }, summary: "Split proposal awaits human confirmation" };
    const inventory = await listDownstreamClaims(input.workspace_id, { limit: null });
    const parent = inventory.find(row => row.id === input.gap_id);
    if (!parent || parent.claim_type !== "gap" || !parent.validated) throw new Error("Partial split requires a validated parent gap.");
    const coverage = (await listCoverageJoins(input.workspace_id)).filter(row => row.gap_id === parent.id && row.validated && ["partial", "limited"].includes(row.overall));
    const tactics = inventory.filter(row => coverage.some(join => join.tactic_id === row.id)).filter(row => row.claim_type === "tactic" && row.validated && ["planned", "ongoing", "completed"].includes(String(claimMetadata(row).status ?? claimMetadata(row).tactic_status)));
    const committed = coverage.filter(row => tactics.some(tactic => tactic.id === row.tactic_id));
    if (!committed.length) throw new Error("Partial split requires validated coverage from a committed tactic.");
    const meta = claimMetadata(parent);
    const spans = z.array(provenanceSpanSchema).parse(meta.provenance ?? meta.source_context);
    const blocks = await readParseBlocksByIds(input.workspace_id, [...new Set(spans.map(span => span.block_id))]);
    if (!blocks.length) throw new Error("Partial split requires copied source context.");
    // Generation has no local fallback: unavailable/malformed completion remains a visible failure.
    const draft = z.object({ addressed: z.object({ statement: z.string().trim().min(1) }).strict(), residual: z.object({ statement: z.string().trim().min(1) }).strict(), tactic_ids: z.array(z.string()).min(1), coverage_ids: z.array(z.string()).min(1), rationale: z.string().trim().min(1), source_context: z.array(provenanceSpanSchema).min(1) }).strict().parse(await completeJson(ctx.complete, {
      system: PARTIAL_SPLIT_SYSTEM, purpose: "partial-split-proposer", user: JSON.stringify({ parent: { id: parent.id, statement: parent.statement, payload: meta }, coverage: committed, tactics: tactics.map(row => ({ id: row.id, payload: claimMetadata(row) })), blocks }),
    }));
    const ids = splitChildIds(ctx.run.id, parent.id);
    const child = (id: string, branch: "addressed" | "open", statement: string) => ({ id, parent_gap_id: parent.id, statement, branch, origin: "partial_split" as const, evidence_role: "source_context" as const, source_context: draft.source_context, split_run_id: ctx.run.id, split_rationale: draft.rationale, support_tactic_ids: draft.tactic_ids, support_coverage_ids: draft.coverage_ids });
    return { output: partialSplitOutputSchema.parse({ ...ids, addressed: child(ids.addressed_gap_id, "addressed", draft.addressed.statement), residual: child(ids.open_residual_gap_id, "open", draft.residual.statement), tactic_ids: draft.tactic_ids, coverage_ids: draft.coverage_ids, rationale: draft.rationale }), summary: "Two draft split children proposed; validation and materialization require a separate gate" };
  },
});
partialSplitModule.manifest.version = "0.2.0";

import { prioritizeModule as livePrioritizeModule, accuracyPrioritizeInputSchema } from "../prioritize/module";
export const benchmarkPrioritizeModule = agenticModule({
  id: "prioritize.agent-v1", call_kind: "prioritize", title: "Prioritize", summary: "Exact S8 priority placements with retained scoring evidence.",
  inputSchema: z.object({ workspace_id: z.string(), gap_ids: z.array(z.string()).refine(ids => new Set(ids).size === ids.length, "Duplicate gap IDs") }),
  outputSchema: z.object({ mode: z.enum(["llm", "deterministic"]), scoring_identity: z.string(), placements: z.array(priorityPlacementSchema) }),
  async run(input, ctx) {
    if (assemblyExecutionScope().kind !== "experiment") throw new Error("Retained priority materialization is experiment-only.");
    const gaps = (await listDownstreamClaims(input.workspace_id, { claim_type: "gap", limit: null })).filter(row => input.gap_ids.includes(row.id));
    if (gaps.length !== input.gap_ids.length || gaps.some(row => {
      const meta = claimMetadata(row);
      const computed = gapStatusSchema.safeParse(meta.computed_status);
      const override = gapStatusSchema.safeParse(meta.status_override?.status);
      const effective = effectiveGapStatus({ computed: computed.success ? computed.data : "open", override: override.success ? override.data : null });
      return row.claim_type !== "gap" || !row.validated || effective.status === "addressed";
    })) throw new Error("Priority requires exact validated eligible gaps.");
    const outcome = await suggestPriorities({
      gaps: gaps.map(row => ({ id: row.id, name: row.statement, statement: row.statement, domain: String(claimMetadata(row).domain ?? ""), evidence: claimMetadata(row) })),
      axes: DEFAULT_AXES.axes, xAxis: DEFAULT_AXES.axes.find(axis => axis.id === DEFAULT_AXES.x_axis)!,
      yAxis: DEFAULT_AXES.axes.find(axis => axis.id === DEFAULT_AXES.y_axis)!, context: {}, reviewerHints: "",
    }, { workspace_id: ctx.workspace_id, actor: ctx.actor, role: ctx.role, ai: true, run: ctx.run,
      route: { ...ctx.route, stage: "S8" }, complete: async request => JSON.parse((await ctx.complete(request)).raw) });
    const mode = outcome.mode;
    const placements = outcome.accepted.map(row => ({ gap_id: row.gap_id, band: row.suggested_band,
      axis_scores: row.axis_scores, score: row.score, rationale: row.rationale, mode, scoring_identity: PRIORITY_SCORING_IDENTITY }));
    for (const placement of placements) {
      const current = gaps.find(row => row.id === placement.gap_id)!;
      await updateClaimMetadata({ workspace_id: input.workspace_id, claim_id: current.id, metadata: {
        ...claimMetadata(current), priority_band: placement.band, priority_rationale: placement.rationale, priority_origin: mode, priority: placement.band,
        priority_scoring: { ...placement, axes: DEFAULT_AXES, validated: false },
      } });
    }
    return { output: { mode, scoring_identity: PRIORITY_SCORING_IDENTITY, placements }, summary: `${placements.length} exact eligible priority placements (${mode})` };
  },
});

// Version the changed native behavior independently of stable registry IDs.
partialSplitModule.manifest.version = "0.2.0";
benchmarkPrioritizeModule.manifest.version = "0.2.0";

/** Retained benchmark output is isolated; both paths call the shared S8 scorer. */
export const prioritizeModule = agenticModule({
  id: "prioritize.agent-v1", call_kind: "prioritize", title: "Prioritize", summary: "Shared S8 scoring with scoped persistence.",
  inputSchema: accuracyPrioritizeInputSchema,
  outputSchema: z.union([livePrioritizeModule.outputSchema, benchmarkPrioritizeModule.outputSchema]),
  run: async (input, ctx) => assemblyExecutionScope().kind === "experiment"
    ? benchmarkPrioritizeModule.run({ workspace_id: input.workspace_id, gap_ids: input.gap_ids ?? [] }, ctx)
    : livePrioritizeModule.run(input, ctx),
});
