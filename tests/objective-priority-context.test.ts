import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const permissions = vi.hoisted(() => ({ denyPriority: false }));
vi.mock("@/modules/auth/roles", async importOriginal => {
  const original = await importOriginal<typeof import("@/modules/auth/roles")>();
  return { ...original, can: (role: Parameters<typeof original.can>[0], capability: Parameters<typeof original.can>[1]) => capability === "prioritize" && permissions.denyPriority ? false : original.can(role, capability),
    assertCan: (role: Parameters<typeof original.assertCan>[0], capability: Parameters<typeof original.assertCan>[1]) => {
      if (capability === "prioritize" && permissions.denyPriority) throw new original.ForbiddenError(role, capability);
      return original.assertCan(role, capability);
    } };
});
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value), delete: (name: string) => jar.delete(name) }),
  headers: async () => new Headers(),
}));
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { POST as modulePost } from "@/app/api/modules/route";
import { GET as priorityGet, POST as priorityPost } from "@/app/api/plan/route";
import { createGap, loadState, resetDemoSetup, saveProductSetup, setGapObjective } from "@/lib/iegp/store";
import { parsePlanningContext, setupContextFromState, setupIssues } from "@/lib/iegp/planning-context";
import { gapRecord } from "@/lib/iegp/gap-record";
import { withWorkspaceTransaction } from "@/lib/iegp/db";
import { db, sharedDb } from "@/modules/kernel/db";
import { sql } from "drizzle-orm";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createSession } from "@/modules/auth/session";
import { listPlacements, setPlacement } from "@/modules/stages/s8-prioritization/module";
import { entityHistory } from "@/lib/iegp/entity-history";
import { priorityDecision } from "./support/priority-decision";
import { ideationBandOrder } from "@/modules/stages/s9-ideation/module";

const actor = { name: "Context Editor", function: "medical_affairs" } as const;
const auditActor = { actor_name: actor.name, actor_function: actor.function };
const owner = `kan130-${Date.now()}@example.com`;
let workspace: Workspace;
const scoped = <T>(fn: () => PromiseLike<T>): Promise<T> => withWorkspace(workspace.id, async () => await fn());
async function post(body: Record<string, unknown>, priority = false) {
  return scoped(async () => {
    const response = await (priority ? priorityPost : POST)(new Request("http://localhost/api/iegp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...auditActor, ...body }),
    }));
    return { status: response.status, body: await response.json() };
  });
}
const context = () => scoped(async () => setupContextFromState(await loadState()));
const placements = () => scoped(listPlacements);
async function fixture() {
  await scoped(resetDemoSetup);
  const state = await scoped(loadState);
  const ctx = parsePlanningContext({ asset_name: state.asset.name, objectives: state.objectives });
  const saved = await post({ action: "save_product_setup", context: ctx, reason: "Record original objective context" });
  expect(saved.status).toBe(200);
  const ids = await scoped(async () => {
    const ids: string[] = [];
    for (const settings of [["1L"], ["2L"], ["1L"], ["2L"]]) {
      ids.push(await createGap({ ...auditActor, statement: `Missing evidence ${ids.length}`, settings, objective_id: ctx.objectives[0]!.id }));
    }
    await setGapObjective({ ...auditActor, gap_id: ids[3]!, expected_objective_id: ctx.objectives[0]!.id, objective_id: ctx.objectives[1]!.id, rationale: "Unrelated objective" });
    await db().execute(sql`UPDATE gaps SET computed_status = 'validated_open', status = 'validated_open', human_validated = true`);
    for (const gap_id of ids) await setPlacement({ gap_id, actor, band: "high", validate: true, axis_scores: { decision_impact: 80, time_pressure: 70 }, rationale: "Retain original judgement", ...await priorityDecision(gap_id, "Initial priority review") });
    await db().execute(sql`UPDATE gaps SET computed_status = 'addressed', status = 'addressed' WHERE id = ${ids[2]!}`);
    return ids;
  });
  return { ids, ctx: await context() };
}
beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: "KAN130 objective context", owner });
  const session = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: actor.name, actor_function: actor.function, role: "medical_affairs" });
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
}, 60_000);
afterAll(async () => {
  if (workspace) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  jar.clear(); vi.unstubAllEnvs();
});

