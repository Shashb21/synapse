import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrganization, createWorkspace, deleteWorkspace, getAuthorizedWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { createExperiment, exportExperiments, finishExperiment, getExperiment, recordExperimentCall, recordVersionEvaluation } from "@/accuracy/experiments/records";
import { evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";
import { and, eq, sql } from "drizzle-orm";
import { accuracyDb, withAccuracyTransaction } from "@/accuracy/store/db";
import { ACCURACY_MIGRATIONS } from "@/accuracy/store/schema";
import * as tables from "@/accuracy/store/schema";
import postgres from "postgres";
import { AccuracyRunRecorder, openAccuracyRun, closeAccuracyRun, reservedAccuracyRun } from "@/accuracy/kernel/observability";
import { runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import { structuralIssueKey } from "@/accuracy/kernel/structural-fate";
import { accuracyCompletionFor } from "@/accuracy/kernel/routing";
import type { ResolvedAccuracyRoute } from "@/accuracy/kernel/contracts";

const workspaces: string[] = [];
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedCallInsert(client: ReturnType<typeof postgres>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await client.unsafe<{ waiting: boolean }[]>(
      "SELECT EXISTS (SELECT 1 FROM pg_locks AS lock JOIN pg_class AS relation ON relation.oid = lock.relation WHERE relation.relname = 'accuracy_experiment_calls' AND lock.mode = 'RowExclusiveLock' AND NOT lock.granted) AS waiting",
    );
    if (rows[0]?.waiting) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error("Append did not reach the blocked child insert.");
}
async function fixture() {
  const org_id = await createOrganization("experiment-records");
  const source_workspace_id = await createWorkspace({ org_id, name: "source", slug: `source-${Date.now()}-${Math.random()}` });
  const workspace_id = await createWorkspace({ org_id, name: "experiment", slug: `experiment-${Date.now()}-${Math.random()}` });
  workspaces.push(source_workspace_id, workspace_id);
  return { org_id, workspace_id, source_workspace_id };
}
afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });

