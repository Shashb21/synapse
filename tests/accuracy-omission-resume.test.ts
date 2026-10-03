/** Behavioral extraction and durable resume checks against the real database. */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { GET as omissionGet } from "@/app/api/accuracy/omissions/route";
import { POST } from "@/app/api/accuracy/extract/route";
import { registerAccuracyStack } from "@/accuracy";
import { activateAccuracyModule, activeAccuracyModuleId, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import { needExtractOutputSchema } from "@/accuracy/modules/need-extract/module";
import { appendAgentEvent } from "@/accuracy/kernel/agent-events";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { applyOmissionAction, listBlockingOmissions } from "@/accuracy/store/omission-review-store";
import * as historyStore from "@/accuracy/store/item-history-store";
import * as claimStore from "@/accuracy/store/claim-store";
import { getClaim, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { CallKind } from "@/accuracy/kernel/contracts";

const identity = vi.hoisted(() => ({ signed_in: true, demo: false, role: "contributor", actor: { name: "Test", function: "heor" } }));
vi.mock("@/modules/auth/request", () => ({ requestIdentity: async () => identity }));

// Concurrent HTTP requests need separate connections, as in the normal server pool.
beforeAll(() => vi.stubEnv("VITEST", ""));
afterAll(() => vi.unstubAllEnvs());
const originals = new Map<CallKind, string>();
afterEach(() => {
  for (const [call_kind, module_id] of originals) activateAccuracyModule({ call_kind, module_id, activated_by: "restore" });
  originals.clear();
  Object.assign(identity, { signed_in: true, demo: false, role: "contributor" });
  vi.restoreAllMocks();
});
async function fixture() {
  registerAccuracyStack(); await ensureAccuracySchema();
  const org_id = await createOrganization(newId("org-label"));
  const workspace_id = await createWorkspace({ org_id, name: "Resume", slug: newId("slug") });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "notes.txt", mime: "text/plain", checksum: newId("sum"), doc_role: "medical" });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Comparator evidence missing" }] });
  return { workspace_id, org_id, source_file_id: source.id, block_id };
}
function post(body: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/accuracy/extract", { method: "POST", body: JSON.stringify(body) }));
}
function installExtractor(blocker = true, gap_id: string | string[] = newId("gap")) {
  const call_kind = "need_extract";
  originals.set(call_kind, originals.get(call_kind) ?? activeAccuracyModuleId(call_kind)!);
  const id = newId("extract-test");
  registerAccuracyModule(mechanicalModule({ id, call_kind, title: "Test", summary: "Test", inputSchema: z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()) }), outputSchema: needExtractOutputSchema,
    run: async (input, ctx) => {
      if (blocker) await appendAgentEvent({ workspace_id: input.workspace_id, run_id: ctx.run.id, event: { event_type: "critique", iteration: 3, score: null, issues: [], completeness: { risk_level: "important", checked_block_ids: input.block_ids, unchecked_block_ids: [], prior_issue_resolutions: [], suspected_omissions: [{ issue_id: "missing", item_kind: "gap", summary: "Comparator need", source_ref: { source_file_id: input.source_file_id, block_id: input.block_ids[0] }, evidence_quote: "Comparator evidence missing", basis: "explicit", importance: "important", reason: "Absent", suggested_action: "Add" }] }, latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 } });
      return { output: { workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: (Array.isArray(gap_id) ? gap_id : [gap_id]).map(id => ({ id, statement: "Existing extracted need", external_id: null, provenance: [{ source_file_id: input.source_file_id, block_id: input.block_ids[0], quote: "Comparator evidence missing" }] })) }, summary: "Extracted" };
    } }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "test" });
}
async function paused(scope: Awaited<ReturnType<typeof fixture>>) {
  installExtractor();
  const response = await post({ ...scope, kinds: ["need"] });
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body).toMatchObject({ ok: false, paused: true, extraction_batch_id: expect.any(String), gaps_inserted: 1, tactics_inserted: 0, runs: [expect.objectContaining({ call_kind: "need_extract" })] });
  return body;
}
async function resolve(scope: Awaited<ReturnType<typeof fixture>>, body: { runs: { run_id: string }[] }) {
  await applyOmissionAction({ workspace_id: scope.workspace_id, run_id: body.runs[0].run_id, issue_id: "missing", action: "dismiss", reason: "Evidence reviewed", idempotency_key: newId("decision"), actor: { name: "Reviewer", function: "medical_affairs" } });
}
const runs = (workspace_id: string) => accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, workspace_id));

