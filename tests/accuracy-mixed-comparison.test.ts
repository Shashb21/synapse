import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace, getWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import * as copies from "@/accuracy/experiments/copy-workspace";
import * as pipeline from "@/accuracy/experiments/mixed-pipeline";
import * as records from "@/accuracy/experiments/mixed-records";
import * as evaluator from "@/accuracy/eval/mixed-comparison";
import { runMixedComparison } from "@/accuracy/experiments/mixed-comparison";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
vi.mock("@/lib/iegp/db", async () => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL!, { max: 4 });
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { db: () => drizzle(client) };
});
const workspaces: string[] = [];
const actor = { name: "Server fixture actor", function: "medical_affairs" as const };
async function fixture(withGap = false) {
  const org_id = await createOrganization("KAN-40 paired fixture");
  const workspace_id = await createWorkspace({ org_id, name: "source", slug: newId("slug") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: "fixture-checksum" });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id, index: 0,
    kind: "prose", heading: null, text: "Original evidence supports the selected need and tactic.", parser: "fixture", created_at: nowIso() });
  const provenance = [{ source_file_id: source.id, block_id, quote: "supports the selected need" }];
  const selections: { item_version_id: string; reason: string }[] = [];
  for (const claim_type of withGap ? ["tactic", "gap"] as const : ["tactic"] as const) {
    const payload = claim_type === "tactic" ? { id: newId("tac"), name: "Selected tactic", type: "publication", status: "planned",
      origin: "inventory", evidence_question: "Does this meet the need?", start: "2026-01-01", end: "2026-02-01", provenance }
      : { id: newId("gap"), statement: "Selected need", external_id: "G-1", provenance };
    const run_id = newId("run"), now = nowIso(), field = claim_type === "gap" ? "gaps" : "tactics";
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id, workspace_id,
      call_kind: claim_type === "gap" ? "need_extract" : "inventory_extract", agent_role: "judge", module_id: "fixture", module_version: "1",
      status: "ok", started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
      input: { workspace_id, source_file_id: source.id }, output: { workspace_id, source_file_id: source.id, [field]: [payload] }, steps: [] });
    await publishGeneratedItemHistory({ workspace_id, source_file_id: source.id, run_id, claim_type,
      final_claims: [{ id: payload.id, workspace_id, source_file_id: source.id, claim_type, statement: claim_type === "gap" ? "Selected need" : "Selected tactic" }] });
    const [version] = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.run_id, run_id));
    selections.push({ item_version_id: version.id, reason: "Exact original selection" });
  }
  const assembly = await createAssembly({ workspace_id, actor, source_file_ids: [source.id], selections, mappings: [], coverage_run_ids: [], linking_complete: !withGap });
  return { source_workspace_id: workspace_id, source_file_ids: [source.id], pack_id: "beone-bgb-58067-prmt5i", actor,
    mixed: { assembly_id: assembly.id, fingerprint: assembly.fingerprint }, baseline: { assembly_id: assembly.id, fingerprint: assembly.fingerprint } };
}
async function run(request: Awaited<ReturnType<typeof fixture>>) {
  const record = await runMixedComparison(request);
  for (const attempt of Object.values(record.attempts)) if (attempt) workspaces.push(attempt.workspace_id);
  return record;
}
afterEach(async () => {
  vi.restoreAllMocks();
  const ids = [...new Set(workspaces.splice(0))];
  // Explicit test-only audit deletion precedes attempt teardown. Normal replay
  // intentionally retains linked copies, and setup drift already cleans its copies.
  if (ids.length) await accuracyDb().delete(t.accuracyMixedComparisons).where(inArray(t.accuracyMixedComparisons.source_workspace_id, ids));
  for (const id of ids.reverse()) if (await getWorkspace(id)) await deleteWorkspace(id);
});
afterAll(async () => { await closePool(); });
describe("matched paired replay with real Postgres and kernel", () => {
  it("both_copies_match_before_any_execution", async () => {
    const request = await fixture();
    const copy = vi.spyOn(copies, "copyExperimentWorkspace"), runner = vi.spyOn(pipeline, "runMixedCandidatePipeline");
    const capture = vi.spyOn(pipeline, "captureMixedPipelineConfiguration");
    const record = await run(request);
    expect(record.status).toBe("completed");
    expect(copy).toHaveBeenCalledTimes(2);
    expect(Math.max(...copy.mock.invocationCallOrder)).toBeLessThan(Math.min(...runner.mock.invocationCallOrder));
    expect(capture).toHaveBeenCalledTimes(1);
    const evidence = record.result!.evidence;
    expect(evidence.candidates.mixed!.setup).toEqual(evidence.candidates.baseline!.setup);
    expect(record.attempts.mixed!.workspace_id).not.toBe(record.attempts.baseline!.workspace_id);
    expect(record.attempts.mixed!.org_id).not.toBe(record.attempts.baseline!.org_id);
    expect(record.header.request.actor).toEqual(actor);
    for (const label of ["mixed", "baseline"] as const) {
      const candidate = evidence.candidates[label]!, attempt = record.attempts[label]!;
      expect(candidate.final_outputs!.plan.activities).toHaveLength(1);
      expect(candidate.final_outputs!.plan.activities[0].tactic_id).toBe(candidate.lineage[0].kind === "selected" ? candidate.lineage[0].copied_claim_id : "missing");
      expect(candidate.lineage[0]).toMatchObject({ kind: "selected", selection_reason: "Exact original selection" });
      expect(attempt.calls.length).toBeGreaterThan(0);
      expect(attempt.evaluations.length).toBe(attempt.calls.length);
      expect(attempt.calls.map(row => row.call_kind)).not.toContain("inventory_extract");
      expect((await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, attempt.workspace_id))).every(row => row.evaluation_context === "experiment")).toBe(true);
    }
    expect((await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, request.source_workspace_id))).every(row => !row.validated)).toBe(true);
  });
  it("source_drift_retains_failure_and_executes_neither", async () => {
    const request = await fixture(), original = copies.copyExperimentWorkspace;
    let count = 0;
    vi.spyOn(copies, "copyExperimentWorkspace").mockImplementation(async args => { const copy = await original(args); workspaces.push(copy.workspace_id); return ++count === 2 ? { ...copy, source_fingerprint: "drift" } : copy; });
    const runner = vi.spyOn(pipeline, "runMixedCandidatePipeline");
    const record = await run(request);
    expect(record.status).toBe("blocked");
    expect(record.result!.evidence.primary_error).toMatchObject({ phase: "setup", code: "identity_mismatch" });
    expect(runner).not.toHaveBeenCalled();
    expect(record.links).toBeNull();
  });
  it("setup_failure_survives_failure_result_persistence_error", async () => {
    const request = await fixture();
    const setupError = Object.assign(new Error("Original setup configuration failure"), { code: "configuration_unavailable" });
    const storageError = new Error("Failure-result store unavailable");
    vi.spyOn(pipeline, "captureMixedPipelineConfiguration").mockRejectedValue(setupError);
    const persist = vi.spyOn(records, "finishMixedComparison").mockRejectedValue(storageError);
    const runner = vi.spyOn(pipeline, "runMixedCandidatePipeline");

    await expect(runMixedComparison(request)).rejects.toMatchObject({
      message: setupError.message, code: setupError.code, cause: storageError,
    });

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({
      status: "failed", primary_error: expect.objectContaining({ phase: "setup", code: setupError.code, message: setupError.message }),
    }) }));
    expect(runner).not.toHaveBeenCalled();
  });
  it("independent_candidate_failure_does_not_cancel_valid_peer", async () => {
    const request = await fixture(), original = pipeline.runMixedCandidatePipeline;
    vi.spyOn(pipeline, "runMixedCandidatePipeline").mockImplementation(async args => args.evidence.label === "mixed"
      ? { ...args.evidence, status: "failed", primary_error: { phase: "pipeline", code: "fixture_failure", message: "primary failure", stage: "pair_generate", call_id: null } }
      : original(args));
    const record = await run(request);
    expect(record.status).toBe("failed");
    expect(record.result!.evidence.primary_error?.message).toBe("primary failure");
    expect(record.attempts.baseline!.status).toBe("completed");
    expect(record.result!.evidence.candidates.baseline!.final_outputs!.plan.activities).toHaveLength(1);
  });
  it("rerun_creates_separate_attempts", async () => {
    const request = await fixture(), first = await run(request), second = await run(request);
    expect(first.header.id).not.toBe(second.header.id);
    for (const label of ["mixed", "baseline"] as const) expect(first.attempts[label]!.id).not.toBe(second.attempts[label]!.id);
  });
  it("evaluator_failure_preserves_successful_evidence", async () => {
    const request = await fixture();
    vi.spyOn(evaluator, "evaluateMixedComparison").mockRejectedValue(new Error("evaluation unavailable"));
    const record = await run(request);
    expect(record.status).toBe("failed");
    expect(record.result!.evidence.primary_error).toMatchObject({ phase: "evaluation", message: "evaluation unavailable" });
    expect(record.result!.evidence.candidates.mixed!.status).toBe("completed");
    expect(record.attempts.mixed!.calls.length).toBeGreaterThan(0);
  });
  it("persistence_failure_never_reports_completed", async () => {
    const request = await fixture(), original = records.finishMixedComparison;
    vi.spyOn(records, "finishMixedComparison").mockImplementation(async args => { if (args.result.status === "completed") throw new Error("terminal write failed"); return original(args); });
    const record = await run(request);
    expect(record.status).toBe("failed");
    expect(record.result!.evidence.primary_error).toMatchObject({ phase: "persistence", message: "terminal write failed" });
    expect(record.result!.evidence.candidates.mixed!.status).toBe("completed");
  });
  it("real_gap_tactic_coverage_and_status_are_retained_before_priority_block", async () => {
    const record = await run(await fixture(true));
    expect(record.status).toBe("blocked");
    for (const label of ["mixed", "baseline"] as const) {
      const evidence = record.result!.evidence.candidates[label]!, attempt = record.attempts[label]!;
      expect(evidence.stages.find(row => row.stage === "coverage_decide")?.status).toBe("completed");
      expect(evidence.stages.find(row => row.stage === "status_derive")?.status).toBe("completed");
      expect(evidence.gates.some(row => row.object_type === "coverage" && row.decision === "pass")).toBe(true);
      expect(attempt.calls.some(row => row.call_kind === "coverage_decide" && row.output)).toBe(true);
      expect(attempt.evaluations.length).toBe(attempt.calls.length);
      expect(evidence.primary_error?.stage).toBe("prioritize");
    }
  });
});
