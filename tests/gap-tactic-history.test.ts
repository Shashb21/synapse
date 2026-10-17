import { coverageReviewVersion } from "@/lib/iegp/requirement-basis";
import { POST as modulePost } from "@/app/api/modules/route";
import { RunRecorder, openRun, closeRun } from "@/modules/kernel/observability";
import { recordEdit } from "@/modules/kernel/edit-records";
import { latestS4MappingRows } from "@/lib/iegp/mapping-table";
import { suppliedJudgementRecords } from "@/lib/iegp/judgement-references";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";
import { relationshipSnapshot, relationshipVersion } from "@/lib/iegp/relationship-version";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value), delete: (name: string) => jar.delete(name) }),
  headers: async () => new Headers(),
}));
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { assignTacticToGap, createGap, recordMissedTactic, loadState } from "@/lib/iegp/store";
import { gapRecord } from "@/lib/iegp/gap-record";
import { tacticRecord } from "@/lib/iegp/tactic-record";
import { db, sharedDb } from "@/modules/kernel/db";
import { sql } from "drizzle-orm";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createSession } from "@/modules/auth/session";
const actor = { actor_name: "Relationship reviewer", actor_function: "medical_affairs" } as const;
const owner = `kan135-${Date.now()}@example.com`;
let workspace: Workspace;
let gapId: string;
let tacticId: string;
const scoped = <T>(fn: () => PromiseLike<T>): Promise<T> => withWorkspace(workspace.id, async () => await fn());
async function post(body: Record<string, unknown>) {
  return scoped(async () => {
    if (["lock_overall", "lock_dimension"].includes(String(body.action)) && body.expected_version === undefined) body = { ...body, expected_version: coverageReviewVersion((await loadState()).coverages.find(row => row.id === body.coverage_id)!) };
    if (body.action === "assign_tactic" && body.expected_relationship === undefined) body = { ...body, expected_relationship: relationshipVersion(relationshipSnapshot(await loadState(), String(body.gap_id), String(body.tactic_id))) };
    const response = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...actor, ...body }) }));
    return { status: response.status, body: await response.json() };
  });
}
beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: "KAN135 relationship history", owner });
  const session = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: actor.actor_name, actor_function: actor.actor_function, role: "medical_affairs" });
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
  gapId = await scoped(() => createGap({ ...actor, statement: "Missing comparative evidence" }));
  tacticId = await scoped(() => recordMissedTactic({ ...actor, name: "Reusable cohort", type: "rwe_study", status: "planned", evidence_question: "What is survival?" }));
}, 60000);
afterAll(async () => {
  if (workspace) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  jar.clear(); vi.unstubAllEnvs();
});
it("requires a reason even when linking without a coverage judgement", async () => {
  const result = await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId });
  expect(result.status).toBe(400);
  expect((await scoped(loadState)).coverages).toHaveLength(0);
});
it("shows one persistent relationship event from both endpoints, including after unlink", async () => {
  const linked = await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, rationale: "Use the registry cohort for comparison" });
  expect(linked.status).toBe(200);
  const [gap, tactic] = await scoped(async () => Promise.all([gapRecord(gapId), tacticRecord(tacticId)]));
  const event = gap!.history.filter(row => row.rationale === "Use the registry cohort for comparison");
  expect(event).toHaveLength(1);
  expect(tactic!.history.find(row => row.id === event[0].id)).toBeDefined();
  const snapshot = relationshipSnapshot(await scoped(loadState), gapId, tacticId);
  expect((await post({ action: "unassign_tactic", gap_id: gapId, tactic_id: tacticId, expected_relationship: relationshipVersion(snapshot), rationale: "Study no longer answers this question" })).status).toBe(200);
  const after = await scoped(() => tacticRecord(tacticId));
  expect(after!.coverages).toHaveLength(0);
  expect(after!.history.find(row => row.id === event[0].id)).toBeDefined();
  expect(after!.history.filter(row => row.rationale === "Study no longer answers this question")).toHaveLength(1);
});
it("keeps distinct coverage for a reused tactic and rejects competing opening snapshots without extra history", async () => {
  const gap2 = await scoped(() => createGap({ ...actor, statement: "Missing long term survival evidence" }));
  for (const [id, overall] of [[gapId, "partial"], [gap2, "limited"]]) {
    expect((await post({ action: "assign_tactic", gap_id: id, tactic_id: tacticId, overall, rationale: `Human judgement for ${id}` })).status).toBe(200);
  }
  const state = await scoped(loadState);
  const row = state.coverages.find(row => row.gap_id === gapId)!;
  const payload = { action: "lock_overall", coverage_id: row.id, expected_relationship: relationshipVersion(relationshipSnapshot(state, gapId, tacticId)), rationale: "Reviewed complete registry results" };
  const results = await Promise.all([post({ ...payload, overall: "limited" }), post({ ...payload, overall: "not_relevant" })]);
  expect(results.map(result => result.status).sort()).toEqual([200, 400]);
  expect(results.find(result => result.status === 400)!.body.error).toContain("Relationship changed");
  const after = await scoped(() => tacticRecord(tacticId));
  expect(after!.coverages.find(row => row.gap_id === gap2)!.overall).toBe("limited");
  const changed = after!.history.filter(row => row.rationale === payload.rationale);
  expect(changed.filter(row => row.entity_id === `${gapId}::${tacticId}`)).toHaveLength(1);
  expect(changed.filter(row => row.entity_id === `${gap2}::${tacticId}`)).toHaveLength(1);
  expect(changed.find(row => row.entity_id === `${gapId}::${tacticId}`)).toMatchObject({ actor_name: actor.actor_name, actor_principal: owner, entity_id: `${gapId}::${tacticId}` });
  expect(changed.find(row => row.entity_id === `${gapId}::${tacticId}`)!.counterpart_gaps).toEqual([{ id: gapId, name: state.gaps.find(row => row.id === gapId)!.name }]);
  const saved = (await scoped(loadState)).coverages.find(row => row.gap_id === gapId)!;
  const noop = await post({ action: "lock_overall", coverage_id: saved.id, expected_relationship: relationshipVersion(relationshipSnapshot(await scoped(loadState), gapId, tacticId)), overall: saved.overall, rationale: "Same judgement creates no new event" });
  expect(noop.status).toBe(200);
  expect((await scoped(() => tacticRecord(tacticId)))!.history).toHaveLength(after!.history.length);
});
it("rolls back relationship, decision and history when the audit cannot persist", async () => {
  const state = await scoped(loadState);
  const row = state.coverages.find(row => row.gap_id === gapId)!;
  const history = (await scoped(() => tacticRecord(tacticId)))!.history;
  await scoped(async () => {
    await db().execute(sql.raw("CREATE FUNCTION fail_relationship_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN135 injected history failure'; END $$"));
    await db().execute(sql.raw("CREATE TRIGGER fail_relationship_history BEFORE INSERT ON edit_records FOR EACH ROW WHEN (NEW.entity_type = 'gap_tactic') EXECUTE FUNCTION fail_relationship_history()"));
  });
  try {
    const result = await post({ action: "unassign_tactic", gap_id: gapId, tactic_id: tacticId, expected_relationship: relationshipVersion(relationshipSnapshot(state, gapId, tacticId)), rationale: "Should roll back when history fails" });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Could not save the relationship and its history");
    const after = await scoped(loadState);
    expect(after.coverages).toEqual(state.coverages);
    expect(after.mapping_suggestions).toEqual(state.mapping_suggestions);
    expect((await scoped(() => tacticRecord(tacticId)))!.history).toEqual(history);
    expect(after.coverages).toContainEqual(row);
  } finally {
    await scoped(async () => {
      await db().execute(sql.raw("DROP TRIGGER fail_relationship_history ON edit_records"));
      await db().execute(sql.raw("DROP FUNCTION fail_relationship_history()"));
    });
  }
});
it("requires actual authorised support for model judgements while leaving manual judgements available", async () => {
  const gap3 = await scoped(() => createGap({ ...actor, statement: "Missing patient outcomes" }));
  const payload = { ...actor, gap_id: gap3, tactic_id: tacticId, coverage: "partial" as const, note: "Model judged overlap with the supplied need" };
  await expect(scoped(() => assignTacticToGap({ ...payload, coverage: "unassessed", model: true }))).rejects.toThrow("Supporting references are missing");
  for (const references of [undefined, [{ entity_type: "gap" as const, entity_id: "foreign-workspace-gap", reason: "Unsupported source claim" }]]) {
    await expect(scoped(() => assignTacticToGap({ ...payload, references }))).rejects.toThrow("Supporting references are missing");
    expect((await scoped(loadState)).coverages.some(row => row.gap_id === gap3)).toBe(false);
  }
  const references = [{ entity_type: "gap" as const, entity_id: gap3, reason: "The supplied gap specifies the patient outcomes to cover" }];
  await scoped(() => assignTacticToGap({ ...payload, references }));
  const record = (await scoped(() => gapRecord(gap3)))!;
  expect(record.history.filter(row => row.entity_type === "gap_tactic")).toHaveLength(1);
  expect(record.history.find(row => row.field === "model_relationship")!.supporting_references).toEqual([{ ...references[0], target: { title: record.gap.name, href: `/gaps/${gap3}` } }]);
  const row = (await scoped(loadState)).coverages.find(row => row.gap_id === gap3)!;
  expect((await post({ action: "lock_overall", coverage_id: row.id, expected_relationship: relationshipVersion(relationshipSnapshot(await scoped(loadState), gap3, tacticId)), overall: "limited", rationale: "Human correction based on registry review" })).status).toBe(200);
});
it("preserves recorded legacy coverage history through unlink without fabricating reasons or support", async () => {
  const state = await scoped(loadState);
  const coverage = state.coverages.find(row => row.gap_id === gapId)!;
  const legacy = await scoped(() => recordEdit({ stage: "S5", entity_type: "coverage", entity_id: coverage.id, field: "overall", action: "edit", before: "unassessed", after: "partial", rationale: null, rationale_optional: true, actor: { name: "Legacy reviewer", function: "medical_affairs" } }));
  const result = await post({ action: "unassign_tactic", gap_id: gapId, tactic_id: tacticId, expected_relationship: relationshipVersion(relationshipSnapshot(state, gapId, tacticId)), rationale: "Retain the older decision when removing this mapping" });
  expect(result.status).toBe(200);
  for (const record of await scoped(async () => Promise.all([gapRecord(gapId), tacticRecord(tacticId)]))) {
    expect(record!.history.find(row => row.id === legacy.id)).toMatchObject({ rationale: null, supporting_references: [] });
  }
});
it("keeps foreign workspace records inaccessible and reasons cannot grant viewer permissions", async () => {
  const foreign = await createWorkspace({ name: "KAN135 foreign relationship", owner: `${owner}-other` });
  const foreignId = `foreign-${Date.now()}`;
  try {
    await withWorkspace(foreign.id, async () => {
      const id = await createGap({ ...actor, statement: "Foreign confidential planning evidence" });
      await db().execute(sql`UPDATE gaps SET id = ${foreignId} WHERE id = ${id}`);
    });
    const before = await scoped(loadState);
    expect((await post({ action: "assign_tactic", gap_id: foreignId, tactic_id: tacticId, rationale: "A reason cannot grant access" })).status).toBe(404);
    expect(await scoped(() => gapRecord(foreignId))).toBeNull();
    const ownGap = await scoped(() => createGap({ ...actor, statement: "Local outcomes evidence" }));
    await expect(scoped(() => assignTacticToGap({ ...actor, gap_id: ownGap, tactic_id: tacticId, coverage: "full", note: "Foreign record cannot support local model judgement", references: [{ entity_type: "gap", entity_id: foreignId, reason: "Claiming confidential foreign context" }] }))).rejects.toThrow("Supporting references are missing");
    expect((await scoped(loadState)).coverages).toEqual(before.coverages);
    const viewer = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: "Viewer", actor_function: "medical_affairs", role: "viewer" });
    jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, viewer.id));
    try {
      expect((await post({ action: "assign_tactic", gap_id: ownGap, tactic_id: tacticId, rationale: "Meaningful reason still cannot authorise this" })).status).toBe(403);
    } finally {
      const restored = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: actor.actor_name, actor_function: actor.actor_function, role: "medical_affairs" });
      jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, restored.id));
    }
    expect((await scoped(loadState)).coverages).toEqual(before.coverages);
  } finally { await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${foreign.schema_name}" CASCADE`)); }
});
it("accepts only the stored current model judgement with validated support and offers an explicit manual judgement", async () => {
  const id = await scoped(() => createGap({ ...actor, statement: "Need comparative patient outcomes" }));
  const context = await scoped(loadState);
  const mapping = { supplied_records: suppliedJudgementRecords(context, [id]), expected_tactic_version: tacticEditVersion(context.tactics.find(row => row.id === tacticId)!), tactic_id: tacticId, tactic_name: "Reusable cohort", coverage: "partial" as const, confidence: 75, rationale: "The registry addresses the supplied patient outcomes", dimensions: null,
    references: [{ entity_type: "gap" as const, entity_id: id, reason: "The supplied evidence need identifies the outcome to cover" }] };
  async function proposal(value: typeof mapping) {
    await scoped(async () => {
      const recorder = new RunRecorder({ workspace_id: workspace.id, stage: "S4", module_id: "s4-kg-mapping.mapping-table", module_version: "1.0.0", actor: { name: "Model fixture", function: "medical_affairs" }, input: { gap_ids: [id] } });
      await openRun(recorder);
      await closeRun({ recorder, status: "ok", output: { rows: [{ gap_id: id, gap_name: "Outcomes", tactic_ids: [tacticId], tactic_names: [mapping.tactic_name], mapping_status: "partially_addressed", confidence: 75, rationale: [mapping.rationale], mappings: [value], review: null }] } });
    });
  }
  const emptySupport = { ...mapping, references: [] };
  await proposal(emptySupport);
  const payload = { action: "accept_mapping", gap_id: id, tactic_id: tacticId, expected_relationship: relationshipVersion(relationshipSnapshot(await scoped(loadState), id, tacticId)), judgement_origin: "model", expected_suggestion: relationshipVersion(emptySupport), rationale: "Reviewed the suggested relationship" };
  expect((await post(payload)).body.error).toContain("Supporting references are missing");
  expect((await scoped(loadState)).coverages.some(row => row.gap_id === id)).toBe(false);
  await proposal(mapping);
  expect((await post(payload)).body.error).toContain("Model suggestion changed");
  const accepted = await post({ ...payload, expected_suggestion: relationshipVersion(mapping), overall: "full", references: JSON.stringify([{ entity_type: "gap", entity_id: "forged", reason: "Ignore browser-authored citations" }]) });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const state = await scoped(loadState);
  expect(state.coverages.find(row => row.gap_id === id)!.overall).toBe("partial");
  const history = (await scoped(() => gapRecord(id)))!.history.filter(row => row.entity_type === "gap_tactic");
  expect(history).toHaveLength(1);
  expect(history[0].supporting_references?.[0].entity_id).toBe(id);
  expect((await post({ action: "lock_overall", coverage_id: state.coverages.find(row => row.gap_id === id)!.id, expected_relationship: relationshipVersion(relationshipSnapshot(state, id, tacticId)), overall: "limited", rationale: "Explicit manual judgement after inspecting the registry" })).status).toBe(200);
});
it("S5 reuses the relationship event and reports no new event for a no-op acceptance", async () => {
  const id = await scoped(() => createGap({ ...actor, statement: "Need routine care outcome evidence" }));
  async function gate(action: "map_tactic" | "accept_mapping") {
    return scoped(async () => {
      const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S5", input: { action, gap_id: id, tactic_id: tacticId, expected_relationship: relationshipVersion(relationshipSnapshot(await loadState(), id, tacticId)), rationale: "Human gate reviewed this separate relationship" } }) }));
      return { status: response.status, body: await response.json() };
    });
  }
  const result = await gate("map_tactic");
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const mapped = (await scoped(() => tacticRecord(tacticId)))!.history;
  expect(mapped.find(entry => entry.id === result.body.output.edit_id)).toMatchObject({ entity_type: "gap_tactic", entity_id: `${id}::${tacticId}` });
  const accepted = await gate("accept_mapping");
  expect(accepted.status).toBe(200);
  const before = (await scoped(() => tacticRecord(tacticId)))!.history;
  expect(before.find(entry => entry.id === accepted.body.output.edit_id)).toMatchObject({ entity_type: "gap_tactic", entity_id: `${id}::${tacticId}` });
  const noop = await gate("accept_mapping");
  expect(noop.status).toBe(200);
  expect(noop.body.output.edit_id).toBe("");
  expect((await scoped(() => tacticRecord(tacticId)))!.history).toEqual(before);
});

