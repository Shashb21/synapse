/** Contributor decisions exercise the real Postgres ledger and API trust boundary. */
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import * as store from "@/accuracy/store/omission-review-store";
import { appendAgentEvent } from "@/accuracy/kernel/agent-events";
import { insertClaim } from "@/accuracy/store/claim-store";
import type { SuspectedOmission } from "@/accuracy/modules/completeness-audit/snapshot-inspector";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { RequestIdentity } from "@/modules/auth/request";

const { identity, closePool } = vi.hoisted(() => ({ identity: vi.fn(), closePool: vi.fn() }));
// Keep real SQL and transactions, but permit concurrent transactions in this file.
vi.mock("@/accuracy/store/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/accuracy/store/db")>();
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL!, { max: 2, connection: { application_name: "kan33-omission-actions-test" } });
  const database = drizzle(client);
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { ...actual, accuracyDb: () => database };
});
afterAll(() => closePool());
vi.mock("@/modules/auth/request", () => ({ requestIdentity: identity }));
const actor = { name: "Signed contributor", function: "medical_affairs" as const };
beforeEach(() => identity.mockResolvedValue({ actor, role: "contributor", signed_in: true, demo: false } satisfies RequestIdentity));

async function fixture(opts: { summary?: string; kind?: "gap" | "tactic"; quote?: string; pack?: string } = {}) {
  await ensureAccuracySchema();
  const workspace_id = newId("ws"); const source_file_id = newId("source"); const block_id = newId("block");
  const run_id = newId("run"); const issue_id = newId("issue");
  const issue: SuspectedOmission = { issue_id, item_kind: opts.kind ?? "gap", summary: opts.summary ?? "Regional comparator evidence is missing",
    source_ref: { source_file_id, block_id }, evidence_quote: opts.quote ?? "Regional comparator evidence", basis: "explicit",
    importance: "important", reason: "Absent from drafts", suggested_action: "Add source-backed item" };
  await accuracyDb().insert(t.accuracySourceFiles).values({ id: source_file_id, workspace_id, org_id: "test", filename: "source.txt",
    mime: "text/plain", checksum: "test", uploaded_at: nowIso(), reference_pack_id: opts.pack ?? null });
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id, index: 0, kind: "paragraph",
    text: "Regional comparator evidence is missing. More distinct outcomes need evidence.", parser: "test", created_at: nowIso() });
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, workspace_id, org_id: "test", call_kind: "need_extract",
    agent_role: "proposer", module_id: "test", module_version: "1", status: "ok", started_at: nowIso(), finished_at: nowIso(),
    actor_name: "model", actor_function: "medical_affairs", input: { workspace_id, source_file_id }, steps: [] });
  await appendAgentEvent({ workspace_id, run_id, event: { event_type: "critique", iteration: 3, score: null, issues: [],
    completeness: { risk_level: "important", checked_block_ids: [block_id], unchecked_block_ids: [], suspected_omissions: [issue], prior_issue_resolutions: [] },
    latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 } });
  await accuracyDb().insert(t.accuracyExtractionBatches).values({ id: newId("batch"), workspace_id, source_file_id,
    requested_kinds: ["need_extract"], run_ids: [run_id], created_claim_ids: [], drafts_persisted: true, created_at: nowIso() });
  return { workspace_id, source_file_id, block_id, run_id, issue_id, issue };
}
function request(f: Awaited<ReturnType<typeof fixture>>) {
  return { workspace_id: f.workspace_id, run_id: f.run_id, issue_id: f.issue_id, action: "add" as const,
    reason: "Reviewed original source", actor, idempotency_key: newId("key") };
}
async function claims(f: Awaited<ReturnType<typeof fixture>>) {
  return accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, f.workspace_id));
}
async function candidate(f: Awaited<ReturnType<typeof fixture>>, opts: { statement?: string; kind?: "gap" | "tactic"; status?: string; metadata?: Record<string, unknown>; workspace_id?: string } = {}) {
  return insertClaim({ workspace_id: opts.workspace_id ?? f.workspace_id, claim_type: opts.kind ?? f.issue.item_kind,
    source_file_id: f.source_file_id, statement: opts.statement ?? f.issue.summary, status: opts.status,
    metadata: { provenance: [{ ...f.issue.source_ref, quote: f.issue.evidence_quote }], ...opts.metadata } });
}
async function post(body: unknown) {
  const { POST } = await import("@/app/api/accuracy/omissions/route");
  return POST(new Request("http://localhost/api/accuracy/omissions", { method: "POST", body: JSON.stringify(body) }));
}

