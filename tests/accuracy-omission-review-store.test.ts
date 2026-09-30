/** Database coverage for current source omissions and immutable decisions. */
import { eq } from "drizzle-orm";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { describe, expect, it } from "vitest";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { appendAgentEvent } from "@/accuracy/kernel/agent-events";
import type { SuspectedOmission } from "@/accuracy/modules/completeness-audit/snapshot-inspector";
import { getOmissionReviewsForRun, listBlockingOmissions, listCurrentOmissionReviews, listOmissionActionHistory } from "@/accuracy/store/omission-review-store";
import { newId, nowIso } from "@/modules/kernel/ids";

function issue(source: string, id: string, importance: "important" | "advisory" = "important"): SuspectedOmission {
  return { issue_id: id, item_kind: "gap", summary: id, source_ref: { source_file_id: source, block_id: "same-block" },
    evidence_quote: "Regional comparator evidence", basis: importance === "important" ? "explicit" : "inferred",
    importance, reason: "Absent from draft", suggested_action: "Add gap" };
}
async function fixture() {
  await ensureAccuracySchema();
  return { workspace_id: newId("workspace"), source_file_id: newId("source") };
}
async function run(scope: Awaited<ReturnType<typeof fixture>>, findings: SuspectedOmission[], opts: {
  time?: string; applied?: boolean; input?: object; status?: string; kind?: string; risk?: "important" | "check_failed";
} = {}) {
  const id = newId("run");
  const kind = opts.kind ?? "need_extract";
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, workspace_id: scope.workspace_id, org_id: "test", call_kind: kind,
    agent_role: "proposer", module_id: "test", module_version: "1", status: opts.status ?? "ok", started_at: nowIso(),
    finished_at: opts.time ?? "2026-09-30T10:00:00.000Z", actor_name: "test", actor_function: "test",
    input: opts.input ?? { ...scope, call_kind: kind }, steps: [] });
  await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
    event_type: "critique", iteration: 3, score: null, issues: [], completeness: { risk_level: opts.risk ?? "important",
      checked_block_ids: ["same-block"], unchecked_block_ids: [], suspected_omissions: findings, prior_issue_resolutions: [] },
    latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0,
  } });
  await accuracyDb().insert(t.accuracyExtractionBatches).values({ id: newId("batch"), ...scope,
    requested_kinds: [kind], run_ids: [id], created_claim_ids: [], drafts_persisted: opts.applied ?? true, created_at: nowIso() });
  return id;
}
async function action(scope: Awaited<ReturnType<typeof fixture>>, run_id: string, issue_id: string,
  decision: "add" | "link_existing" | "dismiss" | "reclassify", new_importance: "important" | "advisory" | null = null, time = nowIso()) {
  await accuracyDb().insert(t.accuracyOmissionActions).values({ id: newId("action"), ...scope, run_id, issue_id,
    action: decision, new_importance, reason: "Reviewed source", actor_name: "reviewer", actor_function: "medical_affairs",
    created_at: time, idempotency_key: newId("key"), request_fingerprint: "canonical-fingerprint" });
}