it.each(["tactic", "gap"])("rejects an unchanged stored model proposal after its %s input changes", async (entity) => {
  const id = await scoped(() => createGap({ ...actor, statement: "Original comparative question" }));
  const state = await scoped(loadState);
  const mapping = { tactic_id: tacticId, tactic_name: "Reusable cohort", coverage: "partial", confidence: 75, rationale: "Original supplied question", dimensions: null,
    references: [{ entity_type: "gap", entity_id: id, reason: "The supplied gap identifies the outcome" }],
    supplied_records: suppliedJudgementRecords(state, [id]), expected_tactic_version: tacticEditVersion(state.tactics.find(row => row.id === tacticId)!) };
  await scoped(async () => {
    const recorder = new RunRecorder({ workspace_id: workspace.id, stage: "S4", module_id: "s4-kg-mapping.mapping-table", module_version: "1.0.0", actor: { name: "Model fixture", function: "medical_affairs" }, input: { gap_ids: [id] } });
    await openRun(recorder);
    await closeRun({ recorder, status: "ok", output: { rows: [{ gap_id: id, gap_name: "Question", tactic_ids: [tacticId], tactic_names: [mapping.tactic_name], mapping_status: "partially_addressed", confidence: 75, rationale: [mapping.rationale], mappings: [mapping], review: null }] } });
    if (entity === "tactic") await db().execute(sql`UPDATE tactics SET evidence_question = 'Changed scientific question' WHERE id = ${tacticId}`);
    else await db().execute(sql`UPDATE gaps SET statement = 'Changed comparative outcome' WHERE id = ${id}`);
  });
  const before = await scoped(loadState);
  const history = (await scoped(() => gapRecord(id)))!.history;
  const result = await post({ action: "accept_mapping", gap_id: id, tactic_id: tacticId, judgement_origin: "model", expected_suggestion: relationshipVersion((await scoped(latestS4MappingRows))!.find(row => row.gap_id === id)!.mappings[0]), expected_relationship: relationshipVersion(relationshipSnapshot(state, id, tacticId)), rationale: "Retain my considered acceptance reason" });
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.error).toContain("context changed");
  expect((await scoped(loadState)).coverages).toEqual(before.coverages);
  expect((await scoped(loadState)).mapping_suggestions).toEqual(before.mapping_suggestions);
  expect((await scoped(() => gapRecord(id)))!.history).toEqual(history);
});
it.each(["split_partial_gap", "rewrite_partial_gap"])("rejects stale %s after a selected parent tactic is unlinked", async (action) => {
  const id = await scoped(() => createGap({ ...actor, statement: "Partly answered comparative question" }));
  const ids = await scoped(async () => Promise.all(["Selected registry", "Remaining registry"].map(name => recordMissedTactic({ ...actor, name, type: "rwe_study", status: "planned", evidence_question: "Which comparative outcomes are answered?" }))));
  for (const tid of ids) await scoped(() => assignTacticToGap({ ...actor, gap_id: id, tactic_id: tid, human: true, coverage: "partial", note: "Registry answers part of this question" }));
  const opening = (await scoped(() => gapRecord(id)))! as NonNullable<Awaited<ReturnType<typeof gapRecord>>> & { resolution_version?: string };
  const state = await scoped(loadState);
  expect((await post({ action: "unassign_tactic", gap_id: id, tactic_id: ids[0], expected_relationship: relationshipVersion(relationshipSnapshot(state, id, ids[0])), rationale: "Explicitly remove this registry from the gap" })).status).toBe(200);
  const before = await scoped(loadState);
  const history = (await scoped(() => gapRecord(id)))!.history;
  const result = await post({ action, parent_gap_id: id, gap_id: id, expected_resolution: opening.resolution_version, addressed_name: "Answered slice", open_name: "Remaining comparison", name: "Answered replacement", status: "validated_addressed", tactic_ids: ids[0], note: "Keep my reviewed split fields and reason" });
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.error).toContain("changed");
  expect((await scoped(loadState)).gaps).toEqual(before.gaps);
  expect((await scoped(loadState)).coverages).toEqual(before.coverages);
  expect((await scoped(loadState)).mapping_suggestions).toEqual(before.mapping_suggestions);
  expect((await scoped(() => gapRecord(id)))!.history).toEqual(history);
});