describe("atomic omission decisions", () => {
  it("adds one draft with canonical provenance and contributor-authored statement, then replays without duplication", async () => {
    const f = await fixture(); const args = { ...request(f), statement: "Contributor clarified regional evidence" };
    const result = await store.applyOmissionAction(args);
    expect(await store.applyOmissionAction(args)).toEqual(result);
    const rows = await claims(f); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.claim_id, statement: args.statement, status: "draft", validated: false,
      metadata: { provenance: [{ ...f.issue.source_ref, quote: f.issue.evidence_quote }], origin: "contributor" } });
    expect(result.contributor_statement).toBe(args.statement);
    expect(JSON.parse(result.request_fingerprint)).toMatchObject({ statement: args.statement });
    expect(await store.listBlockingOmissions(f.workspace_id)).toEqual([]);
    await expect(store.applyOmissionAction({ ...args, statement: "changed" })).rejects.toMatchObject({ status: 409 });
  });
  it("links one span only once and preserves existing claim wording", async () => {
    const f = await fixture(); const c = await candidate(f); const args = { ...request(f), action: "link_existing" as const, claim_id: c.id };
    const result = await store.applyOmissionAction(args); expect(result.claim_id).toBe(c.id);
    expect((await claims(f))[0]).toMatchObject({ statement: c.statement, metadata: { provenance: [{ ...f.issue.source_ref, quote: f.issue.evidence_quote }] } });
    expect(await store.applyOmissionAction(args)).toEqual(result);
  });
  it("dismisses with a reason and prevents a later overwrite", async () => {
    const f = await fixture(); await store.applyOmissionAction({ ...request(f), action: "dismiss" });
    expect(await claims(f)).toEqual([]); expect(await store.listBlockingOmissions(f.workspace_id)).toEqual([]);
    await expect(store.applyOmissionAction(request(f))).rejects.toMatchObject({ status: 409 });
  });
  it("keeps important reclassification open and advisory reclassification closes it", async () => {
    const f = await fixture(); await store.applyOmissionAction({ ...request(f), action: "reclassify", new_importance: "important" });
    expect(await store.listBlockingOmissions(f.workspace_id)).toHaveLength(1);
    await store.applyOmissionAction({ ...request(f), action: "reclassify", new_importance: "advisory" });
    expect(await store.listBlockingOmissions(f.workspace_id)).toEqual([]);
    await expect(store.applyOmissionAction(request(f))).rejects.toMatchObject({ status: 409 });
  });
  it.each(["workspace_id", "run_id", "issue_id"] as const)("rejects a mismatched %s", async (field) => {
    const f = await fixture(); await expect(store.applyOmissionAction({ ...request(f), [field]: "wrong" })).rejects.toMatchObject({ status: 404 });
    expect(await claims(f)).toEqual([]);
  });
  it("rejects an invalid source quote and rolls back all writes", async () => {
    const f = await fixture({ quote: "Fabricated evidence" });
    await expect(store.applyOmissionAction(request(f))).rejects.toMatchObject({ status: 409 });
    expect(await claims(f)).toEqual([]); expect(await store.listOmissionActionHistory(f)).toEqual([]);
  });
  it("allows source-valid retained findings after a failed terminal completeness check", async () => {
    const f = await fixture();
    await appendAgentEvent({ workspace_id: f.workspace_id, run_id: f.run_id, event: { event_type: "critique", iteration: 4,
      score: null, issues: [], completeness: { risk_level: "check_failed", checked_block_ids: [], unchecked_block_ids: [f.block_id],
        suspected_omissions: [f.issue], prior_issue_resolutions: [] }, latency_ms: 0,
      token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 } });
    await store.applyOmissionAction({ ...request(f), action: "dismiss" });
    expect(await store.listBlockingOmissions(f.workspace_id)).toEqual([]);
  });
  it("requires a nonblank reason", async () => {
    const f = await fixture(); await expect(store.applyOmissionAction({ ...request(f), reason: " " })).rejects.toMatchObject({ status: 400 });
  });
  it.each([{ kind: "tactic" as const }, { status: "rejected" }, { status: "merged" }, { workspace_id: "other" }])("rejects an ineligible linked claim %j", async (opts) => {
    const f = await fixture(); const c = await candidate(f, opts);
    await expect(store.applyOmissionAction({ ...request(f), action: "link_existing", claim_id: c.id })).rejects.toMatchObject({ status: opts.workspace_id ? 404 : 409 });
    expect(await store.listOmissionActionHistory(f)).toEqual([]);
  });
  it("requires linking an exact duplicate and ignores rejected equivalent claims", async () => {
    const f = await fixture(); await candidate(f);
    await expect(store.applyOmissionAction({ ...request(f), confirmed_distinct: true })).rejects.toMatchObject({ status: 409 });
    const inactive = await fixture(); await candidate(inactive, { status: "rejected" });
    await store.applyOmissionAction(request(inactive)); expect(await claims(inactive)).toHaveLength(2);
  });
  it("requires confirmation for ambiguous same-block text", async () => {
    const f = await fixture(); await candidate(f, { statement: "Regional comparator evidence is incomplete" });
    await expect(store.applyOmissionAction(request(f))).rejects.toMatchObject({ status: 409 });
    await store.applyOmissionAction({ ...request(f), confirmed_distinct: true }); expect(await claims(f)).toHaveLength(2);
  });
  it("reuses strong identities and high same-block lexical overlap", async () => {
    const strong = await fixture({ summary: "NCT12345678 regional evidence" }); await candidate(strong, { statement: "Study NCT12345678 comparator outcomes" });
    await expect(store.applyOmissionAction(request(strong))).rejects.toMatchObject({ status: 409 });
    const lexical = await fixture({ summary: "regional comparator evidence outcomes population intervention treatment control safety efficacy" });
    await candidate(lexical, { statement: "regional comparator evidence outcomes population intervention treatment control safety efficacy additional" });
    await expect(store.applyOmissionAction(request(lexical))).rejects.toMatchObject({ status: 409 });
  });
  it("keeps incompatible reference packs distinct and rejects cross-pack linking", async () => {
    const f = await fixture({ pack: "pack-a" }); const c = await candidate(f, { metadata: { reference_pack_id: "pack-b" } });
    await expect(store.applyOmissionAction({ ...request(f), action: "link_existing", claim_id: c.id })).rejects.toMatchObject({ status: 409 });
    await store.applyOmissionAction(request(f)); expect(await claims(f)).toHaveLength(2);
  });
  it("treats unstructured lifecycle words as unknown and preserves linked tactic lifecycle", async () => {
    const f = await fixture({ kind: "tactic", summary: "NCT12345678 completed regional study" });
    const c = await candidate(f, { statement: "NCT12345678 planned regional study", metadata: { tactic_status: "planned" } });
    await store.applyOmissionAction({ ...request(f), action: "link_existing", claim_id: c.id });
    expect((await claims(f))[0]).toMatchObject({ metadata: { tactic_status: "planned" } });
  });
  it("prioritizes an exact contributor statement over an ambiguous finding summary", async () => {
    const f = await fixture(); const c = await candidate(f, { statement: "Regional comparator evidence is incomplete" });
    await expect(store.applyOmissionAction({ ...request(f), statement: c.statement, confirmed_distinct: true })).rejects.toMatchObject({ status: 409 });
    expect(await claims(f)).toHaveLength(1);
  });
  it("orders new decisions after an existing history timestamp", async () => {
    const f = await fixture();
    await accuracyDb().insert(t.accuracyOmissionActions).values({ id: newId("action"), workspace_id: f.workspace_id,
      source_file_id: f.source_file_id, run_id: f.run_id, issue_id: f.issue_id, action: "reclassify", new_importance: "important",
      reason: "Previous review", actor_name: actor.name, actor_function: actor.function, created_at: "2099-01-01T00:00:00.000Z",
      idempotency_key: newId("key"), request_fingerprint: "historic" });
    await store.applyOmissionAction({ ...request(f), action: "reclassify", new_importance: "advisory" });
    expect(await store.listBlockingOmissions(f.workspace_id)).toEqual([]);
    await expect(store.applyOmissionAction(request(f))).rejects.toMatchObject({ status: 409 });
  });
  it("appends a new source span without replacing existing provenance or metadata", async () => {
    const f = await fixture(); const c = await candidate(f, { metadata: { origin: "model", provenance: [{ source_file_id: "older-source", block_id: "older-block", quote: "Older evidence" }] } });
    await store.applyOmissionAction({ ...request(f), action: "link_existing", claim_id: c.id });
    expect((await claims(f))[0].metadata).toMatchObject({ origin: "model", provenance: [{ source_file_id: "older-source", block_id: "older-block", quote: "Older evidence" }, { ...f.issue.source_ref, quote: f.issue.evidence_quote }] });
  });
  it("rolls back the created claim when persisting the action fails", async () => {
    const f = await fixture(); const constraint = newId("rollback").replace(/[^a-z0-9_]/g, "_");
    // A workspace-scoped database constraint injects a real failure after claim insertion.
    await accuracyDb().execute(sql.raw(`ALTER TABLE accuracy_omission_actions ADD CONSTRAINT ${constraint} CHECK (workspace_id <> '${f.workspace_id}') NOT VALID`));
    try {
      await expect(store.applyOmissionAction(request(f))).rejects.toThrow();
      expect(await claims(f)).toEqual([]); expect(await store.listOmissionActionHistory(f)).toEqual([]);
    } finally {
      await accuracyDb().execute(sql.raw(`ALTER TABLE accuracy_omission_actions DROP CONSTRAINT ${constraint}`));
    }
  });
  it("allows only one concurrent resolution across two real database connections", async () => {
    const f = await fixture(); const monitor = postgres(process.env.DATABASE_URL!, { max: 1 });
    let decisions: Promise<PromiseSettledResult<store.OmissionAction>[]> | undefined;
    try {
      await monitor.begin(async (lock) => {
        // Hold the run row so the first decision cannot finish before the second arrives.
        await lock`select id from accuracy_module_runs where id = ${f.run_id} for update`;
        decisions = Promise.allSettled([store.applyOmissionAction(request(f)), store.applyOmissionAction(request(f))]);
        await vi.waitFor(async () => {
          // PostgreSQL caches activity statistics within a transaction; refresh each observation.
          await lock`select pg_stat_clear_snapshot()`;
          const waiters = await lock`select pid, wait_event from pg_stat_activity
            where application_name = 'kan33-omission-actions-test' and wait_event_type = 'Lock'`;
          expect(waiters).toHaveLength(2);
          expect(waiters.some((row) => row.wait_event === "advisory")).toBe(true);
          expect(new Set(waiters.map((row) => row.pid)).size).toBe(2);
        }, { timeout: 2_000, interval: 10 });
      }); // Commit releases the held run row; both real decision transactions can proceed.
      const results = await decisions!;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
      expect(await claims(f)).toHaveLength(1); expect(await store.listOmissionActionHistory(f)).toHaveLength(1);
    } finally {
      await decisions;
      await monitor.end({ timeout: 5 });
    }
  });
  it("keeps superseded runs readable but rejects new decisions", async () => {
    const f = await fixture(); await store.applyOmissionAction({ ...request(f), action: "reclassify", new_importance: "important" });
    const newer = newId("run"); const oldRun = (await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.id, f.run_id)))[0];
    await accuracyDb().insert(t.accuracyModuleRuns).values({ ...oldRun, id: newer, finished_at: "2099-01-01T00:00:00.000Z" });
    await accuracyDb().insert(t.accuracyExtractionBatches).values({ id: newId("batch"), workspace_id: f.workspace_id, source_file_id: f.source_file_id,
      requested_kinds: ["need_extract"], run_ids: [newer], created_claim_ids: [], drafts_persisted: true, created_at: nowIso() });
    await expect(store.applyOmissionAction(request(f))).rejects.toMatchObject({ status: 409 });
    const { GET } = await import("@/app/api/accuracy/omissions/route");
    const response = await GET(new Request(`http://localhost/api/accuracy/omissions?workspace_id=${f.workspace_id}&run_id=${f.run_id}`));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ current: false, actions: [expect.objectContaining({ action: "reclassify" })] });
  });
});

