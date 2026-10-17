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
import { POST as priorityPost } from "@/app/api/plan/route";
import { createGap, modifyGap, setGapMetadata, setGapSettings, loadState, resetDemoSetup, saveProductSetup, setGapObjective } from "@/lib/iegp/store";
import { parsePlanningContext, setupContextFromState } from "@/lib/iegp/planning-context";
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
const owner = `kan131-${Date.now()}@example.com`;
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
    await setGapObjective({ ...auditActor, gap_id: ids[3]!, expected_gap: (await loadState()).gaps.find(gap => gap.id === ids[3]), expected_objective_id: ctx.objectives[0]!.id, objective_id: ctx.objectives[1]!.id, rationale: "Unrelated objective" });
    await db().execute(sql`UPDATE gaps SET computed_status = 'validated_open', status = 'validated_open', human_validated = true`);
    for (const gap_id of ids) await setPlacement({ gap_id, actor, band: "high", validate: true, axis_scores: { decision_impact: 80, time_pressure: 70 }, rationale: "Retain original judgement", ...await priorityDecision(gap_id, "Initial priority review") });
    await db().execute(sql`UPDATE gaps SET computed_status = 'addressed', status = 'addressed' WHERE id = ${ids[2]!}`);
    return ids;
  });
  return { ids, ctx: await context() };
}
beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: "KAN131 direct gap edits", owner });
  const session = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: actor.name, actor_function: actor.function, role: "medical_affairs" });
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
}, 60_000);
afterAll(async () => {
  if (workspace) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  jar.clear(); vi.unstubAllEnvs();
});