it("refuses a legacy stored model proposal without its generation context", async () => {
  const id = await scoped(() => createGap({ ...actor, statement: "Evidence question for a legacy proposal" }));
  const mapping = { tactic_id: tacticId, tactic_name: "Reusable cohort", coverage: "partial", confidence: 75, rationale: "Legacy model judgement", dimensions: null,
    references: [{ entity_type: "gap", entity_id: id, reason: "A real reference does not establish the original model inputs" }] };
  await scoped(async () => {
    const recorder = new RunRecorder({ workspace_id: workspace.id, stage: "S4", module_id: "s4-kg-mapping.mapping-table", module_version: "1.0.0", actor: { name: "Model fixture", function: "medical_affairs" }, input: { gap_ids: [id] } });
    await openRun(recorder);
    await closeRun({ recorder, status: "ok", output: { rows: [{ gap_id: id, gap_name: "Legacy question", tactic_ids: [tacticId], tactic_names: [mapping.tactic_name], mapping_status: "partially_addressed", confidence: 75, rationale: [mapping.rationale], mappings: [mapping], review: null }] } });
  });
  const state = await scoped(loadState);
  const result = await post({ action: "accept_mapping", gap_id: id, tactic_id: tacticId, judgement_origin: "model", expected_suggestion: relationshipVersion(mapping), expected_relationship: relationshipVersion(relationshipSnapshot(state, id, tacticId)), rationale: "A valid reason cannot reconstruct missing model context" });
  expect(result.status).toBe(400);
  expect(result.body.error).toContain("context is unavailable");
  expect(await scoped(loadState)).toEqual(state);
});