describe("omission API authorization and validation", () => {
  it("uses the signed-in actor and ignores spoofed issue details", async () => {
    const f = await fixture(); const response = await post({ ...request(f), actor_name: "spoof", actor: { name: "spoof" },
      issue: { summary: "spoof", evidence_quote: "spoof" }, statement: "Contributor wording" });
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.action).toMatchObject({ actor_name: actor.name, actor_function: actor.function });
    expect((await claims(f))[0]).toMatchObject({ statement: "Contributor wording", metadata: { provenance: [{ ...f.issue.source_ref, quote: f.issue.evidence_quote }] } });
  });
  it.each([{ role: "viewer" as const, signed_in: true, demo: false, status: 403 }, { role: "contributor" as const, signed_in: false, demo: false, status: 401 }])("rejects an unauthorized identity %j", async (opts) => {
    identity.mockResolvedValue({ actor, ...opts }); const f = await fixture(); const response = await post(request(f));
    expect(response.status).toBe(opts.status); expect(await claims(f)).toEqual([]);
  });
  it("allows demo contributors and exposes current review items", async () => {
    identity.mockResolvedValue({ actor, role: "contributor", signed_in: false, demo: true });
    const f = await fixture(); const { GET } = await import("@/app/api/accuracy/omissions/route");
    const response = await GET(new Request(`http://localhost/api/accuracy/omissions?workspace_id=${f.workspace_id}`));
    expect(await response.json()).toMatchObject({ items: [expect.objectContaining({ run_id: f.run_id, latest_action: null })] });
    expect((await post({ ...request(f), action: "dismiss" })).status).toBe(200);
  });
  it.each([{ action: "link_existing" }, { action: "reclassify" }, { reason: " " }, { action: "unknown" }, { statement: " " }, { confirmed_distinct: "yes" }])("rejects malformed action input %j", async (change) => {
    const f = await fixture(); expect((await post({ ...request(f), ...change })).status).toBe(400);
  });
  it("returns 404 and 409 for missing scope and conflicting decisions", async () => {
    const f = await fixture(); expect((await post({ ...request(f), run_id: "wrong" })).status).toBe(404);
    expect((await post({ ...request(f), action: "dismiss" })).status).toBe(200);
    expect((await post(request(f))).status).toBe(409);
  });
});
