/** Database coverage for current source omissions and immutable decisions. */
import { eq } from "drizzle-orm";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { describe, expect, it } from "vitest";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { appendAgentEvent, type AgentCritiqueEvent } from "@/accuracy/kernel/agent-events";
import type { SuspectedOmission } from "@/accuracy/modules/completeness-audit/snapshot-inspector";
import { applyOmissionAction, getOmissionReviewsForRun, listBlockingOmissions, listCurrentOmissionReviews, listOmissionActionHistory } from "@/accuracy/store/omission-review-store";
import { runAccuracyModule, registerAccuracyStack } from "@/accuracy";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { newId, nowIso } from "@/modules/kernel/ids";

function issue(source: string, id: string, importance: "important" | "advisory" = "important"): SuspectedOmission {
  return { issue_id: id, item_kind: "gap", summary: id, source_ref: { source_file_id: source, block_id: `${source}-block` },
    evidence_quote: "Regional comparator evidence", basis: importance === "important" ? "explicit" : "inferred",
    importance, reason: "Absent from draft", suggested_action: "Add gap" };
}
async function fixture() {
  await ensureAccuracySchema();
  return { workspace_id: newId("workspace"), source_file_id: newId("source") };
}
async function run(scope: Awaited<ReturnType<typeof fixture>>, findings: SuspectedOmission[], opts: {
  time?: string; applied?: boolean; input?: object; status?: string; kind?: string; risk?: "important" | "check_failed"; score?: number | null;
} = {}) {
  const id = newId("run");
  const kind = opts.kind ?? "need_extract";
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, workspace_id: scope.workspace_id, org_id: "test", call_kind: kind,
    agent_role: "proposer", module_id: "test", module_version: "1", status: opts.status ?? "ok", started_at: nowIso(),
    finished_at: opts.time ?? "2026-09-30T10:00:00.000Z", actor_name: "test", actor_function: "test",
    input: opts.input ?? { ...scope, call_kind: kind }, steps: [] });
  await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
    event_type: "critique", iteration: 3, score: opts.score === undefined ? 1 : opts.score, issues: [], completeness: { risk_level: opts.risk ?? "important",
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

async function selectEarlier(scope: Awaited<ReturnType<typeof fixture>>, id: string, findings: SuspectedOmission[], options: {
  selected_patch?: Partial<AgentCritiqueEvent["completeness"]>;
  terminal_patch?: Partial<AgentCritiqueEvent["completeness"]>;
  selected_iteration?: number; terminal_score?: number | null;
} = {}) {
  const rows = await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.run_id, id));
  const terminal = rows.find(row => row.event_type === "critique")!;
  const payload = terminal.payload as AgentCritiqueEvent;
  payload.score = options.terminal_score === undefined ? 1 : options.terminal_score;
  payload.completeness = { ...payload.completeness, ...options.terminal_patch };
  await accuracyDb().update(t.accuracyAgentEvents).set({ payload }).where(eq(t.accuracyAgentEvents.id, terminal.id));
  const metering = { latency_ms: 0, cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
    event_type: "critique", iteration: 1, score: 1, issues: [], completeness: {
      risk_level: "important", checked_block_ids: ["same-block"], unchecked_block_ids: [],
      suspected_omissions: findings, prior_issue_resolutions: [], ...options.selected_patch }, ...metering,
  } });
  for (const iteration of [1, 3]) await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
    event_type: "snapshot", iteration, output: { gaps: [] }, evaluation_context: "production",
    signals: { quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }, ...metering,
  } });
  await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
    event_type: "judgment", selected_iteration: options.selected_iteration ?? 1, reason: "Retain source-backed V1", ...metering,
  } });
}

