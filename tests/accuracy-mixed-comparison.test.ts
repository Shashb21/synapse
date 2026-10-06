import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
import { mixedCandidateEvidenceSchema } from "@/accuracy/experiments/mixed-types";
import type { MixedComparisonResult, MixedItemLineage } from "@/accuracy/experiments/mixed-types";
import * as routing from "@/accuracy/kernel/routing";
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
async function fixture(withGap = false, reversedMixed = false) {
  const org_id = await createOrganization("KAN-40 paired fixture");
  const workspace_id = await createWorkspace({ org_id, name: "source", slug: newId("slug") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: "fixture-checksum" });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id, index: 0,
    kind: "prose", heading: null, text: "Original evidence supports the selected need and tactic.", parser: "fixture", created_at: nowIso() });
  const provenance = [{ source_file_id: source.id, block_id, quote: "supports the selected need" }];
  let selectedTactic: Record<string, unknown> | undefined;
  const selections: { item_version_id: string; reason: string }[] = [];
  for (const claim_type of withGap ? ["tactic", "gap"] as const : ["tactic"] as const) {
    const payload = claim_type === "tactic" ? { id: newId("tac"), name: "Selected tactic", type: "publication", status: "planned",
      origin: "inventory", evidence_question: "Does this meet the need?", start: "2026-01-01", end: "2026-02-01", provenance }
      : { id: newId("gap"), statement: "Selected need", external_id: "G-1", provenance };
    if (claim_type === "tactic") selectedTactic = payload;
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
  let mixedAssembly = assembly;
  if (reversedMixed) {
    const payload = { ...selectedTactic!, id: newId("tac"), end: "2025-12-01" };
    const run_id = newId("run"), now = nowIso();
    await accuracyDb().insert(t.accuracyModuleRuns).values({
      id: run_id, org_id, workspace_id, call_kind: "inventory_extract", agent_role: "judge",
      module_id: "fixture", module_version: "1", status: "ok", started_at: now, finished_at: now,
      actor_name: actor.name, actor_function: actor.function,
      input: { workspace_id, source_file_id: source.id },
      output: { workspace_id, source_file_id: source.id, tactics: [payload] }, steps: [],
    });
    await publishGeneratedItemHistory({ workspace_id, source_file_id: source.id, run_id, claim_type: "tactic",
      final_claims: [{ id: String(payload.id), workspace_id, source_file_id: source.id, claim_type: "tactic", statement: "Selected tactic" }] });
    const [version] = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.run_id, run_id));
    mixedAssembly = await createAssembly({ workspace_id, actor, source_file_ids: [source.id],
      selections: [{ item_version_id: version.id, reason: "Exact reversed timing selection" }],
      mappings: [], coverage_run_ids: [], linking_complete: true });
  }
  return { source_workspace_id: workspace_id, source_file_ids: [source.id], pack_id: "beone-bgb-58067-prmt5i", actor,
    mixed: { assembly_id: mixedAssembly.id, fingerprint: mixedAssembly.fingerprint }, baseline: { assembly_id: assembly.id, fingerprint: assembly.fingerprint } };
}
function controlledProvider(scenario?: string) {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    vi.spyOn(routing, "resolveAccuracyRoute").mockImplementation(async ({ call_kind, agent_role }) => ({ call_kind, role: agent_role, provider_id: "xai-grok", provider_label: "Controlled fixture", model: "controlled-fixture", auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 100 }, fallbacks: [], degraded: false, reason: null }));
    return vi.spyOn(routing, "accuracyCompletionFor").mockImplementation(({ onUsage }) => async args => {
      let output: unknown;
      if (args.purpose.startsWith("coverage-decide:")) {
        const input = JSON.parse(args.user);
        output = { gap_id: input.gap_id, tactic_id: input.tactic_id, overall: "partial", confidence: 0.8, rationale: "Selected tactic covers survival; quality of life remains open", quote_block_ids: input.evidence_blocks.map((block: { id: string }) => block.id) };
      } else if (args.purpose.startsWith("coverage-critic:")) output = { accept: true, issues: [] };
      else if (args.purpose === "partial-split-proposer") {
        const input = JSON.parse(args.user);
        output = { addressed: { statement: "Survival evidence provided by the selected tactic" }, residual: { statement: "Quality of life evidence needed for the launch decision" }, tactic_ids: input.tactics.map((row: { id: string }) => row.id), coverage_ids: input.coverage.map((row: { id: string }) => row.id), rationale: "The committed tactic supports the survival slice only", source_context: input.parent.payload.provenance };
        const split = output as { addressed: { statement: string }; residual: { statement: string }; tactic_ids: string[]; source_context: Array<{ quote: string }> };
        if (scenario === "parent copy") split.addressed.statement = input.parent.statement;
        if (scenario === "duplicate children") split.addressed.statement = split.residual.statement;
        if (scenario === "unsupported context") split.source_context[0].quote = "Invented quotation";
        if (scenario === "crossed tactic") split.tactic_ids = ["other-workspace-tactic"];
      } else if (args.purpose === "priority-suggester") {
        const input = JSON.parse(args.user);
        output = { gaps: input.gaps.map((gap: { id: string }) => ({ gap_id: gap.id, scores: Object.fromEntries(input.axes.axes.map((axis: { id: string }) => [axis.id, 90])), rationale: "Launch decision requires the remaining evidence" })) };
      } else if (args.purpose.startsWith("ideate:proposer:")) {
        const gap_id = /- gap_id=([^\n]+)/.exec(args.user)![1];
        output = { proposals: [{ gap_id, name: "Prospective quality of life study", type: "rwe_study", origin: "ideated", status: "proposed", design_summary: "Prospective patient survey to measure quality of life using validated outcomes", not_from_reference: true }] };
      } else throw new Error(`Unexpected fixture purpose ${args.purpose}`);
      const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
      onUsage(usage, 0);
      return { raw: JSON.stringify(output), usage };
    });
}
async function sourceSnapshot(workspace_id: string) {
  return Promise.all([
    accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace_id)),
    accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, workspace_id)),
    accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, workspace_id)),
    accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, workspace_id)),
    accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, workspace_id)),
  ]);
}
async function run(request: Awaited<ReturnType<typeof fixture>>) {
  const record = await runMixedComparison(request);
  for (const attempt of Object.values(record.attempts)) if (attempt) workspaces.push(attempt.workspace_id);
  return record;
}
function fingerprint(value: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** Execute real generation but hold the initial terminal append for mutation tests. */
async function beforeTerminal() {
  controlledProvider();
  const finish = records.finishMixedComparison;
  let terminal: Parameters<typeof finish>[0] | undefined;
  vi.spyOn(records, "finishMixedComparison").mockImplementationOnce(async args => {
    terminal = structuredClone(args);
    return (await records.readMixedComparison(args))!;
  });
  const record = await run(await fixture(true));
  expect(terminal?.result.status).toBe("completed");
  return { finish, terminal: terminal! as Parameters<typeof finish>[0] & { result: Extract<MixedComparisonResult, { status: "completed" }> }, record };
}
/** Retain an aggregate independently of native output for adversarial binding checks. */
async function retainAggregate(candidate: Extract<MixedComparisonResult, { status: "completed" }>["candidates"]["mixed"], record: Awaited<ReturnType<typeof beforeTerminal>>["record"], stageName: "validation_gate" | "ideate") {
  const stage = candidate.stages.find(row => row.stage === stageName)!;
  if (stage.status !== "completed") throw new Error("Missing completed fixture stage");
  const previous = record.attempts.mixed!.calls.find(row => row.call_kind === stageName)!;
  const call_id = newId("aggregate");
  // Test-only direct fixture insertion models a retained aggregate that agrees
  // with forged terminal evidence while leaving the native final call intact.
  await accuracyDb().insert(t.accuracyExperimentCalls).values({ ...previous, id: newId("call"), call_id, version_index: 0, output: stage.output, route: { kind: "deterministic_artifact" } });
  stage.calls.push({ call_id, version_index: 0 });
  stage.run_ids.push(call_id);
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
  it("reversed_plan_dates_terminalize_blocked_while_valid_baseline_completes", async () => {
    // Arrange: immutable nominations share source context, with invalid timing only in mixed.
    const request = await fixture(false, true);

    // Act: use the real copy, materialization, kernel, evaluator, and terminal persistence path.
    const record = await run(request);

    // Assert: the comparison retains a blocker; generic experiment attempts use failed for any non-completion.
    expect(record.status).toBe("blocked");
    expect(record.attempts.mixed!.status).toBe("failed");
    expect(record.attempts.baseline!.status).toBe("completed");
    const mixed = record.result!.evidence.candidates.mixed!;
    expect(mixed.status).toBe("blocked");
    expect(mixed.primary_error).toMatchObject({ code: "invalid_plan_structure", stage: "gantt_project" });
    expect(mixed.gates.filter(gate => gate.object_type === "plan")).toEqual([
      expect.objectContaining({ decision: "block", findings: expect.arrayContaining([
        expect.objectContaining({ code: "reversed_plan_dates", severity: "blocking" }),
      ]) }),
    ]);
    expect(record.attempts.mixed!.calls.find(row => row.call_kind === "gantt_project")!.output).toMatchObject({
      activities: [expect.objectContaining({ start: "2026-01-01", end: "2025-12-01" })],
    });
    expect(record.result!.evidence.candidates.baseline!.final_outputs!.plan.activities).toHaveLength(1);
  });
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
  it("real_nonempty_open_pipeline_completes_with_durable_priorities", async () => {
    const record = await run(await fixture(true));
    expect(record.status).toBe("completed");
    for (const label of ["mixed", "baseline"] as const) {
      const evidence = record.result!.evidence.candidates[label]!, attempt = record.attempts[label]!;
      expect(evidence.stages.find(row => row.stage === "coverage_decide")?.status).toBe("completed");
      expect(evidence.stages.find(row => row.stage === "status_derive")?.status).toBe("completed");
      expect(evidence.gates.some(row => row.object_type === "coverage" && row.decision === "pass")).toBe(true);
      expect(attempt.calls.some(row => row.call_kind === "coverage_decide" && row.output)).toBe(true);
      expect(attempt.evaluations.length).toBe(attempt.calls.length);
      expect(evidence.final_outputs!.priorities).toHaveLength(1);
      expect(evidence.stages.find(row => row.stage === "prioritize")?.status).toBe("completed");
    }
  });
  it("controlled_provider_completes_paired_partial_children_ideation_and_full_export", async () => {
    // The test controls only routing and the completion adapter; native modules,
    // kernel parsing, gates, stores, evaluator and paired orchestration all execute.
    const request = await fixture(true);
    const before = await sourceSnapshot(request.source_workspace_id);
    const completion = controlledProvider();
    try {
      const record = await run(request);
      expect(record.status, JSON.stringify(record.result?.evidence.primary_error)).toBe("completed");
      for (const label of ["mixed", "baseline"] as const) {
        const evidence = record.result!.evidence.candidates[label]!;
        const final = evidence.final_outputs!;
        const split = final.residuals[0];
        expect(final.residuals).toHaveLength(1);
        expect(new Set([split.parent_gap_id, split.addressed_gap_id, split.open_residual_gap_id]).size).toBe(3);
        expect(final.statuses).toEqual(expect.arrayContaining([
          expect.objectContaining({ gap_id: split.parent_gap_id, status: "partial" }),
          expect.objectContaining({ gap_id: split.addressed_gap_id, status: "addressed" }),
          expect.objectContaining({ gap_id: split.open_residual_gap_id, status: "open" }),
        ]));
        expect(final.priorities.map(row => row.gap_id)).toEqual([split.open_residual_gap_id]);
        expect(final.proposals.map(row => row.gap_id)).toEqual([split.open_residual_gap_id]);
        expect(final.plan.activities).toHaveLength(1); // Proposed tactic has no dates.
        expect(final.plan.activities[0].gap_ids).toContain(split.addressed_gap_id);
        expect(evidence.lineage.filter(row => row.kind === "residual")).toHaveLength(2);
        expect(evidence.final_source_inventory).toEqual(evidence.entry_source_inventory);
        expect(mixedCandidateEvidenceSchema.safeParse({ ...evidence, lineage: evidence.lineage.filter(row => row.kind !== "residual" || row.copied_claim_id !== split.addressed_gap_id) }).success).toBe(false);
        const forged = structuredClone(evidence);
        forged.final_outputs!.statuses.find(row => row.gap_id === split.addressed_gap_id)!.computed = "open";
        expect(mixedCandidateEvidenceSchema.safeParse(forged).success).toBe(false);
        expect(evidence.setup!.pack_fingerprint).toBe(record.header.pack_fingerprint);
        expect(evidence.setup!.downstream_evaluator_version).toBe("mixed-downstream-v2");
        const generatedIds = evidence.lineage.flatMap(row => row.kind === "residual" || row.kind === "ideated" ? [row.copied_claim_id] : []);
        const durable = await accuracyDb().select().from(t.accuracyClaims).where(inArray(t.accuracyClaims.id, generatedIds));
        expect(durable).toHaveLength(3);
        expect(durable.every(row => row.validated)).toBe(true);
        const retained = record.attempts[label]!;
        expect(retained.calls.length).toBe(retained.evaluations.length);
        expect(retained.calls.filter(row => row.call_kind === "partial_split")).toHaveLength(2);
        expect(retained.calls.some(row => row.call_kind === "gantt_project" && row.output)).toBe(true);
      }
      const json = await records.exportMixedComparison({ source_workspace_id: request.source_workspace_id, comparison_id: record.header.id, format: "json" });
      const jsonl = await records.exportMixedComparison({ source_workspace_id: request.source_workspace_id, comparison_id: record.header.id, format: "jsonl" });
      expect(json).toContain("source_context"); expect(jsonl).toContain("Prospective quality of life study");
      expect(record.result!.evidence.evaluation!.changes.filter(row => row.proven_error)).toEqual([]);
      expect(completion).toHaveBeenCalled();
      expect(await sourceSnapshot(request.source_workspace_id)).toEqual(before);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["residual", "ideated"] as const)("terminal rejects changed %s payload while original IDs, gates and aggregates remain", async kind => {
    const { finish, terminal } = await beforeTerminal();
    const lineage = terminal.result.candidates.mixed.lineage.find(row => row.kind === kind)!;
    if (lineage.kind !== "residual" && lineage.kind !== "ideated") throw new Error("Missing generated fixture lineage");
    lineage.payload[kind === "residual" ? "statement" : "design_summary"] = "Replacement content never checked by the retained gate";

    await expect(finish(terminal).then(() => "accepted")).rejects.toMatchObject({ code: "incomplete_evidence" });
    expect((await records.readMixedComparison(terminal))!.status).toBe("running");
  });

  it.each(["residual", "ideated"] as const)("terminal binds %s payload to native final output even with a recomputed gate", async kind => {
    const { finish, terminal, record } = await beforeTerminal();
    const candidate = terminal.result.candidates.mixed;
    const lineage = candidate.lineage.find(row => row.kind === kind)!;
    if (lineage.kind !== "residual" && lineage.kind !== "ideated") throw new Error("Missing generated fixture lineage");
    const gate = candidate.gates.find(row => row.object_ids.includes(lineage.copied_claim_id) && row.object_type === (kind === "residual" ? "residual" : "proposal"))!;
    lineage.payload[kind === "residual" ? "statement" : "design_summary"] = "Replacement content with a forged current gate";
    if (kind === "residual") {
      const native = structuredClone(record.attempts.mixed!.calls.find(row => row.call_id === lineage.run_id && row.version_index === 0)!.output) as Record<string, unknown>;
      native.addressed = lineage.payload;
      gate.content_fingerprint = fingerprint(native);
    } else {
      gate.content_fingerprint = fingerprint(lineage.payload);
      candidate.final_outputs.proposals[0] = lineage.payload as never;
      const stage = candidate.stages.find(row => row.stage === "ideate")!;
      if (stage.stage !== "ideate" || stage.status !== "completed") throw new Error("Missing ideation stage");
      stage.output.proposals[0] = lineage.payload as never;
      await retainAggregate(candidate, record, "ideate");
    }
    const validation = candidate.stages.find(row => row.stage === "validation_gate")!;
    if (validation.stage !== "validation_gate" || validation.status !== "completed") throw new Error("Missing gate stage");
    validation.output.decisions = candidate.gates;
    await retainAggregate(candidate, record, "validation_gate");
    const parsed = mixedCandidateEvidenceSchema.safeParse(candidate);
    expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);

    await expect(finish(terminal).then(() => "accepted")).rejects.toThrow(/native generation output/);
    expect((await records.readMixedComparison(terminal))!.status).toBe("running");
  });

  it.each(["child payload", "proposal payload", "unvalidated claim", "missing provenance", "changed provenance", "crossed provenance"])("terminal rejects durable generated %s drift", async scenario => {
    const { finish, terminal } = await beforeTerminal();
    const generated = terminal.result.candidates.mixed.lineage.filter((row): row is Extract<MixedItemLineage, { kind: "residual" | "ideated" }> => row.kind === "residual" || row.kind === "ideated");
    const child = generated.find(row => row.kind === "residual")!, proposal = generated.find(row => row.kind === "ideated")!;
    if (scenario === "child payload" || scenario === "proposal payload") {
      const id = scenario === "child payload" ? child.copied_claim_id : proposal.copied_claim_id;
      const [claim] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, id));
      await accuracyDb().update(t.accuracyClaims).set({ metadata: { ...(claim.metadata as Record<string, unknown>), [scenario === "child payload" ? "statement" : "design_summary"]: "Durable replacement never generated" } }).where(eq(t.accuracyClaims.id, id));
    } else if (scenario === "unvalidated claim") {
      await accuracyDb().update(t.accuracyClaims).set({ validated: false }).where(eq(t.accuracyClaims.id, proposal.copied_claim_id));
    } else if (scenario === "missing provenance") {
      await accuracyDb().delete(t.accuracyProvenance).where(eq(t.accuracyProvenance.id, child.copied_evidence_ids[0]));
    } else {
      await accuracyDb().update(t.accuracyProvenance).set(scenario === "changed provenance" ? { quote: "Invented quote" } : { claim_id: proposal.copied_claim_id }).where(eq(t.accuracyProvenance.id, child.copied_evidence_ids[0]));
    }

    await expect(finish(terminal).then(() => "accepted")).rejects.toMatchObject({ code: "identity_mismatch" });
    expect((await records.readMixedComparison(terminal))!.status).toBe("running");
  });

  it.each(["parent copy", "duplicate children", "unsupported context", "crossed tactic"])("rejects generated %s before child materialization", async scenario => {
    const request = await fixture(true);
    controlledProvider(scenario);
    try {
      const record = await run(request);
      expect(record.status).toBe("blocked");
      for (const label of ["mixed", "baseline"] as const) {
        const candidate = record.result!.evidence.candidates[label]!;
        expect(candidate.primary_error).toMatchObject({ code: "deterministic_gate_blocked", stage: "partial_split" });
        expect(candidate.gates.some(gate => gate.object_type === "residual" && gate.decision === "block")).toBe(true);
        expect(candidate.lineage.filter(row => row.kind === "residual")).toEqual([]);
        expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, candidate.copied_workspace_id!))).toHaveLength(2);
        expect(record.attempts[label]!.calls.some(row => row.call_kind === "partial_split" && row.output)).toBe(true);
      }
    } finally { vi.unstubAllEnvs(); }
  });

});