describe("current omission review store", () => {
  it("keeps same-block findings independent and advisory findings visible", async () => {
    const scope = await fixture();
    await run(scope, [issue(scope.source_file_id, "a"), issue(scope.source_file_id, "b"), issue(scope.source_file_id, "c", "advisory")]);
    expect((await listCurrentOmissionReviews(scope.workspace_id)).map((x) => [x.issue.issue_id, x.blocking])).toEqual([["a", true], ["b", true], ["c", false]]);
    expect((await listBlockingOmissions(scope.workspace_id)).map((x) => x.issue.issue_id)).toEqual(["a", "b"]);
  });
  it("supersedes only with fully persisted OK batches and preserves historical actions", async () => {
    const scope = await fixture();
    const old = await run(scope, [issue(scope.source_file_id, "old")]);
    await action(scope, old, "old", "reclassify", "important");
    await run(scope, [], { time: "2026-09-30T11:00:00.000Z", applied: false });
    expect((await listBlockingOmissions(scope.workspace_id))[0].run_id).toBe(old);
    await run(scope, [], { time: "2026-09-30T12:00:00.000Z", status: "error" });
    expect((await listBlockingOmissions(scope.workspace_id))[0].run_id).toBe(old);
    const latest = await run(scope, [], { time: "2026-09-30T13:00:00.000Z" });
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: old }))?.current).toBe(false);
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: latest }))?.current).toBe(true);
    expect(await listOmissionActionHistory({ workspace_id: scope.workspace_id, run_id: old, issue_id: "old" })).toHaveLength(1);
  });
  it("uses terminal critique and retains explicit findings when its check fails", async () => {
    const scope = await fixture();
    const id = await run(scope, [issue(scope.source_file_id, "retained")], { risk: "check_failed" });
    await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: { event_type: "critique", iteration: 0,
      score: 0, issues: [], completeness: { risk_level: "important", checked_block_ids: [], unchecked_block_ids: [],
        suspected_omissions: [issue(scope.source_file_id, "early")], prior_issue_resolutions: [] }, latency_ms: 0,
      token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 } });
    expect((await listBlockingOmissions(scope.workspace_id)).map((x) => x.issue.issue_id)).toEqual(["retained"]);
  });
  it("rejects mismatched persisted scope and keeps workspaces separate", async () => {
    const scope = await fixture(); const other = await fixture();
    await run(other, [issue(other.source_file_id, "other")]);
    await run(scope, [issue(scope.source_file_id, "wrong-input")], { input: { ...other, call_kind: "need_extract" } });
    await run(scope, [issue(other.source_file_id, "wrong-evidence")], { kind: "inventory_extract" });
    expect(await listCurrentOmissionReviews(scope.workspace_id)).toEqual([]);
    expect(await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: "missing" })).toBeNull();
    expect(await listOmissionActionHistory({ workspace_id: scope.workspace_id, run_id: "missing" })).toEqual([]);
  });
  it("selects runs independently by source and kind with deterministic ties", async () => {
    const scope = await fixture();
    const first = await run(scope, [issue(scope.source_file_id, "first")]);
    const second = await run(scope, [issue(scope.source_file_id, "second")]);
    const inventory = await run(scope, [issue(scope.source_file_id, "inventory")], { kind: "inventory_extract" });
    const otherSource = { ...scope, source_file_id: newId("source") };
    const other = await run(otherSource, [issue(otherSource.source_file_id, "other")]);
    const reviews = await listCurrentOmissionReviews(scope.workspace_id);
    expect(reviews.map((x) => x.run_id).sort()).toEqual([first > second ? first : second, inventory, other].sort());
  });
  it("exposes a failed check without inventing blockers and keeps inferred findings advisory", async () => {
    const scope = await fixture();
    const id = await run(scope, [], { risk: "check_failed" });
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id }))?.completeness?.risk_level).toBe("check_failed");
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
    const newer = await run(scope, [issue(scope.source_file_id, "inferred", "advisory")], { time: "2026-09-30T11:00:00.000Z" });
    await action(scope, newer, "inferred", "reclassify", "important");
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
    const other = await fixture();
    expect(await listOmissionActionHistory({ workspace_id: other.workspace_id, run_id: newer })).toEqual([]);
    expect(await getOmissionReviewsForRun({ workspace_id: other.workspace_id, run_id: newer })).toBeNull();
  });
  it("deletes omission history, journals, and batches only for the removed workspace", async () => {
    const org_id = await createOrganization("omission-cleanup");
    const workspace_id = await createWorkspace({ org_id, name: "cleanup", slug: newId("slug") });
    const scope = { workspace_id, source_file_id: newId("source") };
    const id = await run(scope, [issue(scope.source_file_id, "a")]);
    await action(scope, id, "a", "dismiss");
    const batches = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.workspace_id, workspace_id));
    await accuracyDb().insert(t.accuracyResumeJournals).values({ id: newId("journal"), workspace_id, batch_id: batches[0].id,
      merge_operation_id: newId("merge"), status_operation_id: newId("status"), created_at: nowIso(), updated_at: nowIso() });
    const other = await fixture();
    const otherId = await run(other, [issue(other.source_file_id, "other")]);
    await action(other, otherId, "other", "dismiss");
    await deleteWorkspace(workspace_id);
    expect(await accuracyDb().select().from(t.accuracyOmissionActions).where(eq(t.accuracyOmissionActions.workspace_id, workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.workspace_id, workspace_id))).toEqual([]);
    expect(await listOmissionActionHistory({ workspace_id: other.workspace_id, run_id: otherId })).toHaveLength(1);
  });
  it("overlays latest decisions per issue and retains append-only history", async () => {
    const scope = await fixture(); const id = await run(scope, ["a", "b", "c", "d"].map((i) => issue(scope.source_file_id, i)));
    await action(scope, id, "a", "reclassify", "advisory");
    await action(scope, id, "b", "add");
    await action(scope, id, "c", "link_existing");
    await action(scope, id, "d", "dismiss", null, "2026-09-30T10:00:00.000Z");
    await action(scope, id, "d", "reclassify", "important", "2026-09-30T11:00:00.000Z");
    expect((await listBlockingOmissions(scope.workspace_id)).map((x) => x.issue.issue_id)).toEqual(["d"]);
    expect(await listOmissionActionHistory({ workspace_id: scope.workspace_id, run_id: id })).toHaveLength(5);
    expect(await listOmissionActionHistory({ workspace_id: scope.workspace_id, run_id: id, issue_id: "d" })).toHaveLength(2);
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id }))?.items).toHaveLength(4);
  });
});