describe("audited direct gap edits", () => {
  it("reviews only the edited Open gap after a statement change, preserving judgement and attributable history", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const before = await placements();
    const result = await post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, statement: "Missing long-term comparative survival evidence", rationale: "Clarify the evidence required for this decision" });
    expect(result.status).toBe(200);
    const after = await placements();
    expect(after.find(row => row.gap_id === gap.id)).toMatchObject({ validated: false, needs_review: true, band: "high", axis_scores: { decision_impact: 80, time_pressure: 70 }, rationale: "Retain original judgement" });
    expect(ideationBandOrder(after).has(gap.id)).toBe(false);
    for (const id of ids.slice(1)) expect(after.find(row => row.gap_id === id)).toEqual(before.find(row => row.gap_id === id));
    const record = (await scoped(() => gapRecord(gap.id)))!;
    expect(record.gap.statement).toBe("Missing long-term comparative survival evidence");
    expect(record.history.find(entry => entry.field === "statement")).toMatchObject({ before: gap.statement, after: record.gap.statement, rationale: "Clarify the evidence required for this decision", actor_name: actor.name, actor_principal: owner });
  });
  it("requires reasons for note edits, rejects stale notes and audits no-op-free saves without priority review", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const before = await placements();
    const payload = { action: "set_gap_metadata", gap_id: gap.id, expected_metadata: gap.metadata, metadata: { ...gap.metadata, notes: "Ask the evidence committee" } };
    expect((await post(payload, true)).status).toBe(400);
    expect((await post({ ...payload, rationale: "Record the committee follow-up" }, true)).status).toBe(200);
    const history = await scoped(() => entityHistory([gap.id]));
    expect(history.find(entry => entry.field === "metadata.notes")).toMatchObject({ after: "Ask the evidence committee", rationale: "Record the committee follow-up", actor_principal: owner });
    expect((await post({ ...payload, metadata: { notes: "Stale overwrite" }, rationale: "Old notes draft" }, true)).status).toBe(400);
    const current = (await scoped(loadState)).gaps.find(row => row.id === gap.id)!;
    expect((await post({ ...payload, metadata: current.metadata, expected_metadata: current.metadata }, true)).status).toBe(200);
    expect(await scoped(() => entityHistory([gap.id]))).toEqual(history);
    expect(await placements()).toEqual(before);
  });

  it("requires a reason for setting tags, retains priority and rejects stale setting saves", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const before = await placements();
    const payload = { action: "set_gap_settings", gap_id: gap.id, expected_settings: gap.settings, settings: ["2L"] };
    expect((await post(payload, true)).status).toBe(400);
    expect((await post({ ...payload, rationale: "Correct the treatment setting" }, true)).status).toBe(200);
    expect((await post({ ...payload, settings: ["3L"], rationale: "Old setting draft" }, true)).status).toBe(400);
    expect(await placements()).toEqual(before);
    const history = await scoped(() => entityHistory([gap.id]));
    expect(history.find(entry => entry.field === "settings")).toMatchObject({ before: "1L", after: "2L", rationale: "Correct the treatment setting", actor_principal: owner });
  });

  it("audits name-only and domain edits without review and creates no entries for unchanged submissions", async () => {
    const { ids } = await fixture();
    let gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const before = await placements();
    expect((await post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, name: "Clearer display name" })).status).toBe(400);
    expect((await post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, name: "Clearer display name", domain: "safety", rationale: "Clarify the label and evidence domain" })).status).toBe(200);
    gap = (await scoped(loadState)).gaps.find(row => row.id === gap.id)!;
    const history = await scoped(() => entityHistory([gap.id]));
    expect(history.find(entry => entry.field === "name")).toMatchObject({ before: "Missing evidence 0", after: "Clearer display name", rationale: "Clarify the label and evidence domain", actor_principal: owner });
    expect((await post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, name: gap.name, statement: gap.statement, rationale: "Nothing changed" })).status).toBe(400);
    expect(await scoped(() => entityHistory([gap.id]))).toEqual(history);
    expect(await placements()).toEqual(before);
  });

  it("rejects stale competing direct writes and old submissions after objective assignment or decision context changes", async () => {
    const { ids, ctx } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const payload = { action: "modify_gap", gap_id: gap.id, expected_gap: gap, rationale: "Clarify the missing evidence" };
    const results = await Promise.all(["Long-term safety data", "Comparative survival data"].map(statement => post({ ...payload, statement })));
    expect(results.map(result => result.status).sort()).toEqual([200, 400]);
    const current = (await scoped(loadState)).gaps.find(row => row.id === gap.id)!;
    expect((await scoped(() => entityHistory([gap.id]))).filter(entry => entry.field === "statement")).toHaveLength(1);
    expect((await post({ ...payload, expected_gap: undefined, name: "Missing snapshot" })).status).toBe(400);
    expect((await post({ action: "set_gap_objective", gap_id: gap.id, expected_gap: current, objective_id: ctx.objectives[1]!.id, expected_objective_id: current.objective_id, rationale: "Evidence now serves another decision" })).status).toBe(200);
    expect((await post({ ...payload, expected_gap: current, statement: "Old assignment draft" })).status).toBe(400);
    const reassigned = (await scoped(loadState)).gaps.find(row => row.id === gap.id)!;
    const contextCopy = await context(); contextCopy.objectives[1]!.key_decision = "A changed linked decision";
    expect((await post({ action: "save_product_setup", context: contextCopy, reason: "Changed committee remit" })).status).toBe(200);
    const rejected = await post({ ...payload, expected_gap: reassigned, name: "Old context draft" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/linked objective context changed/i);
  });

  it.each(["key_decision", "evidence_needed_by"] as const)("rejects objective reassignment after a saved linked-objective %s change and accepts refreshed context", async field => {
    const { ids, ctx } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(row => row.id === ids[0])!;
    const payload = { action: "set_gap_objective", gap_id: gap.id, expected_gap: gap, expected_objective_id: gap.objective_id, objective_id: ctx.objectives[1]!.id, rationale: "Evidence now serves the other committee" };
    ctx.objectives[0]![field] = field === "key_decision" ? "Changed linked committee decision" : "2030-05-01";
    expect((await post({ action: "save_product_setup", context: ctx, reason: "Update the linked committee context" })).status).toBe(200);
    const before = await scoped(loadState), prior = await placements();
    const history = await scoped(() => entityHistory([gap.id]));
    const refused = await post(payload);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/linked objective context changed/i);
    expect(await scoped(loadState)).toEqual(before);
    expect(await placements()).toEqual(prior);
    expect(await scoped(() => entityHistory([gap.id]))).toEqual(history);
    const refreshed = before.gaps.find(row => row.id === gap.id)!;
    expect(refreshed.objective_id).toBe(gap.objective_id);
    expect(refreshed.priority_context_version).not.toBe(gap.priority_context_version);
    const missing = await post({ ...payload, expected_gap: undefined });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/snapshot is missing/i);
    expect(await scoped(() => entityHistory([gap.id]))).toEqual(history);
    expect((await post({ ...payload, expected_gap: refreshed })).status).toBe(200);
    const record = (await scoped(() => gapRecord(gap.id)))!;
    expect(record.gap.objective_id).toBe(ctx.objectives[1]!.id);
    expect(record.history.find(entry => entry.field === "objective")).toMatchObject({ rationale: payload.rationale, actor_principal: owner });
    expect((await placements()).find(row => row.gap_id === gap.id)).toMatchObject({ band: "high", validated: false, needs_review: true, rationale: "Retain original judgement" });
  });

  it("rejects objective reassignment that waited for a concurrent linked-objective context save", async () => {
    const { ids, ctx } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(row => row.id === ids[0])!;
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { ready = resolve; });
    ctx.objectives[0]!.decision_date = "2030-06-30";
    const saving = scoped(() => withWorkspaceTransaction(async () => {
      await saveProductSetup({ ...auditActor, context: ctx, reason: "Move the committee decision while reassignment is open" });
      ready(); await waiting;
    }));
    await saved;
    const payload = { action: "set_gap_objective", gap_id: gap.id, expected_gap: gap, expected_objective_id: gap.objective_id, objective_id: ctx.objectives[1]!.id, rationale: "Reassign using the previously reviewed context" };
    const edit = post(payload);
    let outcome;
    try { outcome = await Promise.race([edit, new Promise<"waiting">(resolve => setTimeout(() => resolve("waiting"), 150))]); }
    finally { release(); }
    await saving;
    expect(outcome).toBe("waiting");
    const refused = await edit;
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/linked objective context changed/i);
    const current = (await scoped(loadState)).gaps.find(row => row.id === gap.id)!;
    expect(current.objective_id).toBe(gap.objective_id);
    const history = await scoped(() => entityHistory([gap.id]));
    expect(history.filter(entry => entry.field === "objective")).toHaveLength(0);
    expect(history.filter(entry => entry.field === "priority_context")).toHaveLength(1);
    expect((await post({ ...payload, expected_gap: current })).status).toBe(200);
    expect((await scoped(() => entityHistory([gap.id]))).filter(entry => entry.field === "objective")).toHaveLength(1);
  });

  it.each([
    ["candidate", "modify_gap"], ["candidate", "set_gap_objective"],
    ["addressed", "modify_gap"], ["addressed", "set_gap_objective"],
    ["parked", "modify_gap"], ["parked", "set_gap_objective"],
  ] as const)("rejects stale linked context for %s %s edits and accepts refreshed input without priority review", async (kind, action) => {
    const { ids, ctx } = await fixture();
    const id = ids[0]!;
    const status = kind === "parked" ? "validated_open" : kind === "addressed" ? "validated_addressed" : "candidate";
    const parked = kind === "parked" ? "2026-10-16" : null;
    await scoped(() => db().execute(sql`UPDATE gaps SET status = ${status}, computed_status = ${status}, parked_at = ${parked} WHERE id = ${id}`));
    const gap = (await scoped(loadState)).gaps.find(row => row.id === id)!;
    const previousJudgement = (await placements()).find(row => row.gap_id === id)!;
    const previousHistory = await scoped(() => entityHistory([id]));
    ctx.objectives[0]!.key_decision = "Updated decision while a non-Open gap is being edited";
    expect((await post({ action: "save_product_setup", context: ctx, reason: "Update the linked committee decision" })).status).toBe(200);
    const before = await scoped(loadState), priorities = await placements();
    const history = await scoped(() => entityHistory([id]));
    expect(priorities.find(row => row.gap_id === id)).toEqual(previousJudgement);
    expect(history).toEqual(previousHistory);
    const payload = { action, gap_id: id, expected_gap: gap, expected_objective_id: gap.objective_id, objective_id: ctx.objectives[1]!.id, statement: "Revised evidence request for the committee", rationale: "Review the revised committee context" };
    const refused = await post(payload);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/linked objective context changed/i);
    expect(await scoped(loadState)).toEqual(before);
    expect(await placements()).toEqual(priorities);
    expect(await scoped(() => entityHistory([id]))).toEqual(history);
    const refreshed = before.gaps.find(row => row.id === id)!;
    expect(refreshed.priority_context_version).not.toBe(gap.priority_context_version);
    expect((await post({ ...payload, expected_gap: refreshed })).status).toBe(200);
    const current = (await scoped(loadState)).gaps.find(row => row.id === id)!;
    expect(action === "modify_gap" ? current.statement : current.objective_id).toBe(action === "modify_gap" ? payload.statement : payload.objective_id);
    expect((await placements()).find(row => row.gap_id === id)).toEqual(previousJudgement);
    const afterHistory = await scoped(() => entityHistory([id]));
    expect(afterHistory.filter(entry => entry.field === "priority_context")).toEqual(history.filter(entry => entry.field === "priority_context"));
    expect(afterHistory.filter(entry => entry.field === (action === "modify_gap" ? "statement" : "objective"))).toHaveLength(1);
  });

  it.each(["candidate", "addressed", "parked"] as const)("rejects both %s edits waiting for a linked-context save without altering its judgement or history", async kind => {
    const { ids, ctx } = await fixture();
    const id = ids[0]!;
    const status = kind === "parked" ? "validated_open" : kind === "addressed" ? "validated_addressed" : "candidate";
    const parked = kind === "parked" ? "2026-10-16" : null;
    await scoped(() => db().execute(sql`UPDATE gaps SET status = ${status}, computed_status = ${status}, parked_at = ${parked} WHERE id = ${id}`));
    const gap = (await scoped(loadState)).gaps.find(row => row.id === id)!;
    const prior = (await placements()).find(row => row.gap_id === id)!;
    const history = await scoped(() => entityHistory([id]));
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { ready = resolve; });
    ctx.objectives[0]!.decision_date = "2031-06-30";
    const saving = scoped(() => withWorkspaceTransaction(async () => {
      await saveProductSetup({ ...auditActor, context: ctx, reason: "Move the linked decision during non-Open editing" });
      ready(); await waiting;
    }));
    await saved;
    const edits = Promise.all([
      post({ action: "modify_gap", gap_id: id, expected_gap: gap, statement: "Stale non-Open statement draft", rationale: "Previously reviewed decision context" }),
      post({ action: "set_gap_objective", gap_id: id, expected_gap: gap, expected_objective_id: gap.objective_id, objective_id: ctx.objectives[1]!.id, rationale: "Previously reviewed assignment context" }),
    ]);
    let outcome;
    try { outcome = await Promise.race([edits, new Promise<"waiting">(resolve => setTimeout(() => resolve("waiting"), 150))]); }
    finally { release(); }
    await saving;
    expect(outcome).toBe("waiting");
    for (const refused of await edits) {
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/linked objective context changed/i);
    }
    const current = (await scoped(loadState)).gaps.find(row => row.id === id)!;
    expect(current.objective_id).toBe(gap.objective_id);
    expect(current.statement).toBe(gap.statement);
    expect(current.priority_context_version).not.toBe(gap.priority_context_version);
    expect((await placements()).find(row => row.gap_id === id)).toEqual(prior);
    expect(await scoped(() => entityHistory([id]))).toEqual(history);
  });

  it("advances candidate, Addressed and parked edit snapshots without synthesizing placements or priority history", async () => {
    const { ctx } = await fixture();
    const snapshots = [];
    for (const kind of ["candidate", "addressed", "parked"] as const) {
      const id = await scoped(() => createGap({ ...auditActor, statement: `Unplaced ${kind} evidence request`, objective_id: ctx.objectives[0]!.id }));
      const status = kind === "parked" ? "validated_open" : kind === "addressed" ? "validated_addressed" : "candidate";
      const parked = kind === "parked" ? "2026-10-16" : null;
      await scoped(() => db().execute(sql`UPDATE gaps SET status = ${status}, computed_status = ${status}, parked_at = ${parked} WHERE id = ${id}`));
      snapshots.push({ gap: (await scoped(loadState)).gaps.find(row => row.id === id)!, history: await scoped(() => entityHistory([id])) });
    }
    ctx.objectives[0]!.evidence_needed_by = "2031-05-01";
    expect((await post({ action: "save_product_setup", context: ctx, reason: "Move the shared evidence deadline" })).status).toBe(200);
    const state = await scoped(loadState), priorities = await placements();
    for (const snapshot of snapshots) {
      expect(state.gaps.find(row => row.id === snapshot.gap.id)!.priority_context_version).not.toBe(snapshot.gap.priority_context_version);
      expect(priorities.some(row => row.gap_id === snapshot.gap.id)).toBe(false);
      expect(await scoped(() => entityHistory([snapshot.gap.id]))).toEqual(snapshot.history);
    }
  });

  it("waits for a simultaneous linked-objective edit before checking the submitted snapshot", async () => {
    const { ids, ctx } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { ready = resolve; });
    ctx.objectives[0]!.key_decision = "Revised concurrent decision";
    const saving = scoped(() => withWorkspaceTransaction(async () => {
      await saveProductSetup({ ...auditActor, context: ctx, reason: "Committee remit changed during gap editing" });
      ready(); await waiting;
    }));
    await saved;
    const edit = post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, statement: "Stale simultaneous gap draft", rationale: "Based on the previous committee decision" });
    let outcome;
    try { outcome = await Promise.race([edit, new Promise<"waiting">(resolve => setTimeout(() => resolve("waiting"), 150))]); }
    finally { release(); }
    await saving;
    expect(outcome).toBe("waiting");
    expect((await edit).status).toBe(400);
    expect((await scoped(() => gapRecord(gap.id)))!.gap.statement).toBe(gap.statement);
  });

  it.each(["set_gap_metadata", "set_gap_settings"])("serializes %s with Setup without a lock upgrade deadlock", async action => {
    const { ids, ctx } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { ready = resolve; });
    ctx.objectives[0]!.decision_date = "2030-06-30";
    const saving = scoped(() => withWorkspaceTransaction(async () => {
      await saveProductSetup({ ...auditActor, context: ctx, reason: "Move the shared decision date" });
      ready(); await waiting;
    }));
    await saved;
    const edit = post({ action, gap_id: gap.id, expected_metadata: gap.metadata, expected_settings: gap.settings, metadata: { notes: "Concurrent committee note" }, settings: ["3L"], rationale: "Correct details while Setup is saving" }, true);
    let outcome;
    try { outcome = await Promise.race([edit, new Promise<"waiting">(resolve => setTimeout(() => resolve("waiting"), 150))]); }
    finally { release(); }
    await saving;
    expect(outcome).toBe("waiting");
    expect((await edit).status).toBe(200);
    expect((await placements()).find(row => row.gap_id === gap.id)).toMatchObject({ validated: false, needs_review: true });
  });

  it("orders concurrent priority reconfirmation with a statement change and refuses old first decisions for unplaced gaps", async () => {
    const { ids, ctx } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const before = (await placements()).find(row => row.gap_id === gap.id)!;
    const [change, confirmation] = await Promise.all([
      post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, statement: "Long-term comparative evidence", rationale: "Decision needs a longer follow-up" }),
      post({ action: "validate_band", gap_id: gap.id, band: "high", reason: "Reviewing the previous gap meaning", expected_version: before.version }, true),
    ]);
    expect(change.status).toBe(200);
    expect([200, 400]).toContain(confirmation.status);
    const latest = (await placements()).find(row => row.gap_id === gap.id)!;
    expect(latest).toMatchObject({ validated: false, needs_review: true });
    expect((await post({ action: "validate_band", gap_id: gap.id, band: "high", reason: "Reconfirmed for the revised statement", expected_version: latest.version }, true)).status).toBe(200);
    expect(ideationBandOrder(await placements()).has(gap.id)).toBe(true);
    const id = await scoped(() => createGap({ ...auditActor, statement: "Unplaced gap", objective_id: ctx.objectives[0]!.id }));
    const unplaced = (await scoped(loadState)).gaps.find(row => row.id === id)!;
    expect((await post({ action: "modify_gap", gap_id: id, expected_gap: unplaced, statement: "Unplaced revised statement", rationale: "Clarify before the first priority review" })).status).toBe(200);
    const stale = await post({ action: "set_placement", gap_id: id, band: "high", validate: true, reason: "First judgement on the previous statement", expected_version: null, expected_context_version: unplaced.priority_context_version ?? null }, true);
    expect(stale.status).toBe(400);
    expect(stale.body.error).toMatch(/context changed/i);
    expect((await placements()).some(row => row.gap_id === id)).toBe(false);
  });

  it("applies the same snapshot and review behavior through the S5 edit entry point", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const response = await scoped(() => modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S5", input: { action: "edit_gap", gap_id: gap.id, expected_gap: gap, statement: "Evidence restated through validation", rationale: "Clarify the committee evidence request" } }) })));
    expect(response.status, await response.text()).toBe(200);
    expect((await placements()).find(row => row.gap_id === gap.id)).toMatchObject({ validated: false, needs_review: true });
  });

  it("rolls back an S5 direct edit if its gate history fails after the gap mutation", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const before = await scoped(loadState), prior = await placements();
    const history = await scoped(() => entityHistory([gap.id]));
    await scoped(async () => {
      await db().execute(sql.raw("CREATE FUNCTION fail_gap_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN131 gate history failure'; END $$"));
      await db().execute(sql.raw("CREATE TRIGGER fail_gap_gate BEFORE INSERT ON edit_records FOR EACH ROW WHEN (NEW.stage = 'S5') EXECUTE FUNCTION fail_gap_gate()"));
    });
    try {
      const response = await scoped(() => modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S5", input: { action: "edit_gap", gap_id: gap.id, expected_gap: gap, statement: "Failed gate evidence edit", rationale: "Gate history must save with the change" } }) })));
      expect(response.ok).toBe(false);
      expect(await scoped(loadState)).toEqual(before);
      expect(await placements()).toEqual(prior);
      expect(await scoped(() => entityHistory([gap.id]))).toEqual(history);
    } finally {
      await scoped(async () => {
        await db().execute(sql.raw("DROP TRIGGER IF EXISTS fail_gap_gate ON edit_records"));
        await db().execute(sql.raw("DROP FUNCTION IF EXISTS fail_gap_gate()"));
      });
    }
  });

  it.each(["gaps", "priority_placements", "edit_records", "public.audit_events"])("rolls back the gap, priority and history when %s persistence fails", async table => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const before = await scoped(loadState), prior = await placements();
    const history = await scoped(() => entityHistory([gap.id]));
    await scoped(async () => {
      await db().execute(sql.raw("CREATE FUNCTION fail_gap_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN131 injected failure'; END $$"));
      await db().execute(sql.raw(`CREATE TRIGGER fail_gap_save BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW ${table === "public.audit_events" ? `WHEN (NEW.workspace_id = '${workspace.id}')` : ""} EXECUTE FUNCTION fail_gap_save()`));
    });
    try {
      await expect(scoped(() => modifyGap({ ...auditActor, gap_id: gap.id, expected_gap: gap, statement: "Failed evidence rewrite", rationale: "Reason for failed direct save" }))).rejects.toThrow();
      await expect(scoped(() => setGapObjective({ ...auditActor, gap_id: gap.id, expected_gap: gap, expected_objective_id: gap.objective_id, objective_id: before.objectives.find(objective => objective.id !== gap.objective_id)!.id, rationale: "Reason for failed objective reassignment" }))).rejects.toThrow();
      if (table !== "priority_placements") {
        await expect(scoped(() => setGapMetadata({ ...auditActor, gap_id: gap.id, expected_metadata: gap.metadata, metadata: { notes: "Failed note" }, rationale: "Reason for failed metadata save" }))).rejects.toThrow();
        await expect(scoped(() => setGapSettings({ ...auditActor, gap_id: gap.id, expected_settings: gap.settings, settings: ["3L"], rationale: "Reason for failed setting save" }))).rejects.toThrow();
      }
      expect(await scoped(loadState)).toEqual(before);
      expect(await placements()).toEqual(prior);
      expect(await scoped(() => entityHistory([gap.id]))).toEqual(history);
    } finally {
      await scoped(async () => {
        await db().execute(sql.raw(`DROP TRIGGER IF EXISTS fail_gap_save ON ${table}`));
        await db().execute(sql.raw("DROP FUNCTION IF EXISTS fail_gap_save()"));
      });
    }
  });

  it("lets a gap editor trigger review without priority permission while refusing replacement judgement", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    permissions.denyPriority = true;
    try {
      expect((await post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, statement: "Corrected evidence request", rationale: "Correct the committee request" })).status).toBe(200);
      const latest = (await placements()).find(row => row.gap_id === gap.id)!;
      expect(latest.needs_review).toBe(true);
      expect((await post({ action: "validate_band", gap_id: gap.id, band: "high", expected_version: latest.version, reason: "Unauthorised replacement priority" }, true)).status).toBe(403);
    } finally { permissions.denyPriority = false; }
  });

  it("does not invalidate a non-Open gap when its statement changes", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[2])!;
    const prior = (await placements()).find(row => row.gap_id === gap.id)!;
    expect((await post({ action: "modify_gap", gap_id: gap.id, expected_gap: gap, statement: "Clarified addressed gap", rationale: "Improve the archived wording" })).status).toBe(200);
    expect((await placements()).find(row => row.gap_id === gap.id)).toEqual(prior);
  });

  it("rejects foreign gap/objective ids and read-only direct edits without changing saved state", async () => {
    const { ids } = await fixture();
    const gap = (await scoped(loadState)).gaps.find(gap => gap.id === ids[0])!;
    const other = await createWorkspace({ name: "KAN131 other workspace", owner });
    try {
      const foreign = await withWorkspace(other.id, async () => {
        await resetDemoSetup();
        // Make its gap id distinct from the current workspace's local ids.
        const id = "GAP-FOREIGN";
        const created = await createGap({ ...auditActor, statement: "Foreign workspace evidence" });
        const gap = (await loadState()).gaps.find(row => row.id === created)!;
        await db().execute(sql`UPDATE objectives SET id = 'OBJ-FOREIGN' WHERE id = ${gap.objective_id}`);
        await db().execute(sql`UPDATE gaps SET id = ${id}, objective_id = 'OBJ-FOREIGN' WHERE id = ${created}`);
        return (await loadState()).gaps.find(row => row.id === id)!;
      });
      const before = await scoped(loadState), foreignBefore = await withWorkspace(other.id, loadState);
      expect((await post({ action: "modify_gap", gap_id: foreign.id, expected_gap: foreign, statement: "Forbidden foreign rewrite", rationale: "Try another workspace" })).status).toBe(404);
      expect((await post({ action: "set_gap_objective", gap_id: gap.id, expected_gap: gap, expected_objective_id: gap.objective_id, objective_id: "OBJ-FOREIGN", rationale: "Try a foreign objective" })).status).toBe(400);
      expect(await scoped(loadState)).toEqual(before);
      expect(await withWorkspace(other.id, loadState)).toEqual(foreignBefore);
      const session = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: actor.name, actor_function: actor.function, role: "viewer" });
      jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
      try {
        for (const [payload, priority] of [
          [{ action: "modify_gap", expected_gap: gap, statement: "Forbidden read-only rewrite" }, false],
          [{ action: "set_gap_objective", expected_gap: gap, expected_objective_id: gap.objective_id, objective_id: gap.objective_id }, false],
          [{ action: "set_gap_metadata", expected_metadata: gap.metadata, metadata: { notes: "Forbidden note" } }, true],
          [{ action: "set_gap_settings", expected_settings: gap.settings, settings: ["4L"] }, true],
        ] as const) expect((await post({ ...payload, gap_id: gap.id, rationale: "Read-only edit attempt" }, priority)).status).toBe(403);
        expect(await scoped(loadState)).toEqual(before);
      } finally {
        const restored = await createSession({ provider_id: "demo", subject: owner, email: owner, actor_name: actor.name, actor_function: actor.function, role: "medical_affairs" });
        jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, restored.id));
      }
    } finally { await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${other.schema_name}" CASCADE`)); }
  });

});
