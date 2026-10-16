/** Public-action tests: arrange records, act through the API, assert saved relationship explanations. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined,
    set: (name: string, value: string) => void jar.values.set(name, value), delete: (name: string) => void jar.values.delete(name) }),
  headers: async () => new Headers(),
}));
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import * as store from "@/lib/iegp/store";
import * as engine from "@/lib/iegp/engine";
import { gapRecord } from "@/lib/iegp/gap-record";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import { setAiEnabled } from "@/modules/kernel/ai-switch";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, withWorkspace } from "@/modules/workspaces/store";
import { db } from "@/lib/iegp/db";
import * as schema from "@/lib/iegp/schema";
import { eq } from "drizzle-orm";
import { listEdits } from "@/modules/kernel/edit-records";

const actor = { actor_name: "Fit reviewer", actor_function: "medical_affairs" as const };
let gapId: string, tacticId: string;
async function post(body: Record<string, unknown>) {
  const response = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...actor, ...body }) }));
  return { status: response.status, body: await response.json() };
}
async function createPair() {
  gapId = await store.createGap({ statement: "Payer comparative evidence for adults", ...actor });
  expect((await post({ action: "record_missed_tactic", name: "Shared adult study", type: "rwe_study", evidence_question: "Payer comparative evidence for adults", population: "Adults", comparator: "Placebo", status: "ongoing" })).status).toBe(200);
  tacticId = (await store.loadState()).tactics.find(t => t.name === "Shared adult study")!.id;
}
async function link(gap = gapId, extra: Record<string, unknown> = {}) {
  expect((await post({ action: "assign_tactic", gap_id: gap, tactic_id: tacticId, ...extra })).status).toBe(200);
}
async function reviewBasis() {
  const dimensions = Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, { applicability: "required", requirement: `Required ${d}`, rationale: "Decision needs this information" }]));
  expect((await post({ action: "review_requirement_basis", gap_id: gapId, expected_version: getRequirementBasisReview(await store.loadState(), gapId).version, requirements: JSON.stringify(dimensions), rationale: "Reviewed complete question" })).status).toBe(200);
}
beforeEach(async () => { jar.values.clear(); await store.resetDemoSetup(); await createPair(); });
afterEach(async () => { jar.values.clear(); await setAiEnabled({ enabled: true, actor_name: actor.actor_name }); });

describe("KAN-143 deliberate library linking", () => {
  it("links unresolved requirements as unassessed and replays identical concurrent saves without new decisions", async () => {
    // Arrange an accepted library tactic and an unresolved gap; Act through the public action.
    const before = await store.loadState();
    const payload = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "unassessed", request_id: crypto.randomUUID() };
    const results = await Promise.all([post(payload), post(payload)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const state = await store.loadState();
    expect(state.coverages).toHaveLength(1);
    expect(state.tactics).toEqual(before.tactics);
    expect(state.coverages[0]).toMatchObject({ overall: "unassessed", assessment_origin: null, overall_lock: { locked: false } });
    expect((await gapRecord(gapId))!.coverages[0]!.fit!.overall).toBe("unassessed");
    const edits = await listEdits({ entity_id: gapId });
    const retry = await post(payload);
    expect(retry.status).toBe(200);
    expect(await store.loadState()).toEqual(state);
    expect(await listEdits({ entity_id: gapId })).toEqual(edits);
    expect(results[0]!.body.id).toBe(state.coverages[0]!.id);
    expect(results[1]!.body.id).toBe(state.coverages[0]!.id);
  });
  it("atomically assesses and links with a human rationale, preserving independent dimension confirmation", async () => {
    const payload = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "assessed", request_id: crypto.randomUUID(), overall: "partial", dimensions: JSON.stringify({ comparator: "no", population: "yes" }), rationale: "Comparator differs from the question" };
    expect((await post(payload)).status).toBe(200);
    const state = await store.loadState();
    expect(state.coverages).toHaveLength(1);
    expect(state.coverages[0]).toMatchObject({ overall: "partial", assessment_origin: "human", overall_rationale: payload.rationale, overall_lock: { locked: true } });
    expect(Object.values(state.coverages[0]!.dimensions).every(d => !d.lock.locked)).toBe(true);
    expect((await post(payload)).status).toBe(200);
    expect(await store.loadState()).toEqual(state);
    expect((await post({ ...payload, rationale: "A different decision under the old request" })).status).toBe(400);
    expect(await store.loadState()).toEqual(state);
  });
  it("rejects unresolved Full without a partial relationship or acceptance, then permits a corrected retry", async () => {
    const before = await store.loadState();
    const payload = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "assessed", request_id: crypto.randomUUID(), overall: "full", expected_basis_version: getRequirementBasisReview(before, gapId).version, rationale: "A complete design was intended" };
    expect((await post(payload)).status).toBe(400);
    expect(await store.loadState()).toEqual(before);
    expect((await post({ ...payload, overall: "partial" })).status).toBe(200);
    expect((await store.loadState()).coverages[0]!.overall).toBe("partial");
  });
  it("requires a deliberate mode, verdict and rationale and refuses unassessed payloads containing assessments", async () => {
    const before = await store.loadState();
    for (const extra of [
      { link_mode: "assessed" },
      { link_mode: "assessed", overall: "partial" },
      { link_mode: "assessed", overall: "unassessed", rationale: "This is not an assessment" },
      { link_mode: "unassessed", overall: "full", rationale: "Do not silently assess" },
      { link_mode: "typo" },
    ]) {
      expect((await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, request_id: crypto.randomUUID(), ...extra })).status).toBe(400);
      expect(await store.loadState()).toEqual(before);
    }
  });
  it("does not silently replace a saved assessment when a different save races the first", async () => {
    const base = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "assessed", overall: "partial", rationale: "Explicit partial judgement" };
    const before = await store.loadState();
    const results = await Promise.all([post({ ...base, request_id: crypto.randomUUID() }), post({ ...base, request_id: crypto.randomUUID(), overall: "limited" })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    const state = await store.loadState();
    expect(state.coverages).toHaveLength(1);
    expect(state.audit.filter(e => e.action === "assign_tactic" && !before.audit.some(old => old.id === e.id))).toHaveLength(1);
  });
  it("rejects child identities that do not belong to the selected parent and gap", async () => {
    const before = await store.loadState();
    const response = await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, expansion_id: "OTHER-CHILD", link_mode: "unassessed", request_id: crypto.randomUUID() });
    expect(response.status).toBe(400);
    expect(await store.loadState()).toEqual(before);
  });
  it("confirms supported Full through the same atomic library action", async () => {
    await reviewBasis();
    const before = await store.loadState();
    const payload = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "assessed", request_id: crypto.randomUUID(), overall: "full", expected_basis_version: getRequirementBasisReview(before, gapId).version, dimensions: JSON.stringify(Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, "yes"]))), rationale: "All reviewed requirements are satisfied by the documented design" };
    expect((await post(payload)).status).toBe(200);
    const record = await gapRecord(gapId);
    expect(record!.coverages[0]!.fit).toMatchObject({ overall: "full", confirmation: { locked: true }, full_eligible: true });
    const state = await store.loadState();
    expect(engine.computeGapStatus(state.coverages, state.tactics)).toBe("validated_addressed");
  });
  it("does not resurrect a removed relationship on a delayed retry, and preserves the rejected-pair rule", async () => {
    const payload = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "unassessed", request_id: crypto.randomUUID() };
    const linked = await post(payload);
    expect(linked.status).toBe(200);
    expect((await post({ action: "unassign_tactic", gap_id: gapId, tactic_id: tacticId, rationale: "This contribution is no longer needed" })).status).toBe(200);
    const removed = await store.loadState();
    expect(removed.coverages).toHaveLength(0);
    const replay = await post(payload);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(linked.body.id);
    expect(await store.loadState()).toEqual(removed);
    await expect(store.assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, ...actor })).rejects.toThrow(/only a person/i);
    expect((await post({ ...payload, request_id: crypto.randomUUID() })).status).toBe(200);
  });
  it("binds a successful request to its gap and actor while reusing one tactic across gaps", async () => {
    const payload = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "unassessed", request_id: crypto.randomUUID() };
    expect((await post(payload)).status).toBe(200);
    const otherGap = await store.createGap({ statement: "Separate decision requirements", ...actor });
    const before = await store.loadState();
    expect((await post({ ...payload, gap_id: otherGap })).status).toBe(400);
    expect((await post({ ...payload, actor_name: "Other reviewer" })).status).toBe(400);
    expect(await store.loadState()).toEqual(before);
    expect((await post({ ...payload, gap_id: otherGap, request_id: crypto.randomUUID() })).status).toBe(200);
    const state = await store.loadState();
    expect(state.tactics).toEqual(before.tactics);
    expect(state.coverages).toHaveLength(2);
  });
  it("preserves historical duplicate assessments and refuses a new link over them", async () => {
    await link(gapId, { overall: "limited", rationale: "Saved historical assessment" });
    const original = (await store.loadState()).coverages[0]!;
    await db().insert(schema.coverages).values({ ...original, id: "COV-LEGACY-DUPLICATE", overall: "partial" });
    const before = await store.loadState();
    expect((await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: "unassessed", request_id: crypto.randomUUID() })).status).toBe(400);
    expect(await store.loadState()).toEqual(before);
    expect(before.coverages).toHaveLength(2);
  });
  it("refuses viewers at the public boundary without mapping or assessing", async () => {
    const email = `link-${crypto.randomUUID()}@example.test`;
    const ws = await createWorkspace({ name: "Link viewer workspace", owner: email });
    await inviteMember({ workspace_id: ws.id, email: `viewer-${email}`, by: email });
    await withWorkspace(ws.id, async () => { await store.resetDemoSetup(); await createPair(); });
    const session = await createSession({ provider_id: "demo", subject: `demo:viewer-${email}`, email: `viewer-${email}`, actor_name: "Read only reviewer", actor_function: "medical_affairs", role: "viewer" });
    jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(ws.id, session.id));
    await withWorkspace(ws.id, async () => {
      const before = await store.loadState();
      for (const link_mode of ["unassessed", "assessed"]) {
        expect((await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode, request_id: crypto.randomUUID(), overall: link_mode === "assessed" ? "partial" : undefined, rationale: "Viewer cannot link" })).status).toBe(403);
        expect(await store.loadState()).toEqual(before);
      }
    });
  });
});
