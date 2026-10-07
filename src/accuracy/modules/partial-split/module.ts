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

export const partialSplitModule = agenticModule({
  id: "partial-split.agent-v1", call_kind: "partial_split", title: "Partial split", summary: "Propose an evidence-supported residual for human confirmation.",
  inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string() }),
  outputSchema: z.object({ proposal: splitProposalSchema.nullable() }),
  run: async (input, ctx) => ({ output: { proposal: await proposeAccuracySplit(input, ctx) }, summary: "Split proposal awaits human confirmation" }),
});
partialSplitModule.manifest.version = "0.2.0";

export { prioritizeModule } from "../prioritize/module";