describe("current omission review store", () => {
  it("retains selected and terminal blockers, without borrowing terminal resolutions", async () => {
    const scope = await fixture();
    const id = await run(scope, [issue(scope.source_file_id, "terminal")]);
    await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
      event_type: "critique", iteration: 1, score: 1, issues: [], completeness: {
        risk_level: "important", checked_block_ids: ["same-block"], unchecked_block_ids: [],
        suspected_omissions: [issue(scope.source_file_id, "selected")], prior_issue_resolutions: [] },
      latency_ms: 0, cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } });
    for (const iteration of [1, 3]) await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
      event_type: "snapshot", iteration, output: { gaps: [] }, evaluation_context: "production",
      signals: { quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" },
      latency_ms: 0, cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } });
    const terminal = await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.run_id, id));
    const row = terminal.find(row => row.event_type === "critique" && row.iteration === 3)!;
    const payload = row.payload as { completeness: { prior_issue_resolutions: unknown[] } };
    payload.completeness.prior_issue_resolutions = [{ issue_id: "selected", outcome: "resolved", reason: "Added in V3", matched_item_ref: "gap-3" }];
    await accuracyDb().update(t.accuracyAgentEvents).set({ payload }).where(eq(t.accuracyAgentEvents.id, row.id));
    await appendAgentEvent({ workspace_id: scope.workspace_id, run_id: id, event: {
      event_type: "judgment", selected_iteration: 1, reason: "Earlier source-backed output", latency_ms: 0,
      cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } });
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => row.issue.issue_id).sort()).toEqual(["selected", "terminal"]);
    const review = await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id });
    expect(review).toMatchObject({ selected_iteration: 1, terminal_iteration: 3,
      completeness: { suspected_omissions: [expect.objectContaining({ issue_id: "selected" })] },
      terminal_completeness: { suspected_omissions: [expect.objectContaining({ issue_id: "terminal" })] } });
    await accuracyDb().insert(t.accuracySourceFiles).values({ id: scope.source_file_id, workspace_id: scope.workspace_id, org_id: "test", filename: "test", mime: "text/plain", checksum: "test", doc_role: "medical", uploaded_at: nowIso() });
    await accuracyDb().insert(t.accuracyParseBlocks).values({ id: `${scope.source_file_id}-block`, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, index: 0, kind: "prose", text: "Regional comparator evidence", parser: "local", created_at: nowIso() });
    await applyOmissionAction({ workspace_id: scope.workspace_id, run_id: id, issue_id: "selected", action: "dismiss",
      reason: "Reviewed selected finding", actor: { name: "Reviewer", function: "heor" }, idempotency_key: newId("key") });
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => row.issue.issue_id)).toEqual(["terminal"]);
  });
  it.each(["selected", "terminal"])("keeps a %s-only important blocker visible", async location => {
    const scope = await fixture(); const finding = issue(scope.source_file_id, "only");
    const id = await run(scope, location === "terminal" ? [finding] : []);
    await selectEarlier(scope, id, location === "selected" ? [finding] : []);
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => row.issue.issue_id)).toEqual(["only"]);
  });
  it("cannot downgrade conflicting same-ID evidence or apply a human decision to ambiguous content", async () => {
    const scope = await fixture();
    const id = await run(scope, [issue(scope.source_file_id, "same", "advisory")]);
    await selectEarlier(scope, id, [issue(scope.source_file_id, "same")]);
    // A recorded action on this ID cannot close another conflicting interpretation.
    await action(scope, id, "same", "dismiss");
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => [row.issue.issue_id, row.issue.importance, row.latest_action]))
      .toEqual([["same", "important", null]]);
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id }))?.ambiguous_issue_ids).toEqual(["same"]);
    await expect(applyOmissionAction({ workspace_id: scope.workspace_id, run_id: id, issue_id: "same", action: "dismiss",
      reason: "Cannot bind to ambiguous content", actor: { name: "Reviewer", function: "heor" }, idempotency_key: newId("key") }))
      .rejects.toMatchObject({ status: 409 });
    expect(await listOmissionActionHistory({ workspace_id: scope.workspace_id, run_id: id })).toHaveLength(1);
  });
  it.each(["selected_failed", "terminal_failed", "selected_unchecked", "terminal_unchecked", "terminal_structural_failed", "invalid_judgment"])("does not supersede earlier evidence with %s coverage", async problem => {
    const scope = await fixture();
    const old = await run(scope, [issue(scope.source_file_id, "earlier")]);
    const id = await run(scope, [], { time: "2026-09-30T12:00:00.000Z" });
    await selectEarlier(scope, id, [], {
      selected_patch: problem === "selected_failed" ? { risk_level: "check_failed" }
        : problem === "selected_unchecked" ? { unchecked_block_ids: ["unseen"] } : {},
      terminal_patch: problem === "terminal_failed" ? { risk_level: "check_failed" }
        : problem === "terminal_unchecked" ? { unchecked_block_ids: ["unseen"] } : {},
      terminal_score: problem === "terminal_structural_failed" ? null : 1,
      selected_iteration: problem === "invalid_judgment" ? 99 : 1,
    });
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => row.run_id)).toEqual([old]);
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: old }))?.current).toBe(true);
  });
  it("rejects actions on invalid present judgment while retaining earlier selected findings", async () => {
    const scope = await fixture(); const id = await run(scope, []);
    await selectEarlier(scope, id, [issue(scope.source_file_id, "retained")], { selected_iteration: 99 });
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => row.issue.issue_id)).toEqual(["retained"]);
    expect(await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id })).toMatchObject({ lineage: "invalid", completeness: null });
    await expect(applyOmissionAction({ workspace_id: scope.workspace_id, run_id: id, issue_id: "retained", action: "dismiss",
      reason: "Invalid selection cannot receive approval", actor: { name: "Reviewer", function: "heor" }, idempotency_key: newId("key") }))
      .rejects.toMatchObject({ status: 409 });
  });
  it("does not treat a malformed persisted judgment as absent historical judgment", async () => {
    const scope = await fixture(); const id = await run(scope, []);
    await selectEarlier(scope, id, [issue(scope.source_file_id, "selected-retained")]);
    const events = await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.run_id, id));
    const judgment = events.find(row => row.event_type === "judgment")!;
    await accuracyDb().update(t.accuracyAgentEvents).set({ payload: { event_type: "unreadable", selected_iteration: 1 } })
      .where(eq(t.accuracyAgentEvents.id, judgment.id));
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => row.issue.issue_id)).toEqual(["selected-retained"]);
    expect(await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id })).toMatchObject({ lineage: "invalid", completeness: null });
    await expect(applyOmissionAction({ workspace_id: scope.workspace_id, run_id: id, issue_id: "selected-retained", action: "dismiss",
      reason: "Malformed evidence cannot bind a decision", actor: { name: "Reviewer", function: "heor" }, idempotency_key: newId("key") }))
      .rejects.toMatchObject({ status: 409 });
  });
  it("pauses downstream on invalid selected lineage even without fabricated omission findings", async () => {
    const scope = await fixture(); const id = await run(scope, []);
    await selectEarlier(scope, id, [], { selected_iteration: 99 });
    await expect(assertAccuracyCanProgress(scope.workspace_id, "merge_dedupe")).rejects.toMatchObject({
      invalid_lineage_run_ids: [id], blockers: [],
    });
    await expect(assertAccuracyCanProgress(scope.workspace_id, "need_extract")).resolves.toBeUndefined();
  });
  it("keeps same-block findings independent and advisory findings visible", async () => {
    const scope = await fixture();
    await run(scope, [issue(scope.source_file_id, "a"), issue(scope.source_file_id, "b"), issue(scope.source_file_id, "c", "advisory")]);
    expect((await listCurrentOmissionReviews(scope.workspace_id)).map((x) => [x.issue.issue_id, x.blocking])).toEqual([["a", true], ["b", true], ["c", false]]);
    expect((await listBlockingOmissions(scope.workspace_id)).map((x) => x.issue.issue_id)).toEqual(["a", "b"]);
  });
  it("retains earlier blockers when legacy null-score terminal coverage has a complete checked scope", async () => {
    const scope = await fixture();
    const old = await run(scope, [issue(scope.source_file_id, "earlier")]);
    const later = await run(scope, [], { time: "2026-09-30T12:00:00.000Z", score: null });
    expect((await listBlockingOmissions(scope.workspace_id)).map(row => row.run_id)).toEqual([old]);
    expect(await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: old })).toMatchObject({ current: true });
    expect(await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: later })).toMatchObject({
      lineage: "legacy_terminal", selected_iteration: null, terminal_iteration: 3,
      completeness: { checked_block_ids: ["same-block"], unchecked_block_ids: [] }, items: [],
    });
  });
  it("keeps historical null-score terminal findings readable and actionable without a judgment", async () => {
    const scope = await fixture();
    const id = await run(scope, [issue(scope.source_file_id, "legacy")], { score: null });
    expect(await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id })).toMatchObject({
      current: true, lineage: "legacy_terminal", selected_iteration: null, terminal_iteration: 3,
      items: [expect.objectContaining({ issue: expect.objectContaining({ issue_id: "legacy" }), actionable: true, blocking: true })],
    });
    await accuracyDb().insert(t.accuracySourceFiles).values({ id: scope.source_file_id, workspace_id: scope.workspace_id, org_id: "test", filename: "test", mime: "text/plain", checksum: "test", doc_role: "medical", uploaded_at: nowIso() });
    await accuracyDb().insert(t.accuracyParseBlocks).values({ id: `${scope.source_file_id}-block`, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, index: 0, kind: "prose", text: "Regional comparator evidence", parser: "local", created_at: nowIso() });
    await applyOmissionAction({ workspace_id: scope.workspace_id, run_id: id, issue_id: "legacy", action: "dismiss",
      reason: "Reviewed historical finding", actor: { name: "Reviewer", function: "heor" }, idempotency_key: newId("key") });
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
    expect(await listOmissionActionHistory({ workspace_id: scope.workspace_id, run_id: id })).toMatchObject([{ issue_id: "legacy", action: "dismiss" }]);
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
  it("does not let a legacy failed completeness check supersede earlier unresolved findings", async () => {
    const scope = await fixture();
    const original = await run(scope, [issue(scope.source_file_id, "unresolved")]);
    await run(scope, [], { risk: "check_failed" });
    expect((await listBlockingOmissions(scope.workspace_id)).map(item => item.run_id)).toEqual([original]);
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: original }))?.current).toBe(true);
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
  it("keeps inferred findings advisory by default and enforces human importance until closed", async () => {
    const org_id = await createOrganization("Reclassification");
    const workspace_id = await createWorkspace({ org_id, name: "Review", slug: newId("slug") });
    const scope = { workspace_id, source_file_id: newId("source") };
    const id = await run(scope, [], { risk: "check_failed" });
    expect((await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: id }))?.completeness?.risk_level).toBe("check_failed");
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
    const newer = await run(scope, [issue(scope.source_file_id, "inferred", "advisory")], { time: "2026-09-30T11:00:00.000Z" });
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
    await accuracyDb().insert(t.accuracySourceFiles).values({ id: scope.source_file_id, workspace_id: scope.workspace_id, org_id: "test", filename: "test", mime: "text/plain", checksum: "test", doc_role: "medical", uploaded_at: nowIso() });
    await accuracyDb().insert(t.accuracyParseBlocks).values({ id: `${scope.source_file_id}-block`, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, index: 0, kind: "prose", text: "Regional comparator evidence", parser: "local", created_at: nowIso() });
    const decision = { workspace_id: scope.workspace_id, run_id: newer, issue_id: "inferred", reason: "Human review", actor: { name: "Reviewer", function: "heor" as const } };
    await applyOmissionAction({ ...decision, action: "reclassify", new_importance: "important", idempotency_key: newId("key") });
    expect(await listBlockingOmissions(scope.workspace_id)).toHaveLength(1);
    registerAccuracyStack();
    await expect(runAccuracyModule({ call_kind: "merge_dedupe", agent_role: "none", input: { workspace_id: scope.workspace_id }, workspace_id: scope.workspace_id, org_id, actor: decision.actor })).rejects.toBeInstanceOf(AccuracyPausedError);
    await applyOmissionAction({ ...decision, action: "dismiss", idempotency_key: newId("key") });
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