describe("extraction omission resume", () => {
  it("pauses a fully applied batch and resumes without extraction or duplicate drafts; replay is identical", async () => {
    const scope = await fixture(); const body = await paused(scope);
    const read = await omissionGet(new Request(`http://localhost/api/accuracy/omissions?workspace_id=${scope.workspace_id}&run_id=${body.runs[0].run_id}`));
    expect(await read.json()).toMatchObject({ extraction_batch_id: body.extraction_batch_id, source_file_id: scope.source_file_id });
    const wrongWorkspace = await fixture();
    expect((await omissionGet(new Request(`http://localhost/api/accuracy/omissions?workspace_id=${wrongWorkspace.workspace_id}&run_id=${body.runs[0].run_id}`))).status).toBe(404);
    expect((await runs(scope.workspace_id)).map(r => r.call_kind)).toEqual(["need_extract"]);
    const request = { ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "resume-1" };
    expect((await post(request)).status).toBe(409);
    await resolve(scope, body);
    const response = await post(request); expect(response.status).toBe(200);
    const completed = await response.json();
    expect(completed.runs.map((r: { call_kind: string }) => r.call_kind)).toEqual(["need_extract", "merge_dedupe", "status_derive"]);
    expect(await listClaims(scope.workspace_id)).toHaveLength(1);
    expect(await (await post({ ...request, idempotency_key: "resume-2" })).json()).toEqual(completed);
    expect(await runs(scope.workspace_id)).toHaveLength(3);
  });
  it("replays initial success without repeating downstream work", async () => {
    const scope = await fixture(); installExtractor(false);
    const initial = await (await post({ ...scope, kinds: ["need"] })).json();
    const review = await (await omissionGet(new Request(`http://localhost/api/accuracy/omissions?workspace_id=${scope.workspace_id}&run_id=${initial.runs[0].run_id}`))).json();
    const before = await runs(scope.workspace_id);
    const replay = await post({ ...scope, action: "resume", extraction_batch_id: review.extraction_batch_id, idempotency_key: "repeat" });
    expect(await replay.json()).toEqual(initial);
    expect(await runs(scope.workspace_id)).toEqual(before);
    expect(review).toMatchObject({ downstream_state: "completed" });
  });
  it.each([{ signed_in: false, role: "contributor", status: 401 }, { signed_in: true, role: "viewer", status: 403 }])("rejects unauthorized resume and completed replay: $status", async ({ signed_in, role, status }) => {
    const scope = await fixture(); const body = await paused(scope); await resolve(scope, body);
    const request = { ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "auth" };
    const before = await runs(scope.workspace_id);
    const claims = await listClaims(scope.workspace_id);
    const journals = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, scope.workspace_id));
    Object.assign(identity, { signed_in, role });
    expect((await post(request)).status).toBe(status);
    expect(await runs(scope.workspace_id)).toEqual(before);
    expect(await listClaims(scope.workspace_id)).toEqual(claims);
    expect(await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, scope.workspace_id))).toEqual(journals);
    Object.assign(identity, { signed_in: true, role: "contributor" });
    expect((await post(request)).status).toBe(200);
    expect((await runs(scope.workspace_id)).filter(run => run.call_kind !== "need_extract").every(run => run.actor_name === "Test" && run.actor_function === "heor")).toBe(true);
    Object.assign(identity, { signed_in, role });
    expect((await post(request)).status).toBe(status);
  });
  it("preserves unsigned demo-mode resume", async () => {
    const scope = await fixture(); const body = await paused(scope); await resolve(scope, body);
    Object.assign(identity, { signed_in: false, demo: true });
    expect((await post({ ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "demo" })).status).toBe(200);
  });
  it("returns the server source and batch even when an applied run has no findings", async () => {
    const scope = await fixture(); installExtractor(false);
    const body = await (await post({ ...scope, kinds: ["need"] })).json();
    const response = await omissionGet(new Request(`http://localhost/api/accuracy/omissions?workspace_id=${scope.workspace_id}&run_id=${body.runs[0].run_id}`));
    expect(response.status).toBe(200);
    const runBatch = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.workspace_id, scope.workspace_id));
    expect(await response.json()).toMatchObject({ items: [], actions: [], source_file_id: scope.source_file_id,
      extraction_batch_id: runBatch[0].id });
  });
  it("rejects mismatched and superseded batches", async () => {
    const scope = await fixture(); const body = await paused(scope);
    const other = await fixture();
    const mismatched = await post({ ...other, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "bad" });
    expect(mismatched.status).toBe(409); expect(await mismatched.json()).toMatchObject({ code: "stale_batch" });
    installExtractor(false);
    expect((await post({ ...scope, kinds: ["need"] })).status).toBe(200);
    const stale = await post({ ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "stale" });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "stale_batch" });
  });
  it("does not supersede a blocker when a successful extraction's draft cannot persist", async () => {
    const scope = await fixture(); const body = await paused(scope);
    const claims = await listClaims(scope.workspace_id); installExtractor(false);
    vi.spyOn(historyStore, "publishGeneratedItemHistory").mockRejectedValueOnce(new Error("Injected history write failure"));
    expect((await post({ ...scope, kinds: ["need"] })).status).toBe(400);
    expect(await listClaims(scope.workspace_id)).toEqual(claims);
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([expect.objectContaining({ run_id: body.runs[0].run_id })]);
  });
  it("rolls back an interrupted stage's mutations and retries using its reserved run identity", async () => {
    const scope = await fixture(); const body = await paused(scope); await resolve(scope, body);
    const kind = "merge_dedupe"; originals.set(kind, activeAccuracyModuleId(kind)!);
    const id = newId("failing-merge"); let fail = true;
    registerAccuracyModule(mechanicalModule({ id, call_kind: kind, title: "Failure", summary: "Failure", inputSchema: z.object({ workspace_id: z.string() }), outputSchema: z.object({ merged: z.number() }), run: async input => {
      await insertClaim({ workspace_id: input.workspace_id, claim_type: "gap", statement: "Stage mutation" });
      if (fail) throw new Error("simulated interruption");
      return { output: { merged: 0 }, summary: "Recovered" };
    } })); activateAccuracyModule({ call_kind: kind, module_id: id, activated_by: "test" });
    const request = { ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "retry" };
    expect((await post(request)).status).toBe(400);
    expect(await listClaims(scope.workspace_id)).toHaveLength(1);
    const journal = (await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, scope.workspace_id)))[0];
    expect(journal.merge_state).toBe("reserved");
    fail = false; const response = await post(request); expect(response.status).toBe(200);
    expect((await response.json()).runs[1].run_id).toBe(journal.merge_operation_id);
    expect(await listClaims(scope.workspace_id)).toHaveLength(2);
    expect(await runs(scope.workspace_id)).toHaveLength(3);
  });
  it("rejects an earlier need batch when a later inventory-only batch applies", async () => {
    const scope = await fixture(); const body = await paused(scope);
    const inventory = await post({ ...scope, kinds: ["inventory"] });
    expect(inventory.status).toBe(409);
    const latest = await inventory.json();
    expect(latest.extraction_batch_id).not.toBe(body.extraction_batch_id);
    const oldReview = await (await omissionGet(new Request(`http://localhost/api/accuracy/omissions?workspace_id=${scope.workspace_id}&run_id=${body.runs[0].run_id}`))).json();
    expect(oldReview).toMatchObject({ current: true, downstream_state: "stale" });
    const stale = await post({ ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "changed-set" });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "stale_batch" });
    await resolve(scope, body);
    expect((await post({ ...scope, action: "resume", extraction_batch_id: latest.extraction_batch_id, idempotency_key: "latest" })).status).toBe(200);
  });
  it("rolls back a real merge interrupted after the duplicate patch, then recovers both claims", async () => {
    const scope = await fixture(); const body = await paused(scope); await resolve(scope, body);
    // Legacy duplicates still exercise real merge rollback; generated histories need an explicit identity decision.
    const legacy = await insertClaim({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Legacy need awaiting review", source_file_id: scope.source_file_id });
    const duplicate = await insertClaim({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Legacy need awaiting review", source_file_id: scope.source_file_id });
    const before = await listClaims(scope.workspace_id);
    const originalPatch = claimStore.persistClaimPatch;
    let writes = 0;
    const failure = vi.spyOn(claimStore, "persistClaimPatch").mockImplementation(async args => {
      writes++;
      if (writes === 2) throw new Error("interrupted real merge after duplicate write");
      return originalPatch(args);
    });
    const request = { ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "real-merge-retry" };
    expect((await post(request)).status).toBe(400);
    expect(writes).toBe(2);
    expect(await listClaims(scope.workspace_id)).toEqual(before);
    expect(await runs(scope.workspace_id)).toHaveLength(1);
    const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, scope.workspace_id));
    failure.mockRestore();
    const completed = await post(request); expect(completed.status).toBe(200);
    expect((await completed.json()).runs[1].run_id).toBe(journal.merge_operation_id);
    expect((await getClaim(scope.workspace_id, duplicate.id))?.status).toBe("merged");
    expect((await getClaim(scope.workspace_id, legacy.id))?.status).not.toBe("merged");
    const generated = before.find(row => row.id !== legacy.id && row.id !== duplicate.id)!;
    expect((await getClaim(scope.workspace_id, generated.id))?.status).not.toBe("merged");
  });

  it("serializes initial downstream work against an explicit resume", async () => {
    const scope = await fixture(); installExtractor(false);
    const kind = "merge_dedupe"; originals.set(kind, activeAccuracyModuleId(kind)!);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const id = newId("held-merge");
    registerAccuracyModule(mechanicalModule({ id, call_kind: kind, title: "Held", summary: "Held", inputSchema: z.object({ workspace_id: z.string() }), outputSchema: z.object({ merged: z.number() }), run: async () => {
      entered(); await hold; return { output: { merged: 0 }, summary: "Once" };
    } })); activateAccuracyModule({ call_kind: kind, module_id: id, activated_by: "test" });
    const initial = post({ ...scope, kinds: ["need"] });
    await started;
    const [batch] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.workspace_id, scope.workspace_id));
    const request = { ...scope, action: "resume", extraction_batch_id: batch.id, idempotency_key: "overlap" };
    try {
      const overlapping = await post(request);
      expect(overlapping.status).toBe(409); expect(await overlapping.json()).toMatchObject({ code: "resume_in_progress" });
    } finally { release(); }
    const completed = await (await initial).json();
    expect(await (await post(request)).json()).toEqual(completed);
    expect(await runs(scope.workspace_id)).toHaveLength(3);
  });
  it("returns resume_in_progress while another transaction holds the workspace lock", async () => {
    const scope = await fixture(); const body = await paused(scope); await resolve(scope, body);
    const connection = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await connection`begin`;
      await connection`select pg_advisory_xact_lock(hashtextextended(${`omission:${scope.workspace_id}`}, 0))`;
      const response = await post({ ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "concurrent" });
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "resume_in_progress" });
      expect(await runs(scope.workspace_id)).toHaveLength(1);
    } finally { await connection`rollback`; await connection.end(); }
  });
  it("recovers a completed reserved module run instead of repeating its downstream effects", async () => {
    const scope = await fixture(); const body = await paused(scope); await resolve(scope, body);
    const merge_id = newId("arun"); const status_id = newId("arun");
    await accuracyDb().delete(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, scope.workspace_id));
    await accuracyDb().insert(t.accuracyResumeJournals).values({ id: newId("resume"), workspace_id: scope.workspace_id,
      batch_id: body.extraction_batch_id, merge_operation_id: merge_id, merge_state: "reserved", status_operation_id: status_id,
      status_state: "reserved", created_at: nowIso(), updated_at: nowIso() });
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: merge_id, workspace_id: scope.workspace_id, org_id: scope.org_id,
      call_kind: "merge_dedupe", module_id: "merge-dedupe.local-v1", module_version: "0.1.0", agent_role: "none", status: "ok",
      actor_name: "Accuracy extractor", actor_function: "medical_affairs", started_at: nowIso(), finished_at: nowIso(),
      input: { workspace_id: scope.workspace_id }, output: { workspace_id: scope.workspace_id, merged: 5, survivors: 1, contradictions: 0, merges: [], contradiction_rows: [] }, summary: "Stored completed merge", steps: [] });
    const response = await post({ ...scope, action: "resume", extraction_batch_id: body.extraction_batch_id, idempotency_key: "recover" });
    expect(response.status).toBe(200); const result = await response.json();
    expect(result.merge.merged).toBe(5); expect(result.runs[1]).toMatchObject({ run_id: merge_id, summary: "Stored completed merge" });
    expect(result.runs[2].run_id).toBe(status_id); expect(await runs(scope.workspace_id)).toHaveLength(3);
  });

  it("preserves the applied extraction context when status pauses after merge publishes another source blocker", async () => {
    const scope = await fixture();
    const otherSource = await insertSourceFile({ workspace_id: scope.workspace_id, org_id: scope.org_id,
      filename: "other-notes.txt", mime: "text/plain", checksum: newId("sum"), doc_role: "medical" });
    const otherBlock = newId("block");
    await persistParseBlocks({ workspace_id: scope.workspace_id, source_file_id: otherSource.id, parser: "local",
      blocks: [{ id: otherBlock, source_file_id: otherSource.id, index: 0, kind: "prose", heading: null, text: "Comparator evidence missing" }] });
    installExtractor(false);
    const kind = "merge_dedupe";
    originals.set(kind, activeAccuracyModuleId(kind)!);
    const id = newId("late-blocker-merge");
    registerAccuracyModule(mechanicalModule({ id, call_kind: kind, title: "Publish blocker", summary: "Publish blocker",
      inputSchema: z.object({ workspace_id: z.string() }), outputSchema: z.object({ merged: z.number() }),
      run: async () => {
        // The first request's preflight has passed and its merge is already running.
        installExtractor(true);
        const otherResponse = await post({ workspace_id: scope.workspace_id, source_file_id: otherSource.id, kinds: ["need"] });
        expect(otherResponse.status).toBe(409);
        return { output: { merged: 0 }, summary: "Merge completed before the new blocker" };
      } }));
    activateAccuracyModule({ call_kind: kind, module_id: id, activated_by: "test" });

    const response = await post({ ...scope, kinds: ["need"] });
    expect(response.status).toBe(409);
    const body = await response.json();
    const [batch] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.source_file_id, scope.source_file_id));
    expect(body).toMatchObject({ ok: false, paused: true, extraction_batch_id: batch.id, gaps_inserted: 1, tactics_inserted: 0,
      runs: [expect.objectContaining({ call_kind: "need_extract", run_id: batch.run_ids[0], count: 1 })],
      blockers: [expect.objectContaining({ source_file_id: otherSource.id, workspace_id: scope.workspace_id })] });
    expect(batch.drafts_persisted).toBe(true);
    const persistedRuns = await runs(scope.workspace_id);
    expect(persistedRuns.filter(run => run.call_kind === "need_extract")).toHaveLength(2);
    expect(persistedRuns.filter(run => run.call_kind === "merge_dedupe")).toHaveLength(1);
    expect(persistedRuns.filter(run => run.call_kind === "status_derive")).toHaveLength(0);
    expect(await listClaims(scope.workspace_id)).toHaveLength(2);
    const [checkpoint] = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.batch_id, batch.id));
    expect(checkpoint).toMatchObject({ merge_state: "completed", status_state: "reserved", final_response: null });
    const blocker = (await listBlockingOmissions(scope.workspace_id))[0];
    await applyOmissionAction({ workspace_id: scope.workspace_id, run_id: blocker.run_id, issue_id: "missing", action: "dismiss", reason: "Reviewed", idempotency_key: newId("decision"), actor: identity.actor as { name: string; function: "heor" } });
    const completed = await post({ ...scope, action: "resume", extraction_batch_id: batch.id, idempotency_key: "late" });
    expect(completed.status).toBe(200);
    expect((await completed.json()).runs[1].run_id).toBe(persistedRuns.find(run => run.call_kind === "merge_dedupe")!.id);
    expect((await runs(scope.workspace_id)).filter(run => run.call_kind === "merge_dedupe")).toHaveLength(1);
  });

});
