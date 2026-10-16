import { afterAll, beforeAll, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => jar.set(name, value), delete: (name: string) => jar.delete(name), get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined }), headers: async () => new Headers() }));
import "@/modules";
import { POST } from "@/app/api/plan/route";
import { POST as tacticPost } from "@/app/api/iegp/route";
import { createGap, createNeed, loadState, recordMissedTactic, resetBlank, validateGap } from "@/lib/iegp/store";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createSession } from "@/modules/auth/session";
import { db, sharedDb } from "@/modules/kernel/db";
import * as kernel from "@/modules/kernel/schema";
import { eq, sql } from "drizzle-orm";
import { addIdeationProposal, listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import { gapRecord } from "@/lib/iegp/gap-record";
import { tacticRecord } from "@/lib/iegp/tactic-record";
import * as core from "@/lib/iegp/schema";
import { suppliedJudgementRecords } from "@/lib/iegp/judgement-references";

let workspace: Workspace, gapId = "", tacticId = "";
const owner = `kan136-${Date.now()}@example.com`;
const actor = { name: "Option reviewer", function: "medical_affairs" as const };
const who = { actor_name: actor.name, actor_function: actor.function };
const scoped = <T>(fn: () => Promise<T>) => withWorkspace(workspace.id, fn);
const post = async (body: Record<string, unknown>, handler: (request: Request) => Promise<Response> = POST) => scoped(async () => {
  const res = await handler(new Request("http://localhost/api/plan", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
});
const proposals = () => scoped(listIdeationProposals);
const proposal = (id: string) => proposals().then(rows => rows.find(row => row.id === id)!);
const add = () => scoped(() => addIdeationProposal({ gap_id: gapId, fields: { name: "Reviewed cohort", type: "rwe_study", evidence_question: "What outcomes occur in care?" }, rationale: "Addresses the routine care evidence need", actor }));
const versionOf = (row: unknown) => (row as { version: string }).version;
async function signIn(role: "medical_affairs" | "viewer" = "medical_affairs") {
  const session = await createSession({ provider_id: "demo", subject: owner, email: owner, ...who, role });
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
}
beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: "KAN136 option audit", owner });
  await signIn();
  await scoped(async () => {
    await resetBlank();
    gapId = await createGap({ ...who, statement: "Routine care outcomes are unknown", domain: "comparative_effectiveness" });
    await validateGap({ gap_id: gapId, ...who });
    await db().insert(kernel.priorityPlacements).values({ gap_id: gapId, axis_scores: {}, suggested_band: "high", suggested_rationale: "", band: "high", validated: true, rationale: "Confirmed High", actor_name: actor.name, actor_function: actor.function, at: new Date().toISOString() });
    tacticId = await recordMissedTactic({ ...who, name: "Existing cohort", type: "rwe_study", status: "planned", evidence_question: "What outcomes occur?" });
  });
}, 60_000);
afterAll(async () => {
  if (workspace) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  vi.unstubAllEnvs(); jar.clear();
});
it("rejects absent reasons and opening snapshots, and detects an edit before a decision", async () => {
  const initial = await add();
  expect((await post({ action: "decide_proposal", id: initial.id, decision: "reject", expected_version: versionOf(initial) })).status).toBe(400);
  expect((await post({ action: "edit_proposal", id: initial.id, name: "No snapshot", rationale: "Missing opening version" })).status).toBe(400);
  expect((await post({ action: "edit_proposal", id: initial.id, name: "Revised cohort", expected_version: versionOf(initial), rationale: "Correct the proposed study name" })).status).toBe(200);
  const result = await post({ action: "decide_proposal", id: initial.id, expected_version: versionOf(initial), decision: "accept", rationale: "Reason on stale decision" });
  expect(result.status).toBe(400);
  expect(result.body.error).toContain("Proposal changed");
  expect((await proposal(initial.id)).status).toBe("proposed");
});
it("shows append-only proposal decisions at the gap and accepted tactic and excludes no-op edits", async () => {
  const initial = await add();
  const before = await scoped(() => gapRecord(gapId));
  expect((await post({ action: "edit_proposal", id: initial.id, expected_version: versionOf(initial), name: initial.name, rationale: "No substantive change" })).status).toBe(200);
  expect((await scoped(() => gapRecord(gapId)))!.history).toEqual(before!.history);
  const accepted = await post({ action: "decide_proposal", id: initial.id, expected_version: versionOf(initial), decision: "accept", rationale: "Accept this feasible routine care option" });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const gap = (await scoped(() => gapRecord(gapId)))!;
  const tactic = (await scoped(() => tacticRecord(accepted.body.tactic_id)))!;
  const event = gap.history.find(row => row.entity_id === initial.id && row.action === "accept");
  expect(event).toMatchObject({ before: "proposed", after: "accepted", actor_name: actor.name, actor_principal: owner, rationale: "Accept this feasible routine care option" });
  expect(tactic.history.find(row => row.id === event!.id)).toBeTruthy();
  expect(tactic.history.find(row => row.action === "create_proposed")?.rationale).toContain("Accept this feasible routine care option");
  expect(tactic.history.find(row => row.id === event!.id)!.counterpart_gaps?.[0].id).toBe(gapId);
  const rejected = await add();
  expect((await post({ action: "decide_proposal", id: rejected.id, expected_version: versionOf(rejected), decision: "reject", rationale: "Insufficient data access for this option" })).status).toBe(200);
  const settled = await proposal(rejected.id);
  expect((await post({ action: "restore_proposal", id: settled.id, expected_version: versionOf(settled), rationale: "Data access is now available" })).status).toBe(200);
  const history = (await scoped(() => gapRecord(gapId)))!.history;
  expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ entity_id: rejected.id, before: "proposed", after: "rejected" }), expect.objectContaining({ entity_id: rejected.id, before: "rejected", after: "proposed" })]));
  const restored = await proposal(rejected.id);
  expect(restored.version).not.toBe(rejected.version);
  expect((await post({ action: "decide_proposal", id: rejected.id, expected_version: rejected.version, decision: "accept", rationale: "An opening before rejection and restore is stale" })).status).toBe(400);
});
it("refuses unsupported model acceptance and offers an explicit reasoned manual decision", async () => {
  const initial = await add();
  await scoped(() => db().update(kernel.ideationProposals).set({ design: { ...initial.design, origin: "ai" } }).where(eq(kernel.ideationProposals.id, initial.id)));
  const pending = await proposal(initial.id);
  const payload = { action: "decide_proposal", id: pending.id, expected_version: versionOf(pending), decision: "accept", rationale: "Inspected legacy proposed design" };
  expect((await post(payload)).body.error).toContain("Supporting references");
  expect((await proposal(initial.id)).status).toBe("proposed");
  const manual = await post({ ...payload, judgement_origin: "manual" });
  expect(manual.status, JSON.stringify(manual.body)).toBe(200);
  const event = (await scoped(() => gapRecord(gapId)))!.history.find(row => row.entity_id === initial.id && row.action === "accept")!;
  expect(event.field).toBe("manual_status");
  expect(event.supporting_references).toEqual([]);
});
it("validates stored supplied model references and rejects changed or foreign support", async () => {
  const initial = await add();
  const state = await scoped(loadState);
  const references = [{ entity_type: "gap", entity_id: gapId, reason: "The supplied gap states the routine care outcome need" }];
  const design = { ...initial.design, origin: "ai", supplied_records: suppliedJudgementRecords(state, [gapId]), supporting_references: references };
  const saveDesign = (value: unknown) => scoped(() => db().update(kernel.ideationProposals).set({ design: value }).where(eq(kernel.ideationProposals.id, initial.id)));
  await saveDesign({ ...design, supporting_references: [{ ...references[0], entity_id: "foreign-gap" }] });
  let pending = await proposal(initial.id);
  expect((await post({ action: "decide_proposal", id: initial.id, expected_version: versionOf(pending), decision: "accept", rationale: "Review with inaccessible support" })).status).toBe(400);
  await saveDesign(design);
  pending = await proposal(initial.id);
  const accepted = await post({ action: "decide_proposal", id: initial.id, expected_version: versionOf(pending), decision: "accept", rationale: "Review the supported routine care option" });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const event = (await scoped(() => gapRecord(gapId)))!.history.find(row => row.entity_id === initial.id && row.action === "accept")!;
  expect(event.supporting_references?.[0]).toMatchObject({ ...references[0], target: { href: `/gaps/${gapId}` } });
});
it.each(["current", "legacy"])("accepts %s support despite record/quotation order while rejecting genuine quotation changes", async format => {
  const initial = await add();
  const base = await scoped(loadState);
  const source = base.sources[0];
  const otherSourceId = `${source.id}-${format}`;
  await scoped(async () => {
    await db().insert(core.sources).values({ ...source, id: otherSourceId, title: "Second supplied source" });
    for (const [source_id, source_quote] of [[source.id, "First supplied quotation"], [source.id, "Second supplied quotation\nwith its original second line"], [otherSourceId, "Other source quotation"]]) {
      await createNeed({ ...who, gap_id: gapId, source_id, source_quote, statement: source_quote, rationale: "Attach the supplied source quotation for review" });
    }
  });
  const state = await scoped(loadState);
  const support = suppliedJudgementRecords(state, [gapId]).reverse().map(record => record.entity_type === "source" && format === "legacy" ? {
    ...record,
    excerpt: state.needs.filter(need => state.need_gap_links.some(link => link.gap_id === gapId && link.need_id === need.id) && need.source_id === record.entity_id).reverse().map(need => need.source_quote).join("\n"),
  } : record);
  const references = [{ entity_type: "source", entity_id: otherSourceId, reason: "The supplied source supports this proposed outcome design" }];
  await scoped(() => db().update(kernel.ideationProposals).set({ design: { ...initial.design, origin: "ai", supplied_records: support, supporting_references: references } }).where(eq(kernel.ideationProposals.id, initial.id)));
  const pending = await proposal(initial.id);
  const payload = { action: "decide_proposal", id: initial.id, expected_version: pending.version, decision: "accept", rationale: "Accept the same scientific records regardless of storage order" };
  const need = state.needs.find(row => row.source_quote === "First supplied quotation")!;
  await scoped(() => db().update(core.needs).set({ source_quote: "A genuinely changed supplied quotation" }).where(eq(core.needs.id, need.id)));
  try {
    const before = await scoped(loadState);
    const history = (await scoped(() => gapRecord(gapId)))!.history;
    const result = await post(payload);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("context changed");
    expect(await scoped(loadState)).toEqual(before);
    expect((await scoped(() => gapRecord(gapId)))!.history).toEqual(history);
  } finally { await scoped(() => db().update(core.needs).set({ source_quote: need.source_quote }).where(eq(core.needs.id, need.id))); }
  const accepted = await post(payload);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect((await proposal(initial.id)).status).toBe("accepted");
});

