/** Source-bound draft splitting and shared weighted priority placement. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { agenticModule } from "../_factory";
import { completeJson } from "@/accuracy/kernel/routing";
import { listDownstreamClaims, claimMetadata, updateClaimMetadata } from "@/accuracy/store/claim-store";
import { assemblyExecutionScope } from "@/accuracy/kernel/assembly-context";
import { listCoverageJoins } from "@/accuracy/store/coverage-store";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { provenanceSpanSchema } from "@/accuracy/store/quote-validator";
import { DEFAULT_AXES, bandFor, weightedScore } from "@/modules/stages/s8-prioritization/axes";
import { heuristicScores } from "@/modules/stages/s8-prioritization/scoring";
import { partialSplitOutputSchema, priorityPlacementSchema, PRIORITY_SCORING_IDENTITY } from "./schema";
import { PARTIAL_SPLIT_SYSTEM, PRIORITY_SYSTEM } from "./prompts";

/** Child identities remain stable across retries of the same reserved kernel run. */
export function splitChildIds(run_id: string, parent_gap_id: string) {
  const prefix = createHash("sha256").update(JSON.stringify({ run_id, parent_gap_id })).digest("hex").slice(0, 36);
  return { addressed_gap_id: `gap_split_${prefix}_A`, open_residual_gap_id: `gap_split_${prefix}_R` };
}
export const partialSplitModule = agenticModule({
  id: "partial-split.agent-v1", call_kind: "partial_split", title: "Partial split", summary: "Draft two source-bound children from committed partial coverage.",
  inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string() }), outputSchema: partialSplitOutputSchema,
  async run(input, ctx) {
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

export const prioritizeModule = agenticModule({
  id: "prioritize.agent-v1", call_kind: "prioritize", title: "Prioritize", summary: "Exact weighted priority placements with retained scoring evidence.",
  inputSchema: z.object({ workspace_id: z.string(), gap_ids: z.array(z.string()).refine(ids => new Set(ids).size === ids.length, "Duplicate gap IDs") }),
  outputSchema: z.object({ mode: z.enum(["llm", "deterministic"]), scoring_identity: z.string(), placements: z.array(priorityPlacementSchema) }),
  async run(input, ctx) {
    const gaps = (await listDownstreamClaims(input.workspace_id, { claim_type: "gap", limit: null })).filter(row => input.gap_ids.includes(row.id));
    if (gaps.length !== input.gap_ids.length || gaps.some(row => row.claim_type !== "gap" || !row.validated || claimMetadata(row).computed_status === "addressed")) throw new Error("Priority requires exact validated eligible gaps.");
    const mode = process.env.SYNAPSE_TEST_STUB_LLM !== "1" && ctx.route.connected && ["api_key", "oauth"].includes(ctx.route.auth) ? "llm" as const : "deterministic" as const;
    const draft = mode === "llm" ? z.object({ gaps: z.array(z.object({ gap_id: z.string(), scores: z.record(z.string(), z.number().finite().min(0).max(100)), rationale: z.string().trim().min(1) }).strict()) }).strict().parse(await completeJson(ctx.complete, { system: PRIORITY_SYSTEM, purpose: "priority-suggester", user: JSON.stringify({ axes: DEFAULT_AXES, gaps: gaps.map(row => ({ id: row.id, statement: row.statement, payload: claimMetadata(row) })) }) })).gaps : gaps.map(row => {
      const meta = claimMetadata(row);
      return { gap_id: row.id, ...heuristicScores({ gap: { name: String(meta.name ?? ""), statement: row.statement, domain: String(meta.domain ?? "") }, axes: DEFAULT_AXES.axes, importance: 3 }) };
    });
    const axisIds = DEFAULT_AXES.axes.map(axis => axis.id).sort();
    if (draft.length !== gaps.length || new Set(draft.map(row => row.gap_id)).size !== gaps.length || draft.some(row => !input.gap_ids.includes(row.gap_id) || JSON.stringify(Object.keys(row.scores).sort()) !== JSON.stringify(axisIds))) throw new Error("Priority output must contain every exact gap and configured axis once.");
    const placements = draft.map(row => {
      const score = weightedScore(row.scores, DEFAULT_AXES.axes);
      return { gap_id: row.gap_id, band: bandFor(score, DEFAULT_AXES.bands), axis_scores: row.scores, score, rationale: row.rationale, mode, scoring_identity: PRIORITY_SCORING_IDENTITY };
    });
    for (const placement of placements) {
      const current = gaps.find(row => row.id === placement.gap_id)!;
      await updateClaimMetadata({ workspace_id: input.workspace_id, claim_id: current.id, metadata: {
        ...claimMetadata(current),
        // Production retains a suggestion until the existing human workflow accepts a band.
        ...(assemblyExecutionScope().kind === "experiment" ? { priority_band: placement.band, priority_rationale: placement.rationale, priority_origin: mode, priority: placement.band } : {}),
        priority_scoring: { ...placement, axes: DEFAULT_AXES, validated: false },
      } });
    }
    return { output: { mode, scoring_identity: PRIORITY_SCORING_IDENTITY, placements }, summary: `${placements.length} exact eligible priority placements (${mode})` };
  },
});

// Version the changed native behavior independently of stable registry IDs.
partialSplitModule.manifest.version = "0.2.0";
prioritizeModule.manifest.version = "0.2.0";