describe("experiment records", () => {
  it("reads and exports malformed historical rows as unavailable while retaining valid identity", async () => {
    const scope = await fixture();
    const experiment = await createExperiment({ ...scope, pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source",
      baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    const run = new AccuracyRunRecorder({ ...scope, call_kind: "need_extract", agent_role: "proposer", module_id: "extract",
      module_version: "v1", evaluation_context: "experiment", actor: { name: "test", function: "medical_affairs" }, input: {} });
    await openAccuracyRun(run);
    await closeAccuracyRun({ recorder: run, status: "ok", output: { gaps: [] } });
    await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: run.id,
      call_kind: "need_extract", version_index: 0, input: {}, output: { gaps: [] }, module_version: "v1", route: {} });
    await finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "completed" });
    const valid = (await getExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id }))!.run_evidence![0].execution_identity;
    expect(valid.status).toBe("available");
    expect(valid.identities).toHaveLength(1);
    for (const row of [{ name: 42 }, { name: {} }, { name: null }, {}, null, 42, "corrupt", false, []]) {
      // Simulate corrupted JSON retained by a historical run, alongside its valid identity.
      await accuracyDb().update(tables.accuracyModuleRuns).set({ steps: [...run.steps(), row] })
        .where(and(eq(tables.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(tables.accuracyModuleRuns.id, run.id)));
      const expected = { ...valid, status: "unavailable" };
      for (const format of ["json", "jsonl"] as const) {
        const exported = JSON.parse((await exportExperiments({ workspace_id: scope.workspace_id, format })).trim());
        const retained = format === "json" ? exported[0] : exported;
        expect(retained.id).toBe(experiment.id);
        expect(retained.calls).toHaveLength(1);
        expect(retained.run_evidence[0].execution_identity).toEqual(expected);
      }
      const record = await getExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id });
      expect(record?.run_evidence?.[0].execution_identity).toEqual(expected);
    }
  });
  it("roundtrips all structural dispositions and exact execution evidence in complete JSON and JSONL history", async () => {
    const scope = await fixture();
    const pack_id = "beone-bgb-58067-prmt5i";
    const experiment = await createExperiment({ ...scope, pack_id, source_fingerprint: "source", baseline_fingerprint: "baseline",
      baseline_snapshot: {}, condition: {} });
    const run = new AccuracyRunRecorder({ ...scope, call_kind: "need_extract", agent_role: "proposer", module_id: "extract",
      module_version: "v1", evaluation_context: "experiment", experiment_cycle_control: { critic_revision_passes: 1 },
      actor: { name: "test", function: "medical_affairs" }, input: {} });
    await openAccuracyRun(run);
    const route: ResolvedAccuracyRoute = { call_kind: "need_extract", role: "proposer", provider_id: "xai-grok", provider_label: "xAI",
      model: "configured-model", auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 200 }, fallbacks: [], degraded: false, reason: null };
    const outcomes = ["resolved", "partly_resolved", "invalid", "unresolved"] as const;
    const findings = outcomes.map(outcome => ({ issue_id: outcome, category: "structural", code: "unsupported", severity: "high" as const,
      claim: `Source-backed assessment ${outcome}`, suggested_action: "Review evidence" }));
    try {
      vi.stubEnv("XAI_API_KEY", "kan4-secret");
      vi.stubGlobal("fetch", async () => {
        const before = await reservedAccuracyRun(scope.workspace_id, run.id);
        expect(before?.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "llm:completion:started",
          data: expect.objectContaining({ system_fingerprint: expect.any(String), user_fingerprint: expect.any(String) }) })]));
        return new Response(JSON.stringify({ model: "response-model", system_fingerprint: "revision",
          choices: [{ message: { content: "x".repeat(45000) } }] }), { status: 200 });
      });
      await accuracyCompletionFor({ route, run, onUsage: () => {} })({ system: "exact system", user: "exact source prompt", purpose: "extract:r0" });
      vi.stubGlobal("fetch", async () => { throw new Error("provider failed kan4-secret"); });
      await expect(accuracyCompletionFor({ route, run, onUsage: () => {} })({ system: "exact system", user: "retry source", purpose: "extract:r1" })).rejects.toThrow("provider failed");
      const failed = await reservedAccuracyRun(scope.workspace_id, run.id);
      expect(failed?.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "llm:completion:finished", data: expect.objectContaining({ status: "failed" }) })]));
      const cycle = await runShallowAgenticCycle({ run, proposer: async round => ({ gaps: [], round }),
        onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }),
        critic: async (draft, prior) => ({ score: 1, issues: draft.round === 0 ? findings : [],
          prior_issue_resolutions: prior.map((issue, index) => ({ issue_key: structuralIssueKey(issue), issue, outcome: outcomes[index],
            reason: "Source assessment completed", evidence: { kind: "validated_assessment", explanation: "Independent source review" } })) }),
        validateStructuralResolution: async draft => draft.round === 1, judge: async draft => draft });
      await closeAccuracyRun({ recorder: run, status: "ok", output: cycle.final, route });
      const progression = await readAgentProgression({ workspace_id: scope.workspace_id, run_id: run.id });
      for (const row of progression!.events) if (row.event.event_type === "snapshot") {
        await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: run.id,
          call_kind: "need_extract", version_index: row.event.iteration, input: {}, output: row.event.output, module_version: "v1", route });
        await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: run.id,
          version_index: row.event.iteration, evaluation: evaluateExperimentVersion({ pack_id, call_kind: "need_extract", output: row.event.output }) });
      }
      await finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "completed" });
      for (const format of ["json", "jsonl"] as const) {
        const exported = JSON.parse((await exportExperiments({ workspace_id: scope.workspace_id, format })).trim());
        const retained = format === "json" ? exported[0] : exported;
        expect(retained.run_evidence[0].execution_identity.completions[0]).toMatchObject({ purpose: "extract:r0", status: "succeeded",
          system_fingerprint: expect.any(String), user_fingerprint: expect.any(String), configured_model: "configured-model", provider_revision: "revision" });
        expect(retained.run_evidence[0].execution_identity.identities[0].source_fingerprint).toEqual(expect.any(String));
        expect(retained.run_evidence[0].execution_identity.completions[1]).toMatchObject({ status: "failed", purpose: "extract:r1", provider_revision: null });
        expect(retained.run_evidence[0].events.find((event: { event_type: string; iteration: number }) => event.event_type === "critique" && event.iteration === 1)
          .structural_fate.prior_issue_resolutions.map((resolution: { outcome: string }) => resolution.outcome)).toEqual(outcomes);
        expect(retained.calls).toHaveLength(2); expect(retained.evaluations).toHaveLength(2);
        expect(JSON.stringify(retained)).not.toContain("kan4-secret");
      }
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
  it("allows a source workspace only to its granted subject or an operator", async () => {
    const scope = await fixture();
    expect(await getAuthorizedWorkspace({ workspace_id: scope.source_workspace_id, subject: "different-org-user", role: "contributor" })).toBeNull();
    await grantOrganizationAccess({ subject: "source-org-user", org_id: scope.org_id });
    await expect(getAuthorizedWorkspace({ workspace_id: scope.source_workspace_id, subject: "source-org-user", role: "contributor" }))
      .resolves.toMatchObject({ id: scope.source_workspace_id, org_id: scope.org_id });
    await expect(getAuthorizedWorkspace({ workspace_id: scope.source_workspace_id, subject: "platform-operator", role: "operator" }))
      .resolves.toMatchObject({ id: scope.source_workspace_id });
  });

  it("removes organization grants when its final workspace is deleted", async () => {
    const org_id = await createOrganization("grant-cleanup");
    const workspace_id = await createWorkspace({ org_id, name: "Only workspace", slug: `grant-cleanup-${Date.now()}` });
    await grantOrganizationAccess({ subject: "deleted-org-user", org_id });
    await deleteWorkspace(workspace_id);
    const grants = await accuracyDb().select().from(tables.accuracyOrganizationGrants).where(eq(tables.accuracyOrganizationGrants.org_id, org_id));
    expect(grants).toEqual([]);
  });

  it("keeps identical attempts, all call versions, and complete exports", async () => {
    const scope = await fixture();
    const base = { ...scope, pack_id: "beone-bgb-58067-prmt5i", pack_fingerprint: "pack", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: { sources: [] }, condition: { temperature: 0 } };
    const first = await createExperiment(base);
    const second = await createExperiment(base);
    expect(second.id).not.toBe(first.id);
    const call = await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "run-1", call_kind: "need_extract", version_index: 0, input: { source_file_id: "copy" }, output: { gaps: [] }, module_version: "need-v1", route: { model: "test" } });
    await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: call.call_id, version_index: 0, evaluation: evaluateExperimentVersion({ pack_id: first.pack_id, call_kind: "need_extract", output: { gaps: [] } }) });
    await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "run-1", call_kind: "need_extract", version_index: 1, input: { source_file_id: "copy" }, output: { gaps: [] }, module_version: "need-v1", route: { model: "test" } });
    await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: call.call_id, version_index: 1, evaluation: evaluateExperimentVersion({ pack_id: first.pack_id, call_kind: "need_extract", output: { gaps: [] } }) });
    await finishExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id, status: "completed" });

    const record = await getExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id });
    expect(record?.calls.map((row) => [row.call_id, row.version_index])).toEqual([["run-1", 0], ["run-1", 1]]);
    expect(record?.evaluations.map((row) => row.version_index)).toEqual([0, 1]);
    const json = await exportExperiments({ workspace_id: scope.workspace_id, format: "json" });
    const jsonl = await exportExperiments({ workspace_id: scope.workspace_id, format: "jsonl" });
    expect(JSON.parse(json)).toHaveLength(2);
    expect(jsonl.trim().split("\n").map((line) => JSON.parse(line))).toHaveLength(2);
    await expect(recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "late", call_kind: "need_extract", version_index: 0, input: {}, output: {}, module_version: "v1", route: {} })).rejects.toThrow("terminal");
    await expect(finishExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id, status: "failed" })).rejects.toThrow("terminal");
  });

  it("rejects reads outside the owning workspace", async () => {
    const owner = await fixture(); const other = await fixture();
    const record = await createExperiment({ ...owner, pack_id: "beone-bgb-58067-prmt5i", pack_fingerprint: "pack", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    expect(await getExperiment({ workspace_id: other.workspace_id, experiment_id: record.id })).toBeNull();
    await expect(recordExperimentCall({ workspace_id: other.workspace_id, experiment_id: record.id, call_id: "cross", call_kind: "need_extract", version_index: 0, input: {}, output: {}, module_version: "v1", route: {} })).rejects.toThrow("Unknown experiment");
  });

  it("exports tied child records in a stable call and row order", async () => {
    const scope = await fixture();
    const experiment = await createExperiment({ ...scope, pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    for (const call_id of ["call-b", "call-a"]) {
      await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id, call_kind: "need_extract", version_index: 0, input: {}, output: { call_id }, module_version: "v1", route: {} });
      await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id, version_index: 0, evaluation: evaluateExperimentVersion({ pack_id: experiment.pack_id, call_kind: "need_extract", output: { gaps: [] } }) });
    }
    const tiedAt = "2026-10-01T00:00:00.000Z";
    await accuracyDb().update(tables.accuracyExperimentCalls).set({ recorded_at: tiedAt }).where(and(eq(tables.accuracyExperimentCalls.workspace_id, scope.workspace_id), eq(tables.accuracyExperimentCalls.experiment_id, experiment.id)));
    await accuracyDb().update(tables.accuracyExperimentEvaluations).set({ recorded_at: tiedAt }).where(and(eq(tables.accuracyExperimentEvaluations.workspace_id, scope.workspace_id), eq(tables.accuracyExperimentEvaluations.experiment_id, experiment.id)));
    await finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "completed" });

    const first = await exportExperiments({ workspace_id: scope.workspace_id, format: "json" });
    const second = await exportExperiments({ workspace_id: scope.workspace_id, format: "json" });
    const lines = await exportExperiments({ workspace_id: scope.workspace_id, format: "jsonl" });
    expect(second).toBe(first);
    expect(lines.trim().split("\n").map((line) => JSON.parse(line))).toEqual(JSON.parse(first));
    expect(JSON.parse(first)[0].calls.map((call: { call_id: string }) => call.call_id)).toEqual(["call-a", "call-b"]);
  });

  it("rejects a missing source lineage and mismatched evaluation identities", async () => {
    const scope = await fixture();
    await expect(createExperiment({ ...scope, source_workspace_id: "missing", pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} })).rejects.toThrow("source workspace");
    const experiment = await createExperiment({ ...scope, pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", call_kind: "need_extract", version_index: 0, input: {}, output: { gaps: [] }, module_version: "v1", route: {} });
    const evaluation = evaluateExperimentVersion({ pack_id: experiment.pack_id, call_kind: "need_extract", output: { gaps: [] } });
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, evaluator_version: "wrong" } as never })).rejects.toThrow("evaluator");
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, pack_id: "beone-tislelizumab-iegp" } })).rejects.toThrow("pack");
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, pack_fingerprint: "wrong" } })).rejects.toThrow("fingerprint");
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, call_kind: "inventory_extract" } })).rejects.toThrow("call kind");
  });

  it("allows exactly one concurrent terminal transition", async () => {
    const scope = await fixture();
    const experiment = await createExperiment({ ...scope, pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    const results = await Promise.allSettled([
      finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "completed" }),
      finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "failed" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("serializes a blocked append before concurrent finalization", async () => {
    const scope = await fixture();
    const experiment = await createExperiment({ ...scope, pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    const lockClient = postgres(process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse", { max: 1 });
    const observerClient = postgres(process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse", { max: 1 });
    const locked = deferred(); const release = deferred();
    const heldLock = lockClient.begin(async (sql) => {
      await sql.unsafe("LOCK TABLE accuracy_experiment_calls IN SHARE ROW EXCLUSIVE MODE");
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    try {
      const append = recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "racing-call", call_kind: "need_extract", version_index: 0, input: {}, output: { gaps: [] }, module_version: "v1", route: {} });
      await waitForBlockedCallInsert(observerClient);
      const finish = finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "completed" });
      let finishSettled = false;
      void finish.finally(() => { finishSettled = true; });
      await new Promise<void>((done) => setImmediate(done));
      expect(finishSettled).toBe(false);
      release.resolve();
      await heldLock;
      await expect(append).resolves.toMatchObject({ call_id: "racing-call" });
      await expect(finish).resolves.toMatchObject({ status: "completed" });
    } finally {
      release.resolve();
      await lockClient.end();
      await observerClient.end();
    }
  });

  it("backfills legacy source organizations and marks deleted sources explicitly", async () => {
    await withAccuracyTransaction(async () => {
      const db = accuracyDb();
      await db.execute(sql.raw("CREATE TEMP TABLE legacy_accuracy_workspaces (id text PRIMARY KEY, org_id text NOT NULL)"));
      await db.execute(sql.raw("CREATE TEMP TABLE legacy_accuracy_experiments (id text PRIMARY KEY, source_workspace_id text NOT NULL)"));
      await db.execute(sql.raw("INSERT INTO legacy_accuracy_workspaces (id, org_id) VALUES ('source-present', 'source-org')"));
      await db.execute(sql.raw("INSERT INTO legacy_accuracy_experiments (id, source_workspace_id) VALUES ('resolved', 'source-present'), ('deleted', 'source-gone')"));
      // Select fixture migrations by target; unrelated additive migrations may be prepended.
      for (const migration of ACCURACY_MIGRATIONS.filter(statement => statement.includes("accuracy_experiments"))) {
        await db.execute(sql.raw(migration.replaceAll("accuracy_experiments", "legacy_accuracy_experiments").replaceAll("accuracy_workspaces", "legacy_accuracy_workspaces")));
      }
      const rows = await db.execute<{ id: string; source_org_id: string }>(sql.raw("SELECT id, source_org_id FROM legacy_accuracy_experiments ORDER BY id"));
      expect(rows).toEqual([{ id: "deleted", source_org_id: "unknown_deleted_source_org_v1" }, { id: "resolved", source_org_id: "source-org" }]);
      const [column] = await db.execute<{ is_nullable: string }>(sql.raw("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'legacy_accuracy_experiments' AND column_name = 'source_org_id'"));
      expect(column?.is_nullable).toBe("NO");
    });
  });
});