it("rolls back new options, decisions and history if required audit storage fails", async () => {
  const initial = await add();
  const state = await scoped(loadState);
  const history = (await scoped(() => gapRecord(gapId)))!.history;
  await scoped(async () => {
    await db().execute(sql.raw("CREATE FUNCTION fail_option_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN136 injected audit failure'; END $$"));
    await db().execute(sql.raw("CREATE TRIGGER fail_option_edit BEFORE INSERT ON edit_records FOR EACH ROW WHEN (NEW.entity_type = 'ideation_proposal') EXECUTE FUNCTION fail_option_edit()"));
  });
  try {
    expect((await post({ action: "decide_proposal", id: initial.id, expected_version: versionOf(initial), decision: "accept", rationale: "Must roll back this whole acceptance" })).status).toBe(400);
    expect((await proposal(initial.id)).status).toBe("proposed");
    expect(await scoped(loadState)).toEqual(state);
    expect((await scoped(() => gapRecord(gapId)))!.history).toEqual(history);
    expect((await post({ action: "add_proposal", gap_id: gapId, name: "Atomic manual idea", type: "rwe_study", evidence_question: "What outcomes?", rationale: "Must not leave an unaudited idea" })).status).toBe(400);
    expect((await proposals()).some(row => row.name === "Atomic manual idea")).toBe(false);
  } finally {
    await scoped(async () => { await db().execute(sql.raw("DROP TRIGGER fail_option_edit ON edit_records")); await db().execute(sql.raw("DROP FUNCTION fail_option_edit()")); });
  }
});
it("requires meaningful lifecycle/review reasons and rejects conflicting tactic decisions", async () => {
  const initial = (await scoped(() => tacticRecord(tacticId)))!;
  expect((await post({ action: "lock_tactic", tactic_id: tacticId, status: "ongoing", expected_tactic: initial.version }, tacticPost)).status).toBe(400);
  expect((await post({ action: "lock_tactic_review", tactic_id: tacticId, review_status: "rejected", note: "x", expected_tactic: initial.version }, tacticPost)).status).toBe(400);
  expect((await post({ action: "lock_tactic", tactic_id: tacticId, status: "ongoing", expected_tactic: initial.version, note: "The funded cohort has begun" }, tacticPost)).status).toBe(200);
  const stale = await post({ action: "lock_tactic_review", tactic_id: tacticId, review_status: "rejected", expected_tactic: initial.version, note: "Old decision must not overwrite ongoing work" }, tacticPost);
  expect(stale.status).toBe(400);
  expect(stale.body.error).toContain("Tactic changed");
  const saved = (await scoped(() => tacticRecord(tacticId)))!;
  expect(saved.history).toContainEqual(expect.objectContaining({ field: "status", before: "planned", after: "ongoing", rationale: "The funded cohort has begun" }));
});
it("rejects a model option after supplied scientific context changes and retains the pending option", async () => {
  const initial = await add();
  const state = await scoped(loadState);
  const gap = state.gaps.find(row => row.id === gapId)!;
  const references = [{ entity_type: "gap", entity_id: gapId, reason: "The supplied gap defines the outcome needed for this option" }];
  await scoped(() => db().update(kernel.ideationProposals).set({ design: { ...initial.design, origin: "ai", supplied_records: suppliedJudgementRecords(state, [gapId]), supporting_references: references } }).where(eq(kernel.ideationProposals.id, initial.id)));
  const pending = await proposal(initial.id);
  await scoped(() => db().update(core.gaps).set({ statement: "A concurrently revised scientific outcome question" }).where(eq(core.gaps.id, gapId)));
  try {
    const before = (await scoped(() => gapRecord(gapId)))!.history;
    const result = await post({ action: "decide_proposal", id: initial.id, expected_version: pending.version, decision: "accept", rationale: "This acceptance used the original supplied evidence need" });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("context changed");
    expect((await proposal(initial.id)).status).toBe("proposed");
    expect((await scoped(() => gapRecord(gapId)))!.history).toEqual(before);
  } finally { await scoped(() => db().update(core.gaps).set({ statement: gap.statement }).where(eq(core.gaps.id, gapId))); }
});
it("appends reasoned tactic review corrections, excludes repeated decisions and rolls back failed restores", async () => {
  const initial = (await scoped(() => tacticRecord(tacticId)))!;
  expect((await post({ action: "lock_tactic_review", tactic_id: tacticId, expected_tactic: initial.version, review_status: "rejected", note: "The planned cohort no longer has data access" }, tacticPost)).status).toBe(200);
  const rejected = (await scoped(() => tacticRecord(tacticId)))!;
  expect((await post({ action: "lock_tactic_review", tactic_id: tacticId, expected_tactic: rejected.version, review_status: "rejected", note: "No substantive new decision" }, tacticPost)).status).toBe(200);
  expect((await scoped(() => tacticRecord(tacticId)))!.history).toEqual(rejected.history);
  await scoped(async () => {
    await db().execute(sql.raw("CREATE FUNCTION fail_review_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN136 injected review failure'; END $$"));
    await db().execute(sql.raw("CREATE TRIGGER fail_review_edit BEFORE INSERT ON edit_records FOR EACH ROW WHEN (NEW.entity_type = 'tactic') EXECUTE FUNCTION fail_review_edit()"));
  });
  const restore = { action: "restore_tactic", tactic_id: tacticId, expected_tactic: rejected.version, rationale: "Data access is restored for the planned cohort" };
  try {
    expect((await post(restore, tacticPost)).status).toBe(400);
    expect((await scoped(() => tacticRecord(tacticId)))!.tactic).toEqual(rejected.tactic);
    expect((await scoped(() => tacticRecord(tacticId)))!.history).toEqual(rejected.history);
  } finally {
    await scoped(async () => { await db().execute(sql.raw("DROP TRIGGER fail_review_edit ON edit_records")); await db().execute(sql.raw("DROP FUNCTION fail_review_edit()")); });
  }
  expect((await post(restore, tacticPost)).status).toBe(200);
  const saved = (await scoped(() => tacticRecord(tacticId)))!;
  expect(saved.history).toContainEqual(expect.objectContaining({ field: "review_status", before: "rejected", after: "accepted", rationale: restore.rationale }));
  expect(saved.history).toContainEqual(expect.objectContaining({ field: "review_status", before: "accepted", after: "rejected" }));
});

it("does not let reasons or a copied option version bypass workspace and role boundaries", async () => {
  const initial = await add();
  await signIn("viewer");
  try { expect((await post({ action: "decide_proposal", id: initial.id, expected_version: versionOf(initial), decision: "reject", rationale: "Viewer cannot change this option" })).status).toBe(403); }
  finally { await signIn(); }
  const foreign = await createWorkspace({ name: "KAN136 foreign", owner });
  try {
    const result = await withWorkspace(foreign.id, async () => {
      jar.set(WORKSPACE_COOKIE, workspaceCookieValue(foreign.id, (await createSession({ provider_id: "demo", subject: owner, email: owner, ...who, role: "medical_affairs" })).id));
      return POST(new Request("http://localhost/api/plan", { method: "POST", body: JSON.stringify({ action: "decide_proposal", id: initial.id, expected_version: versionOf(initial), decision: "reject", rationale: "Copied version cannot grant access" }) }));
    });
    expect(result.status).toBe(400);
    expect((await proposal(initial.id)).status).toBe("proposed");
  } finally { await signIn(); await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${foreign.schema_name}" CASCADE`)); }
});
