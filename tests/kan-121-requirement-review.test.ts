import { beforeEach, describe, expect, it, vi } from "vitest";

/** Browser cookies let the public route exercise real identity and permissions. */
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined,
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));
import "@/modules";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, withWorkspace } from "@/modules/workspaces/store";

import { eq } from "drizzle-orm";
import { POST } from "@/app/api/iegp/route";
import * as store from "@/lib/iegp/store";
import { db } from "@/lib/iegp/db";
import * as schema from "@/lib/iegp/schema";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { computeGapStatus } from "@/lib/iegp/engine";
import * as requirements from "@/lib/iegp/requirement-basis";

const actor = { actor_name: "Coverage reviewer", actor_function: "heor" as const };
const yes = Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, "yes"]));
const required = Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, { applicability: "required", requirement: `Reviewed ${d}`, rationale: "Required for this decision" }]));
let gapId: string, tacticId: string;
async function post(body: Record<string, unknown>) {
  const response = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...actor, ...body }) }));
  return { status: response.status, body: await response.json() };
}
async function basis() { return requirements.getRequirementBasisReview(await store.loadState(), gapId); }
async function review(dimensions = required, extra: Record<string, unknown> = {}) {
  return post({ action: "review_requirement_basis", gap_id: gapId, expected_version: (await basis()).version, requirements: JSON.stringify(dimensions), rationale: "Reviewed the complete sourced requirement basis", ...extra });
}
async function link(dimensions: Record<string, string> = yes, overall = "full") {
  return post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, overall, dimensions: JSON.stringify(dimensions), rationale: "Protocol covers these requirements", expected_basis_version: (await basis()).version });
}
beforeEach(async () => {
  jar.values.clear();
  await store.resetDemoSetup();
  gapId = await store.createGap({ statement: "Comparative evidence for the payer decision", ...actor });
  await store.recordMissedTactic({ name: "One shared study", type: "rwe_study", evidence_question: "Comparative outcomes", status: "ongoing", ...actor });
  tacticId = (await store.loadState()).tactics.find(t => t.name === "One shared study")!.id;
});
describe("KAN-141 requirement review through public actions", () => {
  it("rejects unsupported Full atomically while allowing an unassessed link", async () => {
    const result = await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, overall: "full", rationale: "It looks comprehensive" });
    expect(result.status).toBe(400);
    expect((await store.loadState()).coverages).toHaveLength(0);
    expect((await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId })).status).toBe(200);
    expect((await store.loadState()).coverages[0]?.overall).toBe("unassessed");
  });
  it("persists sourced human requirements and confirms overall separately from dimensions", async () => {
    const initial = await basis();
    expect(initial.basis.dimensions.comparator.applicability).toBe("undetermined");
    expect(initial.basis.dimensions.relevance.sources.some(s => s.kind === "gap")).toBe(true);
    expect((await review()).status).toBe(200);
    expect((await link()).status).toBe(200);
    const state = await store.loadState();
    expect(state.gaps.find(g => g.id === gapId)?.requirement_basis?.confirmation.locked).toBe(true);
    expect(requirements.getRequirementBasisReview(state, gapId, state.coverages[0]).full_eligible).toBe(true);
    expect(state.coverages[0]?.overall_lock.locked).toBe(true);
    expect(Object.values(state.coverages[0]!.dimensions).every(d => !d.lock.locked)).toBe(true);
    expect(computeGapStatus(state.coverages, state.tactics)).toBe("validated_addressed");
    expect(state.audit.some(a => a.action === "review_requirement_basis")).toBe(true);
  });
  it("requires the basis version after normalizing a public Full verdict", async () => {
    await review();
    const result = await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, overall: " full ", dimensions: JSON.stringify(yes), rationale: "A stale client omitted the basis version" });
    expect(result.status).toBe(400);
    expect((await store.loadState()).coverages).toHaveLength(0);
  });
  it.each(["unknown", "no", "partial"])("blocks Full for a required comparator of %s, preserving the saved provisional judgement", async value => {
    await review();
    expect((await link({ ...yes, comparator: value }, "partial")).status).toBe(200);
    const before = await store.loadState(); const coverage = before.coverages[0]!;
    const result = await post({ action: "lock_overall", coverage_id: coverage.id, overall: "full", rationale: "Confirm the proposal", expected_version: requirements.coverageReviewVersion(coverage), expected_basis_version: (await basis()).version });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/comparator/i);
    expect((await store.loadState()).coverages).toEqual(before.coverages);
    expect((await store.loadState()).audit).toEqual(before.audit);
  });
  it("permits justified non-applicability but never treats omission as non-applicability", async () => {
    expect((await review({ ...required, comparator: { applicability: "not_applicable", rationale: "Single-arm safety question requires no comparator", requirement: "" } })).status).toBe(200);
    expect((await link({ ...yes, comparator: "unknown" })).status).toBe(200);
    const old = await basis();
    const omitted = { ...required }; delete omitted.comparator;
    expect((await review(omitted)).status).toBe(200);
    expect((await basis()).basis.dimensions.comparator.applicability).toBe("undetermined");
    expect((await post({ action: "review_requirement_basis", gap_id: gapId, expected_version: old.version, requirements: JSON.stringify(required), rationale: "A stale submission" })).status).toBe(400);
  });
  it("rejects unjustified non-applicability and forged source references without partial writes", async () => {
    const before = await store.loadState();
    expect((await review({ ...required, comparator: { applicability: "not_applicable", rationale: "", requirement: "" } })).status).toBe(400);
    expect((await review({ ...required, comparator: { ...required.comparator, sources: [{ kind: "need", need_id: "OTHER-PLAN", source_id: "OTHER-SOURCE", quote: "Invented" }] } } as typeof required)).status).toBe(400);
    expect((await store.loadState()).gaps).toEqual(before.gaps);
  });
  it("retains conflicting linked need provenance until a human supplies a resolution", async () => {
    const second = await store.createNeed({ gap_id: gapId, statement: "A second requirement", rationale: "Source specifies another comparator", ...actor });
    const state = await store.loadState(); const first = state.need_gap_links.find(l => l.gap_id === gapId)!.need_id;
    await db().update(schema.needs).set({ comparator: "Placebo" }).where(eq(schema.needs.id, first));
    await db().update(schema.needs).set({ comparator: "Active standard of care" }).where(eq(schema.needs.id, second));
    expect((await review()).status).toBe(200);
    expect((await basis()).basis.dimensions.comparator.conflicts).toHaveLength(2);
    expect((await link()).status).toBe(400);
    expect((await review({ ...required, comparator: { ...required.comparator, resolution: "Use active standard of care for this payer decision" } } as typeof required)).status).toBe(200);
    expect((await link()).status).toBe(200);
    expect((await basis()).basis.dimensions.comparator.sources.filter(s => s.kind === "need")).toHaveLength(2);
  });
  it("keeps AI proposals unlocked and refuses AI confirmation", async () => {
    await store.reviewRequirementBasis({ gap_id: gapId, expected_version: (await basis()).version, dimensions: required, rationale: "Sourced model proposal", origin: "ai", confirm: false, ...actor });
    expect((await basis()).basis.confirmation.locked).toBe(false);
    expect((await link()).status).toBe(400);
    await expect(store.reviewRequirementBasis({ gap_id: gapId, expected_version: (await basis()).version, dimensions: required, rationale: "Model cannot confirm", origin: "ai", confirm: true, ...actor })).rejects.toThrow(/human/i);
    expect((await review()).status).toBe(200);
    expect((await link()).status).toBe(200);
  });
  it("flags historical unsupported Full and warning acknowledgement never verifies it", async () => {
    const id = await store.assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, coverage: "full", ...actor });
    const row = (await store.loadState()).coverages[0]!;
    await db().update(schema.coverages).set({ overall_lock: { ...row.overall_lock, locked: true, actor_name: "Historical reviewer" }, needs_review: true }).where(eq(schema.coverages.id, id));
    const before = await store.loadState();
    expect(requirements.getRequirementBasisReview(before, gapId, before.coverages[0]).legacy_unsupported_full).toBe(true);
    expect(computeGapStatus(before.coverages, before.tactics)).toBe("validated_partial");
    await post({ action: "confirm_coverage_review", coverage_id: id });
    const after = await store.loadState();
    expect(after.coverages[0]?.overall_lock).toEqual(before.coverages[0]?.overall_lock);
    expect(requirements.getRequirementBasisReview(after, gapId, after.coverages[0]).legacy_unsupported_full).toBe(true);
    expect(computeGapStatus(after.coverages, after.tactics)).toBe("validated_partial");
  });
  it("keeps one tactic and independent gap requirements and rejects stale coverage edits", async () => {
    await review(); await link(); const state = await store.loadState(); const first = state.coverages[0]!;
    const secondGap = await store.createGap({ statement: "A different decision", ...actor });
    expect((await post({ action: "assign_tactic", gap_id: secondGap, tactic_id: tacticId, overall: "partial", rationale: "Unresolved requirements remain provisional" })).status).toBe(200);
    expect((await store.loadState()).tactics.filter(t => t.id === tacticId)).toHaveLength(1);
    const version = requirements.coverageReviewVersion(first);
    expect((await post({ action: "lock_dimension", coverage_id: first.id, dimension: "timing", value: "partial", rationale: "Later readout", expected_version: version })).status).toBe(200);
    const before = await store.loadState();
    expect((await post({ action: "lock_dimension", coverage_id: first.id, dimension: "timing", value: "yes", rationale: "Obsolete response", expected_version: version })).status).toBe(400);
    expect((await store.loadState()).coverages).toEqual(before.coverages);
    expect(before.coverages.find(c => c.gap_id === secondGap)?.overall).toBe("partial");
  });
  it("preserves provisional Full and rejects forms whose source content changed", async () => {
    const old = await basis();
    expect((await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, overall: "full", confirm_coverage: "false", rationale: "Awaiting requirements" })).status).toBe(200);
    const provisional = (await store.loadState()).coverages[0]!;
    expect(provisional.overall_lock.locked).toBe(false);
    await db().update(schema.gaps).set({ statement: "A changed payer decision" }).where(eq(schema.gaps.id, gapId));
    const before = await store.loadState();
    expect((await review(required, { expected_version: old.version })).status).toBe(400);
    expect((await store.loadState()).gaps).toEqual(before.gaps);
    expect((await store.loadState()).coverages[0]).toEqual(provisional);
  });
  it("uses the authenticated reviewer and refuses viewer confirmation despite forged body claims", async () => {
    const run = crypto.randomUUID();
    const owner = `kan141-${run}@example.test`, viewer = `kan141-viewer-${run}@example.test`;
    const workspace = await createWorkspace({ name: `KAN-141 identity ${run}`, owner });
    await inviteMember({ workspace_id: workspace.id, email: viewer, by: owner });
    const scoped = <T,>(fn: () => Promise<T>) => withWorkspace(workspace.id, fn);
    await scoped(async () => {
      await store.resetDemoSetup();
      gapId = await store.createGap({ statement: "Authenticated review", ...actor });
    });
    async function signIn(role: "medical_affairs" | "viewer", email: string) {
      jar.values.clear();
      const session = await createSession({ provider_id: "demo", subject: `demo:${email}`, email, actor_name: role === "viewer" ? "Read only person" : "Signed in reviewer", actor_function: "medical_affairs", role });
      jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
    }
    await signIn("viewer", viewer);
    const before = await scoped(() => store.loadState());
    const denied = await scoped(() => review(required, { actor_name: "Forged lead", role: "operator" }));
    expect(denied.status).toBe(403);
    expect((await scoped(() => store.loadState())).gaps).toEqual(before.gaps);
    await signIn("medical_affairs", owner);
    expect((await scoped(() => review(required, { actor_name: "Forged lead", origin: "ai", confirm: false }))).status).toBe(200);
    const saved = (await scoped(basis)).basis;
    expect(saved.confirmation.actor_name).toBe("Signed in reviewer");
    expect(saved.origin).toBe("human");
    expect(saved.confirmation.locked).toBe(true);
    jar.values.clear();
  });

});
