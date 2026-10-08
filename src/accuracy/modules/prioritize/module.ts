import { z } from "zod";
import { agenticModule } from "../_factory";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { accuracyTransactionActive, withAccuracyWorkspaceMutation } from "@/accuracy/store/db";
import { readStructuredFields } from "@/accuracy/domain/structured-fields";
import { listDownstreamClaims, claimMetadata, updateClaimMetadata } from "@/accuracy/store/claim-store";
import { loadAccuracyPriorityConfig, priorityInputs, priorityContextSchema, accuracyPlacementSchema, readStoredAccuracyPlacements, writeAccuracyPlacement,
  readEffectiveAccuracyPlacement, PriorityError, type AccuracyPlacement, type PrioritySelection } from "@/accuracy/store/priority-store";
import { suggestPriorities, mergePrioritySuggestion, placementFromScores } from "@/modules/stages/s8-prioritization/scoring";
import { isTestStub } from "@/modules/kernel/llm";
import { nowIso } from "@/modules/kernel/ids";
import { aiSwitch, AiDisabledError } from "@/modules/kernel/ai-switch";

export const accuracyPrioritizeInputSchema = z.object({
  workspace_id: z.string().min(1), gap_ids: z.array(z.string().min(1)).optional(),
  x_axis: z.string().optional(), y_axis: z.string().optional(), setting: z.string().optional(),
  context: priorityContextSchema.optional(), only_missing: z.boolean().optional(), dry_run: z.boolean().optional(),
});
const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]), axes: z.array(z.object({ id: z.string(), label: z.string(), weight: z.number(), higher_is_priority: z.boolean().optional() })),
  placements: z.array(accuracyPlacementSchema), suggestions: z.array(z.object({ gap_id: z.string(), gap_name: z.string(), axis_scores: z.record(z.string(), z.number().min(0).max(100)),
    score: z.number().min(0).max(100), suggested_band: z.enum(["high", "medium", "low", "defer"]), rationale: z.string() })), skipped: z.array(z.object({ gap_id: z.string(), reason: z.string() })),
});
export type AccuracyPriorityOutput = z.infer<typeof outputSchema>;
export async function prioritizeAccuracy(input: z.infer<typeof accuracyPrioritizeInputSchema>, ctx: AccuracyModuleContext) {
  if (accuracyTransactionActive()) throw new Error("Priority providers must run outside Accuracy transactions.");
  if (ctx.workspace_id !== input.workspace_id) throw new PriorityError("unknown_workspace", "Priority context belongs to another workspace.");
  if (!(await aiSwitch()).enabled) throw new AiDisabledError("Prioritization");
  await loadAccuracyPriorityConfig(input.workspace_id, input.setting);
  const selection: PrioritySelection = { setting: input.setting, x_axis: input.x_axis, y_axis: input.y_axis, context: input.context };
  const skipped: { gap_id: string; reason: string }[] = [];
  const states = await withAccuracyWorkspaceMutation(input.workspace_id, async () => {
    const claims = await listDownstreamClaims(input.workspace_id, { limit: null });
    const ids = input.gap_ids?.length ? [...new Set(input.gap_ids)] : claims.filter(c => c.claim_type === "gap").map(c => c.id);
    const stored = await readStoredAccuracyPlacements(input.workspace_id);
    const eligible: Awaited<ReturnType<typeof priorityInputs>>[] = [];
    for (const id of ids) {
      try {
        const state = await priorityInputs(input.workspace_id, id, selection);
        const placed = stored.find(p => p.gap_id === id);
        const already = placed && [state.xAxis, state.yAxis].every(a => typeof placed.axis_scores[a.id] === "number");
        const reason = state.reason ?? (input.only_missing && already ? "already_placed" : null);
        if (reason) skipped.push({ gap_id: id, reason }); else eligible.push(state);
      } catch (error) {
        if (!(error instanceof PriorityError) || !["unknown_gap", "ineligible_gap"].includes(error.code)) throw error;
        skipped.push({ gap_id: id, reason: error.code === "ineligible_gap" ? error.message : "unknown_gap" });
      }
    }
    return eligible;
  });
  const first = states[0];
  if (!first) return { output: { mode: isTestStub() ? "deterministic" as const : "llm" as const, axes: [], placements: [], suggestions: [], skipped }, summary: "No eligible Open gaps to prioritize" };
  // Adapt just the external completion/run boundary. Accuracy keeps its own provider cost accounting.
  const outcome = await suggestPriorities({
    gaps: states.map(s => ({ id: s.gap.id, name: String(claimMetadata(s.gap).name ?? s.gap.statement), statement: s.gap.statement, domain: String(claimMetadata(s.gap).evidence_domain ?? "unknown"), evidence: { structured: readStructuredFields(s.gap), references: s.references } })),
    axes: first.axes, xAxis: first.xAxis, yAxis: first.yAxis, setting: input.setting, context: first.context, asset: first.asset,
    considerations: first.considerations, reviewerHints: "",
  }, { workspace_id: ctx.workspace_id, actor: ctx.actor, role: ctx.role, ai: true, run: ctx.run, route: { ...ctx.route, stage: "S8" },
    complete: async request => JSON.parse((await ctx.complete(request)).raw) });
  const placements = await withAccuracyWorkspaceMutation(input.workspace_id, async () => {
    const rows = await readStoredAccuracyPlacements(input.workspace_id), results: AccuracyPlacement[] = [];
    for (const suggestion of outcome.accepted) {
      const snapshot = states.find(s => s.gap.id === suggestion.gap_id)!;
      const state = await priorityInputs(input.workspace_id, suggestion.gap_id, selection);
      if (state.reason || state.input_revision !== snapshot.input_revision || state.config_revision !== snapshot.config_revision) {
        skipped.push({ gap_id: suggestion.gap_id, reason: state.reason ?? "stale_revision" }); continue;
      }
      const stored = rows.find(p => p.gap_id === suggestion.gap_id);
      if (input.only_missing && stored && [state.xAxis, state.yAxis].every(a => typeof stored.axis_scores[a.id] === "number")) {
        skipped.push({ gap_id: suggestion.gap_id, reason: "already_placed" }); continue;
      }
      // Evaluate the human decision in its own saved selection before merging into this run's matrix.
      const effective = stored ? await readEffectiveAccuracyPlacement(stored) : null;
      const workingState = stored?.human_band || stored?.validated ? effective?.inputs : state;
      const current = effective?.placement ?? null;
      const working = mergePrioritySuggestion(current, suggestion, state.pairChosen, nowIso());
      const row: AccuracyPlacement = { workspace_id: input.workspace_id, gap_id: suggestion.gap_id, ...working,
        selection: current?.human_band || current?.validated ? current.selection : selection,
        input_revision: workingState?.input_revision ?? snapshot.input_revision, config_revision: workingState?.config_revision ?? snapshot.config_revision, score: workingState && [workingState.xAxis, workingState.yAxis].every(a => typeof working.axis_scores[a.id] === "number") ? placementFromScores(workingState.xAxis, workingState.yAxis, working.axis_scores).score : null,
        validation: current?.validation ?? null, references: state.references, limitations: [...state.limitations, ...(effective && !effective.inputs ? ["Working placement inputs are unavailable; select current axes and review."] : [])],
        history: stored?.history ?? [], human_revision: stored?.human_revision ?? null };
      if (!input.dry_run) {
        await writeAccuracyPlacement(row);
        await updateClaimMetadata({ workspace_id: input.workspace_id, claim_id: row.gap_id, merge: true,
          metadata: { priority_scoring: { gap_id: row.gap_id, axis_scores: suggestion.axis_scores, score: suggestion.score,
            band: suggestion.suggested_band, rationale: suggestion.rationale, mode: outcome.mode, validated: false,
            input_revision: state.input_revision, config_revision: state.config_revision } } });
      }
      results.push(row);
    }
    return results;
  });
  return { output: { mode: outcome.mode, axes: first.axes, placements, suggestions: outcome.accepted, skipped }, summary: `${placements.length} Open gaps scored${input.dry_run ? " (dry run)" : ""}`, evals: outcome.metrics };
}
export const prioritizeModule = agenticModule({
  id: "prioritize.agent-v1", call_kind: "prioritize", title: "Prioritize", summary: "Authoritative S8 suggestions on workspace-owned Accuracy decisions.",
  inputSchema: accuracyPrioritizeInputSchema, outputSchema, run: prioritizeAccuracy,
});
prioritizeModule.manifest.version = "0.2.0";
