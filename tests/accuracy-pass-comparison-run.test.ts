/** Database-backed independent pass cohorts with local controlled extraction cycles. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { runPassComparison, readPassComparison, PassComparisonValidationError, PassComparisonNotFoundError } from "@/accuracy/experiments/pass-comparison";
import { runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import { activeAccuracyModuleId, activateAccuracyModule, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { agenticModule, mechanicalModule } from "@/accuracy/modules/_factory";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { insertClaim } from "@/accuracy/store/claim-store";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { newId } from "@/modules/kernel/ids";
import * as records from "@/accuracy/experiments/records";

const workspaces: string[] = [];
const originals = new Map<string, string>();
beforeAll(() => registerAccuracyStack());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [call_kind, module_id] of originals) activateAccuracyModule({ call_kind: call_kind as never, module_id, activated_by: "comparison restore" });
  originals.clear();
  for (const workspace of workspaces.splice(0)) await deleteWorkspace(workspace);
});
async function fixture() {
  const org_id = await createOrganization(newId("comparison-org"));
  const workspace_id = await createWorkspace({ org_id, name: "Comparison source", slug: newId("comparison-source") }); workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("checksum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Source evidence." }] });
  await insertClaim({ workspace_id, claim_type: "gap", statement: "Baseline", source_file_id: source.id });
  return { mode: "single_call" as const, source_workspace_id: workspace_id, source_file_ids: [source.id], pack_id: "beone-bgb-58067-prmt5i", condition: { label: "local", nested: { b: 2, a: 1 } }, actor: { name: "test", function: "medical_affairs" as const }, call: { call_kind: "need_extract" as const, input: { workspace_id, source_file_id: source.id, block_ids: [block_id] } } };
}
function controlled(call_kind: "need_extract" | "inventory_extract", fail = false, ignoreControl = false, earlier = false) {
  const original = activeAccuracyModuleId(call_kind); if (original) originals.set(call_kind, original);
  const id = newId("comparison-module");
  const inputSchema = z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()), source_page: z.unknown().optional() });
  const outputSchema: z.ZodType<Record<string, unknown>> = call_kind === "need_extract" ? z.object({ workspace_id: z.string(), source_file_id: z.string(), gaps: z.array(z.unknown()) }) : z.object({ workspace_id: z.string(), source_file_id: z.string(), tactics: z.array(z.unknown()) });
  registerAccuracyModule(agenticModule({ id, call_kind, title: "Controlled comparison", summary: "Local cycle", inputSchema, outputSchema,
    run: async (input, context) => {
      if (ignoreControl) return { output: { workspace_id: input.workspace_id, source_file_id: input.source_file_id, ...(call_kind === "need_extract" ? { gaps: [] } : { tactics: [] }) }, summary: "ignored" };
      const result = await runShallowAgenticCycle({ run: context.run, maxExchanges: 0, proposer: async () => call_kind === "need_extract" ? { gaps: [] } : { tactics: [] },
        onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }),
        critic: async () => { if (fail) throw new Error("controlled critic failure"); return { score: 1, issues: [] }; },
        ...(earlier ? {
          onCompleteness: async () => ({ risk_level: "none_detected" as const, checked_block_ids: input.block_ids,
            unchecked_block_ids: [], suspected_omissions: [], prior_issue_resolutions: [] }),
          select: async () => ({ selected_iteration: 1, reason: "Keep the checked V1 while retaining every produced pass" }),
        } : { judge: async draft => draft }) });
      return { output: { workspace_id: input.workspace_id, source_file_id: input.source_file_id, ...result.final }, summary: "controlled" };
    } }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "comparison test" });
}
function downstream(call_kind: "merge_dedupe" | "status_derive") {
  const original = activeAccuracyModuleId(call_kind); if (original) originals.set(call_kind, original);
  const id = newId("comparison-downstream");
  registerAccuracyModule(mechanicalModule({ id, call_kind, title: "Downstream", summary: "Local downstream", inputSchema: z.object({ workspace_id: z.string() }), outputSchema: z.record(z.string(), z.unknown()),
    run: async input => ({ output: call_kind === "merge_dedupe" ? { workspace_id: input.workspace_id, merged: 0, survivors: 0, contradictions: 0, merges: [], contradiction_rows: [] } : { statuses: [], open: 0, partial: 0, addressed: 0 }, summary: "local" }) }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "comparison test" });
}
describe("isolated pass cohorts", () => {
  it.each(["single_call", "pipeline"] as const)("runs three independent %s attempts with actual exact versions and preserves baseline rows", async mode => {
    const request = await fixture(); controlled("need_extract"); controlled("inventory_extract"); downstream("merge_dedupe"); downstream("status_derive");
    const baseline = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, request.source_workspace_id));
    const result = await runPassComparison({ ...request, mode, ...(mode === "pipeline" ? { call: undefined } : {}) }); workspaces.push(...result.experiments.map(row => row.workspace_id));
    expect(new Set(result.experiments.map(row => row.workspace_id)).size).toBe(3);
    expect(new Set(result.experiments.map(row => row.id)).size).toBe(3);
    const ids = result.experiments.flatMap(row => row.calls.map(call => call.id)); expect(new Set(ids).size).toBe(ids.length);
    const evalIds = result.experiments.flatMap(row => row.evaluations.map(value => value.id)); expect(new Set(evalIds).size).toBe(evalIds.length);
    expect(new Set(result.experiments.flatMap(row => row.calls.map(call => call.call_id))).size).toBe(mode === "pipeline" ? 12 : 3);
    for (const [index, experiment] of result.experiments.entries()) {
      expect(experiment.condition).toMatchObject({ label: "local", critic_revision_passes: index + 1, comparison_id: result.comparison_id, original_request_identity: { mode, source_file_ids: request.source_file_ids } });
      expect(experiment.calls.filter(call => call.call_kind === "need_extract").map(call => call.version_index)).toEqual(Array.from({ length: index + 2 }, (_, i) => i));
      expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, experiment.workspace_id))).toHaveLength(1);
    }
    expect(result.comparison.matched).toBe(true); expect(result.comparison.conditions.map(row => row.eligibility)).toEqual(["eligible", "eligible", "eligible"]);
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, request.source_workspace_id))).toEqual(baseline);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, request.source_workspace_id))).toEqual([]);
    const reread = await readPassComparison({ source_workspace_id: request.source_workspace_id, experiment_ids: result.experiments.map(row => row.id) });
    expect(reread).toEqual(result.comparison);
  });
  it("persists earlier selected judgments independently of forced depth and rereads all raw evidence", async () => {
    const request = await fixture(); controlled("need_extract", false, false, true);
    const result = await runPassComparison(request);
    workspaces.push(...result.experiments.map(row => row.workspace_id));
    expect(result.comparison).toMatchObject({ matched: true, comparison_evaluator_version: "pass-comparison-v2" });
    expect(result.comparison.conditions.map(condition => ({ eligibility: condition.eligibility,
      requested: condition.calls[0].requested_revision_passes, terminal: condition.calls[0].terminal_iteration,
      selected: condition.calls[0].selected_iteration, versions: condition.calls[0].versions.length })))
      .toEqual([1, 2, 3].map(pass => ({ eligibility: "eligible", requested: pass, terminal: pass, selected: 1, versions: pass + 1 })));
    for (const [index, condition] of result.comparison.conditions.entries()) {
      expect(result.experiments[index].calls.map(call => call.version_index)).toEqual(Array.from({ length: index + 2 }, (_, i) => i));
      expect(condition.calls[0].runtime!.events.at(-1)).toMatchObject({ event_type: "judgment", selected_iteration: 1 });
      expect(condition.totals.latency_ms).toBe(condition.calls[0].runtime!.duration_ms);
      expect(condition.totals.token_usage).toEqual(condition.calls[0].runtime!.token_usage);
    }
    const reread = await readPassComparison({ source_workspace_id: request.source_workspace_id,
      experiment_ids: result.experiments.map(row => row.id) });
    expect(reread).toEqual(result.comparison);
  });
  it("repeating a request creates a separate cohort and six isolated attempts", async () => {
    const request = await fixture(); controlled("need_extract");
    const a = await runPassComparison(request); const b = await runPassComparison(request); workspaces.push(...[...a.experiments, ...b.experiments].map(row => row.workspace_id));
    expect(a.comparison_id).not.toBe(b.comparison_id); expect(new Set([...a.experiments, ...b.experiments].map(row => row.id)).size).toBe(6);
    expect(a.experiments[0].condition).toHaveProperty("original_request_fingerprint", (b.experiments[0].condition as Record<string, unknown>).original_request_fingerprint);
    await expect(readPassComparison({ source_workspace_id: request.source_workspace_id, experiment_ids: [a.experiments[0].id, b.experiments[1].id, b.experiments[2].id] })).resolves.toMatchObject({ matched: false, recommendation: null });
  });
  it("covers both extractors and every repeated downstream call for two selected sources", async () => {
    const request = await fixture(); controlled("need_extract"); controlled("inventory_extract"); downstream("merge_dedupe"); downstream("status_derive");
    const org = await accuracyDb().select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.id, request.source_workspace_id));
    const second = await insertSourceFile({ workspace_id: request.source_workspace_id, org_id: org[0].org_id, filename: "second.txt", mime: "text/plain", checksum: newId("checksum") });
    await persistParseBlocks({ workspace_id: request.source_workspace_id, source_file_id: second.id, parser: "test", blocks: [{ id: newId("block"), source_file_id: second.id, index: 0, kind: "prose", heading: null, text: "Second evidence." }] });
    const result = await runPassComparison({ ...request, mode: "pipeline", call: undefined, source_file_ids: [...request.source_file_ids, second.id] }); workspaces.push(...result.experiments.map(row => row.workspace_id));
    expect(result.comparison.matched).toBe(true);
    for (const condition of result.comparison.conditions) {
      expect(condition.eligibility).toBe("eligible"); expect(condition.calls).toHaveLength(8);
      expect(condition.calls.filter(call => call.call_kind === "need_extract").map(call => call.lineage_key)).toEqual(request.source_file_ids.concat(second.id).map(id => `need_extract:${id}:0`));
      expect(condition.calls.filter(call => call.call_kind === "merge_dedupe").map(call => call.lineage_key)).toEqual(["merge_dedupe:workspace:0", "merge_dedupe:workspace:1"]);
      expect(condition.totals.summed_call_must_find_outcomes?.missed).toBe(158);
      expect(condition.totals.latency_ms).toBe(condition.calls.reduce((sum, call) => sum + call.runtime!.duration_ms!, 0));
    }
  });
  it.each(["comparison_id", "comparison_evaluator_version", "original_request_identity", "original_request_fingerprint", "critic_revision_passes", "experiment_cycle_control"])("rejects reserved %s before creating any copy", async key => {
    const request = await fixture();
    const before = await accuracyDb().select().from(t.accuracyExperiments).where(eq(t.accuracyExperiments.source_workspace_id, request.source_workspace_id));
    await expect(runPassComparison({ ...request, condition: { [key]: "forged" } })).rejects.toBeInstanceOf(PassComparisonValidationError);
    expect(await accuracyDb().select().from(t.accuracyExperiments).where(eq(t.accuracyExperiments.source_workspace_id, request.source_workspace_id))).toEqual(before);
  });
  it("returns uniform not-found for absent and foreign-workspace experiments", async () => {
    const request = await fixture(); controlled("need_extract"); const result = await runPassComparison(request); workspaces.push(...result.experiments.map(row => row.workspace_id));
    for (const args of [{ source_workspace_id: "foreign", experiment_ids: result.experiments.map(row => row.id) }, { source_workspace_id: request.source_workspace_id, experiment_ids: [result.experiments[0].id, "missing", result.experiments[2].id] }]) await expect(readPassComparison(args)).rejects.toBeInstanceOf(PassComparisonNotFoundError);
    await expect(readPassComparison({ source_workspace_id: request.source_workspace_id, experiment_ids: result.experiments.slice(0, 2).map(row => row.id) })).resolves.toMatchObject({ matched: false, recommendation: null });
  });
  it("retains failed attempts, snapshots and error evaluations", async () => {
    const request = await fixture(); controlled("need_extract", true);
    const result = await runPassComparison(request); workspaces.push(...result.experiments.map(row => row.workspace_id));
    expect(result.experiments.map(row => row.status)).toEqual(["failed", "failed", "failed"]);
    expect(result.experiments[0].calls.map(call => call.output_error)).toEqual([null, "controlled critic failure"]);
    expect(result.comparison.conditions.map(row => row.eligibility)).toEqual(["ineligible", "ineligible", "ineligible"]); expect(result.comparison.recommendation).toBeNull();
  });
  it("makes a control-ignoring module's completed single snapshot ineligible", async () => {
    const request = await fixture(); controlled("need_extract", false, true);
    const result = await runPassComparison(request); workspaces.push(...result.experiments.map(row => row.workspace_id));
    expect(result.experiments.map(row => row.status)).toEqual(["completed", "completed", "completed"]);
    expect(result.comparison.conditions.map(row => row.eligibility)).toEqual(["ineligible", "ineligible", "ineligible"]);
  });
  it("recovers a retained failed first attempt after persistence throws and returns an incomplete cohort", async () => {
    const request = await fixture(); controlled("need_extract");
    vi.spyOn(records, "recordVersionEvaluation").mockRejectedValueOnce(new Error("controlled evaluation persistence failure"));
    const result = await runPassComparison(request); workspaces.push(...result.experiments.map(row => row.workspace_id));
    expect(result.experiments).toHaveLength(1); expect(result.experiments[0].status).toBe("failed");
    expect(result.experiments[0].calls).toHaveLength(1); expect(result.comparison).toMatchObject({ matched: false, recommendation: null });
    expect(result.comparison.conditions[0].eligibility).toBe("ineligible");
    const retained = await records.getExperimentForSourceWorkspace({ source_workspace_id: request.source_workspace_id, experiment_id: result.experiments[0].id });
    expect(retained).toEqual(result.experiments[0]);
  });
});