describe("objective dates and shared priority review", () => {
  it("keeps evidence deadlines unknown on older contexts and rejects calendar overflow and malformed dates", () => {
    const legacy = parsePlanningContext({ objectives: [{ name: "Decision", decision_date: "2028-06-30" }] });
    expect(legacy.objectives[0]!.evidence_needed_by).toBe("");
    for (const date of ["2027-02-29", "2028-02-30", "2028-06-10garbage", "2028-13-01"]) {
      const ctx = parsePlanningContext({ objectives: [{ name: "Decision", evidence_needed_by: date }] });
      expect(setupIssues(ctx, { required: false }).some(issue => issue.field === "objectives.0.evidence_needed_by")).toBe(true);
    }
    const unusual = parsePlanningContext({ objectives: [{ name: "Decision", evidence_needed_by: "2028-07-01", decision_date: "2028-06-30" }] });
    expect(setupIssues(unusual, { required: false })).toEqual([]);
  });

  it("saves a reason without references, reviews all linked Open gaps, retains judgement and reads shared objective history", async () => {
    const { ids, ctx } = await fixture();
    const prior = await placements();
    ctx.objectives[0]!.evidence_needed_by = "2028-07-01";
    ctx.objectives[0]!.decision_date = "2028-06-30";
    const saved = await post({ action: "save_product_setup", context: ctx, reason: "Papers follow the committee meeting by agreement" });
    expect(saved.status).toBe(200);
    expect(saved.body.context.objectives[0]).toMatchObject({ evidence_needed_by: "2028-07-01", decision_date: "2028-06-30" });
    const after = await placements();
    for (const id of ids.slice(0, 2)) {
      expect(after.find(p => p.gap_id === id)).toMatchObject({ validated: false, needs_review: true, band: "high", rationale: "Retain original judgement", axis_scores: { decision_impact: 80, time_pressure: 70 } });
      expect(ideationBandOrder(after).has(id)).toBe(false);
      const record = await scoped(() => gapRecord(id));
      const event = record!.history.find(entry => entry.entity_type === "objective" && entry.field === "evidence_needed_by");
      expect(event).toMatchObject({ before: null, after: "2028-07-01", rationale: "Papers follow the committee meeting by agreement", actor_name: actor.name, shared_context: true });
      expect(event!.actor_principal).toBe(owner);
      expect(event!.at).toBeTruthy();
    }
    for (const id of ids.slice(2)) expect(after.find(p => p.gap_id === id)).toEqual(prior.find(p => p.gap_id === id));
    const old = prior.find(p => p.gap_id === ids[0])!;
    const stale = await post({ action: "validate_band", gap_id: old.gap_id, band: "high", reason: "Stale reviewer", expected_version: old.version }, true);
    expect(stale.status).toBe(400);
    const latest = after.find(p => p.gap_id === old.gap_id)!;
    const confirmed = await post({ action: "validate_band", gap_id: old.gap_id, band: "high", reason: "Reviewed changed committee context", expected_version: latest.version }, true);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.placement).toMatchObject({ needs_review: false, validated: true, rationale: old.rationale });
    expect(ideationBandOrder(await placements()).has(old.gap_id)).toBe(true);
  });

  it("audits name and note changes without review, ignores a no-op and rejects missing reasons or invalid dates", async () => {
    const { ids, ctx } = await fixture();
    const before = await placements();
    ctx.objectives[0]!.name += " revised label";
    expect((await post({ action: "save_product_setup", context: ctx })).status).toBe(400);
    const saved = await post({ action: "save_product_setup", context: ctx, reason: "Clarify the objective label" });
    expect(saved.status).toBe(200);
    expect(await placements()).toEqual(before);
    const history = await scoped(() => entityHistory([ctx.objectives[0]!.id]));
    const noop = await post({ action: "save_product_setup", context: saved.body.context });
    expect(noop.status).toBe(200);
    expect(await scoped(() => entityHistory([ctx.objectives[0]!.id]))).toEqual(history);
    const invalid = structuredClone(saved.body.context);
    invalid.objectives[0].evidence_needed_by = "2027-02-29";
    expect((await post({ action: "save_product_setup", context: invalid, reason: "Correct the date" })).status).toBe(400);
    expect(await placements()).toEqual(before);
    expect((await scoped(() => gapRecord(ids[0]!)))!.objective!.evidence_needed_by).toBeNull();
    const note = structuredClone(saved.body.context);
    note.objectives[0].description += " Context note";
    expect((await post({ action: "save_product_setup", context: note, reason: "Add explanatory notes" })).status).toBe(200);
    expect(await placements()).toEqual(before);
  });

  it("rejects stale concurrent Setup saves and safely orders objective changes with confirmation and reassignment", async () => {
    const { ids, ctx } = await fixture();
    const copies = ["2028-06-10", "2028-06-11"].map(date => {
      const copy = structuredClone(ctx); copy.objectives[0]!.evidence_needed_by = date; return copy;
    });
    const saves = await Promise.all(copies.map(copy => post({ action: "save_product_setup", context: copy, reason: "Update shared paper deadline" })));
    expect(saves.map(r => r.status).sort()).toEqual([200, 400]);
    expect(saves.find(r => r.status === 400)!.body.error).toMatch(/context changed/i);
    const latest = (await placements()).find(p => p.gap_id === ids[0])!;
    const current = await context(); current.objectives[0]!.key_decision += " next meeting";
    const [change, review] = await Promise.all([
      post({ action: "save_product_setup", context: current, reason: "Committee changed the decision" }),
      post({ action: "validate_band", gap_id: latest.gap_id, band: "high", reason: "Review committee context", expected_version: latest.version }, true),
    ]);
    expect(change.status).toBe(200);
    expect([200, 400]).toContain(review.status);
    expect((await placements()).find(p => p.gap_id === latest.gap_id)!.validated).toBe(false);
    const next = await context(); next.objectives[1]!.decision_date = "2029-01-01";
    await Promise.all([
      post({ action: "save_product_setup", context: next, reason: "Reschedule the other decision" }),
      scoped(() => setGapObjective({ ...auditActor, gap_id: ids[1]!, expected_objective_id: next.objectives[0]!.id, objective_id: next.objectives[1]!.id, rationale: "Evidence now serves the other decision" })),
    ]);
    expect((await placements()).find(p => p.gap_id === ids[1])!.validated).toBe(false);
  });

  it.each(["objectives", "assets", "gaps", "priority_placements", "edit_records", "public.audit_events"])("rolls back context, priority and history if %s persistence fails, including direct store callers", async table => {
    const { ctx } = await fixture();
    const state = await scoped(loadState), before = await placements();
    const history = await scoped(() => entityHistory([ctx.objectives[0]!.id, ...state.gaps.map(g => g.id)]));
    await scoped(async () => {
      await db().execute(sql.raw("CREATE FUNCTION fail_objective_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN130 injected failure'; END $$"));
      await db().execute(sql.raw(`CREATE TRIGGER fail_objective_save BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW ${table === "public.audit_events" ? `WHEN (NEW.workspace_id = '${workspace.id}')` : ""} EXECUTE FUNCTION fail_objective_save()`));
    });
    try {
      ctx.objectives[0]!.decision_date = "2029-12-01";
      await expect(scoped(() => saveProductSetup({ ...auditActor, context: ctx, reason: "Move the committee decision" }))).rejects.toThrow();
      expect(await scoped(loadState)).toEqual(state);
      expect(await placements()).toEqual(before);
      expect(await scoped(() => entityHistory([ctx.objectives[0]!.id, ...state.gaps.map(g => g.id)]))).toEqual(history);
    } finally {
      await scoped(async () => {
        await db().execute(sql.raw(`DROP TRIGGER IF EXISTS fail_objective_save ON ${table}`));
        await db().execute(sql.raw("DROP FUNCTION IF EXISTS fail_objective_save()"));
      });
    }
  });

  it("includes a concurrently created and confirmed gap in the final affected set", async () => {
    const { ctx } = await fixture();
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const created = new Promise<void>(resolve => { ready = resolve; });
    const creation = scoped(() => withWorkspaceTransaction(async () => {
      const id = await createGap({ ...auditActor, statement: "Concurrent evidence need", objective_id: ctx.objectives[0]!.id });
      await setPlacement({ gap_id: id, actor, band: "high", validate: true, reason: "Review concurrent gap", expected_version: null });
      ready();
      await waiting;
      return id;
    }));
    await created;
    ctx.objectives[0]!.decision_date = "2030-02-01";
    const save = post({ action: "save_product_setup", context: ctx, reason: "Move the shared decision" });
    let outcome;
    try {
      outcome = await Promise.race([save, new Promise<"waiting">(resolve => setTimeout(() => resolve("waiting"), 200))]);
    } finally { release(); }
    const id = await creation;
    expect((await save).status).toBe(200);
    expect(outcome).toBe("waiting");
    expect((await placements()).find(row => row.gap_id === id)).toMatchObject({ validated: false, needs_review: true, band: "high" });
  });

  it("rechecks an explicit objective assignment after a concurrent objective removal", async () => {
    const { ctx } = await fixture();
    const removed = ctx.objectives.pop()!;
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { ready = resolve; });
    const saving = scoped(() => withWorkspaceTransaction(async () => {
      await saveProductSetup({ ...auditActor, context: ctx, reason: "Remove the unused objective" });
      ready(); await waiting;
    }));
    await saved;
    const creation = scoped(() => createGap({ ...auditActor, statement: "Evidence for a removed objective", objective_id: removed.id }))
      .then(id => ({ id, error: "" }), error => ({ id: "", error: String(error.message) }));
    release();
    await saving;
    const result = await creation;
    expect(result.error).toMatch(/choose one of the plan's objectives/i);
    expect((await scoped(loadState)).gaps.some(gap => gap.statement === "Evidence for a removed objective")).toBe(false);
  });

  it("keeps the previous judgement and needs-review marker through a model rerun", async () => {
    const { ids, ctx } = await fixture();
    ctx.objectives[0]!.key_decision += " changed remit";
    expect((await post({ action: "save_product_setup", context: ctx, reason: "Committee remit changed" })).status).toBe(200);
    const before = (await placements()).find(row => row.gap_id === ids[0])!;
    const response = await scoped(() => modulePost(new Request("http://localhost/api/modules", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "S8", input: { gap_ids: [ids[0]], x_axis: "decision_impact", y_axis: "time_pressure" } }),
    })));
    expect(response.status, await response.text()).toBe(200);
    expect((await placements()).find(row => row.gap_id === ids[0])).toMatchObject({
      band: before.band, axis_scores: before.axis_scores, rationale: before.rationale,
      validated: false, needs_review: true, review_reason: "Committee remit changed", review_event_id: before.review_event_id,
    });
  });

  it.each(["validate_band", "set_placement"])("refuses a pre-edit first %s confirmation and accepts a refreshed context snapshot without inventing a placement", async action => {
    const { ctx } = await fixture();
    const gapId = await scoped(() => createGap({ ...auditActor, statement: "Unplaced gap awaiting review", objective_id: ctx.objectives[0]!.id }));
    const baseline = await scoped(async () => (await priorityGet()).json());
    const initialContextVersion = baseline.priority_context_versions?.[gapId] ?? null;
    ctx.objectives[0]!.decision_date = "2031-06-30";
    expect((await post({ action: "save_product_setup", context: ctx, reason: "Move the decision before the first priority review" })).status).toBe(200);
    const stale = await post({ action, validate: true, gap_id: gapId, band: "high", reason: "First decision based on the old context", expected_version: null, expected_context_version: initialContextVersion }, true);
    expect(stale.status).toBe(400);
    expect(stale.body.error).toMatch(/context changed/i);
    expect((await placements()).some(row => row.gap_id === gapId)).toBe(false);
    const missing = await post({ action, validate: true, gap_id: gapId, band: "high", reason: "Missing the reviewed context", expected_version: null }, true);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/context changed/i);
    const refreshed = await scoped(async () => (await priorityGet()).json());
    expect(refreshed.priority_context_versions[gapId]).toEqual(expect.any(String));
    expect(refreshed.priority_context_versions[gapId]).not.toBe(initialContextVersion);
    const accepted = await post({ action, validate: true, gap_id: gapId, band: "high", reason: "Reviewed the current decision context", expected_version: null, expected_context_version: refreshed.priority_context_versions[gapId] }, true);
    expect(accepted.status).toBe(200);
    expect(accepted.body.placement).toMatchObject({ validated: true, band: "high" });
  });

  it("refuses competing objective reassignments based on the same prior assignment", async () => {
    const { ids, ctx } = await fixture();
    const prior = ctx.objectives[0]!.id;
    const missingReason = await post({ action: "set_gap_objective", gap_id: ids[0], objective_id: ctx.objectives[1]!.id, expected_objective_id: prior });
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.error).toMatch(/rationale is required/i);
    const results = await Promise.all(ctx.objectives.slice(1, 3).map(objective => post({
      action: "set_gap_objective", gap_id: ids[0], objective_id: objective.id,
      expected_objective_id: prior, rationale: `Evidence now serves ${objective.name}`,
    })));
    expect(results.map(result => result.status).sort()).toEqual([200, 400]);
    expect(results.find(result => result.status === 400)!.body.error).toMatch(/objective assignment changed/i);
    const current = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    expect(ctx.objectives.slice(1, 3).map(objective => objective.id)).toContain(current.objective_id);
    const edits = (await scoped(() => entityHistory([ids[0]!]))).filter(entry => entry.field === "objective");
    expect(edits).toHaveLength(1);
    expect((await post({ action: "set_gap_objective", gap_id: ids[0], objective_id: prior, rationale: "Missing the reviewed assignment" })).status).toBe(400);
  });

  it("allows an authorised context editor when prioritisation permission is withheld, while reconfirmation remains forbidden", async () => {
    const { ids, ctx } = await fixture();
    ctx.objectives[0]!.key_decision += " revised remit";
    permissions.denyPriority = true;
    try {
      expect((await post({ action: "save_product_setup", context: ctx, reason: "Correct the committee remit" })).status).toBe(200);
      const latest = (await placements()).find(row => row.gap_id === ids[0])!;
      expect(latest).toMatchObject({ needs_review: true, validated: false });
      expect((await post({ action: "validate_band", gap_id: ids[0], band: "high", reason: "Try to reconfirm", expected_version: latest.version }, true)).status).toBe(403);
      expect((await placements()).find(row => row.gap_id === ids[0])).toEqual(latest);
    } finally { permissions.denyPriority = false; }
  });

  it("never reviews candidate, excluded, Partial, Addressed, parked or retired gaps", async () => {
    const { ids } = await fixture();
    const id = ids[2]!;
    const prior = (await placements()).find(row => row.gap_id === id)!;
    const cases = [
      { status: "candidate", retired: false, parked: null },
      { status: "excluded", retired: false, parked: null },
      { status: "validated_partial", retired: false, parked: null },
      { status: "validated_addressed", retired: false, parked: null },
      { status: "validated_open", retired: false, parked: "2026-10-16" },
      { status: "validated_open", retired: true, parked: null },
    ];
    for (const [index, item] of cases.entries()) {
      await scoped(() => db().execute(sql`UPDATE gaps SET status = ${item.status}, computed_status = ${item.status}, retired = ${item.retired}, parked_at = ${item.parked} WHERE id = ${id}`));
      const ctx = await context(); ctx.objectives[0]!.evidence_needed_by = `2028-06-${10 + index}`;
      expect((await post({ action: "save_product_setup", context: ctx, reason: "Update the shared deadline" })).status).toBe(200);
      expect((await placements()).find(row => row.gap_id === id)).toEqual(prior);
    }
  });

  it("rejects a foreign objective id without mutating either workspace", async () => {
    const { ctx } = await fixture();
    const other = await createWorkspace({ name: "KAN130 other workspace", owner });
    try {
      const foreign = await withWorkspace(other.id, async () => {
        await resetDemoSetup();
        return await saveProductSetup({ ...auditActor, context: parsePlanningContext({ objectives: [{ name: "Foreign objective", decision_date: "2030-01-01" }] }), reason: "Initial foreign context" });
      });
      const before = await scoped(loadState);
      const foreignBefore = await withWorkspace(other.id, loadState);
      ctx.objectives[0]!.id = foreign.objectives[0]!.id;
      const result = await post({ action: "save_product_setup", context: ctx, reason: "Try a foreign assignment" });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/objective context changed/i);
      expect(await scoped(loadState)).toEqual(before);
      expect(await withWorkspace(other.id, loadState)).toEqual(foreignBefore);
    } finally { await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${other.schema_name}" CASCADE`)); }
  });

  it("denies a read-only member before changing context or confirmation", async () => {
    const { ctx } = await fixture();
    const session = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: actor.name, actor_function: actor.function, role: "viewer" });
    jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
    ctx.objectives[0]!.decision_date = "2030-01-01";
    const before = await scoped(loadState);
    expect((await post({ action: "save_product_setup", context: ctx, reason: "Not permitted" })).status).toBe(403);
    expect(await scoped(loadState)).toEqual(before);
  });
});
