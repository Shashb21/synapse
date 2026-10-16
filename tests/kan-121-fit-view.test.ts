/** Public-action tests: arrange records, act through the API, assert saved relationship explanations. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined,
    set: (name: string, value: string) => void jar.values.set(name, value), delete: (name: string) => void jar.values.delete(name) }),
  headers: async () => new Headers(),
}));
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { GET } from "@/app/api/gaps/[id]/route";
import * as store from "@/lib/iegp/store";
import * as engine from "@/lib/iegp/engine";
import { gapRecord } from "@/lib/iegp/gap-record";
import type { TacticExpansion } from "@/lib/iegp/types";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { coverageReviewVersion, getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import { setAiEnabled } from "@/modules/kernel/ai-switch";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, withWorkspace } from "@/modules/workspaces/store";
import { db } from "@/lib/iegp/db";
import * as schema from "@/lib/iegp/schema";
import { eq } from "drizzle-orm";

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
async function fit(gap = gapId) { return engine.mappedTactics(await store.loadState(), gap)[0]!.fit; }
async function reviewBasis() {
  const dimensions = Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, { applicability: "required", requirement: `Required ${d}`, rationale: "Decision needs this information" }]));
  expect((await post({ action: "review_requirement_basis", gap_id: gapId, expected_version: getRequirementBasisReview(await store.loadState(), gapId).version, requirements: JSON.stringify(dimensions), rationale: "Reviewed complete question" })).status).toBe(200);
}
beforeEach(async () => { jar.values.clear(); await store.resetDemoSetup(); await createPair(); });
afterEach(async () => { jar.values.clear(); await setAiEnabled({ enabled: true, actor_name: actor.actor_name }); });

describe("KAN-142 independent relationship fit", () => {
  it("shows unassessed links and never promotes matching wording or missing information into verified fit", async () => {
    await link();
    const model = await fit();
    expect(model).toBeDefined();
    expect(model!.overall).toBe("unassessed");
    expect(model!.assessment_origin).toBeNull();
    expect(model!.confirmation.locked).toBe(false);
    expect(model!.dimensions.every(d => d.fit === "unknown")).toBe(true);
    expect(model!.dimensions.find(d => d.dimension === "comparator")!.documented_tactic).toBe("Placebo");
    const record = await gapRecord(gapId);
    expect(record!.coverages[0]!.fit).toEqual(model);
  });
  it("keeps independent No, Unknown and Partial answers when another tactic or gap is added", async () => {
    await reviewBasis();
    await link(gapId, { overall: "partial", dimensions: JSON.stringify({ population: "yes", comparator: "no", outcomes: "unknown", timing: "partial" }), rationale: "Comparator differs; outcomes not yet documented; timing is incomplete" });
    const first = await fit();
    expect(first).toBeDefined();
    expect(first!.dimensions.find(d => d.dimension === "population")!.fit).toBe("documented_match");
    expect(first!.dimensions.find(d => d.dimension === "comparator")!.fit).toBe("known_mismatch");
    expect(first!.dimensions.find(d => d.dimension === "outcomes")!.fit).toBe("unknown");
    expect(first!.dimensions.find(d => d.dimension === "timing")!.fit).toBe("partial");
    expect(first!.assessment_origin).toBe("human");
    expect(first!.confirmation.locked).toBe(true);
    expect(first!.dimensions.every(d => !d.confirmation.locked)).toBe(true);
    const secondGap = await store.createGap({ statement: "Safety follow up decision", ...actor });
    await link(secondGap, { overall: "limited", dimensions: JSON.stringify({ comparator: "yes" }), rationale: "A different question with independent answers" });
    await post({ action: "record_missed_tactic", name: "Complementary study", type: "rwe_study", evidence_question: "Comparator and outcomes", status: "planned" });
    const other = (await store.loadState()).tactics.find(t => t.name === "Complementary study")!;
    await post({ action: "assign_tactic", gap_id: gapId, tactic_id: other.id, overall: "partial", dimensions: JSON.stringify({ comparator: "yes", outcomes: "yes" }), rationale: "This answers some other requirements" });
    expect((await fit())!.dimensions).toEqual(first!.dimensions);
    expect((await fit(secondGap))!.dimensions.find(d => d.dimension === "comparator")!.fit).toBe("documented_match");
    const state = await store.loadState();
    expect(state.tactics.filter(t => t.id === tacticId)).toHaveLength(1);
    expect(state.gaps).toHaveLength(2);
    expect(state.residuals).toHaveLength(0);
    expect(engine.computeGapStatus(state.coverages.filter(c => c.gap_id === gapId), state.tactics)).toBe("validated_partial");
  });
  it("separates provisional Full, lifecycle eligibility, basis review and freshness without changing saved judgements", async () => {
    await link(gapId, { overall: "full", confirm_coverage: "false", rationale: "Intended Full design awaiting review" });
    let model = await fit();
    expect(model).toBeDefined();
    expect(model!.overall).toBe("full");
    expect(model!.assessment_origin).toBe("human");
    expect(model!.confirmation.locked).toBe(false);
    expect(model!.full_eligible).toBe(false);
    const coverage = (await store.loadState()).coverages[0]!;
    await db().update(schema.coverages).set({ stale: true, needs_review: true }).where(eq(schema.coverages.id, coverage.id));
    model = await fit();
    expect(model!.stale).toBe(true);
    expect(model!.needs_review).toBe(true);
    expect(model!.review_reasons.join(" ")).toMatch(/stale|outdated/i);
    expect(model!.review_reasons.join(" ")).toMatch(/marked for review/i);
    expect(model!.contribution.counts_toward_addressing).toBe(true);
    expect((await store.loadState()).coverages[0]!.overall).toBe("full");
  });
  it("reads fit with AI disabled and allows viewers to inspect it while refusing their assessment writes", async () => {
    const email = `fit-${crypto.randomUUID()}@example.test`;
    const ws = await createWorkspace({ name: "Fit viewer workspace", owner: email });
    await inviteMember({ workspace_id: ws.id, email: `viewer-${email}`, by: email });
    await withWorkspace(ws.id, async () => { await store.resetDemoSetup(); await createPair(); await link(); });
    const session = await createSession({ provider_id: "demo", subject: `demo:viewer-${email}`, email: `viewer-${email}`, actor_name: "Read only reviewer", actor_function: "medical_affairs", role: "viewer" });
    jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(ws.id, session.id));
    await setAiEnabled({ enabled: false, actor_name: actor.actor_name });
    await withWorkspace(ws.id, async () => {
      const before = await store.loadState();
      const response = await GET(new Request(`http://localhost/api/gaps/${gapId}`), { params: Promise.resolve({ id: gapId }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.coverages[0].fit).toBeDefined();
      expect(body.coverages[0].fit.overall).toBe("unassessed");
      expect((await post({ action: "lock_overall", coverage_id: before.coverages[0]!.id, overall: "partial", rationale: "Viewer cannot write", expected_version: coverageReviewVersion(before.coverages[0]!) })).status).toBe(403);
      expect(await store.loadState()).toEqual(before);
    });
  });
  it("previews an unlinked pair without writing and rejects out-of-scope identities", async () => {
    const before = await store.loadState();
    expect(typeof engine.relationshipFit).toBe("function");
    const preview = engine.relationshipFit(before, gapId, tacticId);
    expect(preview.coverage_id).toBeNull();
    expect(preview.overall).toBe("unassessed");
    expect(() => engine.relationshipFit(before, "OTHER-GAP", tacticId)).toThrow(/gap/i);
    expect(() => engine.relationshipFit(before, gapId, "OTHER-TACTIC")).toThrow(/tactic/i);
    expect(() => engine.relationshipFit(before, gapId, tacticId, "OTHER-EXPANSION")).toThrow(/scope/i);
    await post({ action: "lock_gap", gap_id: gapId, status: "validated_open", note: "Keep gap open for library preview" });
    const previewState = await store.loadState();
    const workspace = engine.buildPlanWorkspace(previewState);
    expect(workspace.openGaps.find(g => g.gap_id === gapId)?.fit_previews?.[tacticId]).toEqual(preview);
    expect(await store.loadState()).toEqual(previewState);
    expect(before.coverages).toHaveLength(0);
  });
  it("keeps expansion design and lifecycle separate from the parent and other gaps", async () => {
    await link(gapId, { overall: "limited", dimensions: JSON.stringify({ comparator: "no" }), rationale: "Parent mismatch" });
    const state = await store.loadState();
    const expansion: TacticExpansion = {
      id: "EXP-FIT", tactic_id: tacticId, gap_ids: [gapId], status: "proposed", proposal_id: "PROP-FIT", version: "fit-v1",
      created_at: "2026-10-16T10:00:00.000Z", updated_at: "2026-10-16T10:00:00.000Z", actor: { name: "Fit reviewer", function: "medical_affairs" }, history: [],
      scope: { name: "Child analysis", evidence_question: "Child question", population: "Child population", outcomes: "", geography: "", data_cut: "", analysis: "", instrument: "", study_design: "", gap_coverage: "Added child contribution", cost_effort: "", timing: "", feasibility_risks: "", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null },
    };
    state.expansions.push(expansion);
    state.coverages.push({ ...state.coverages[0]!, id: "COV-FIT-CHILD", expansion_id: expansion.id, overall: "unassessed" });
    const child = engine.relationshipFit(state, gapId, tacticId, expansion.id);
    expect(child.dimensions.find(d => d.dimension === "comparator")!.documented_tactic).toBeNull();
    expect(child.dimensions.find(d => d.dimension === "population")!.documented_tactic).toBe("Child population");
    expect(child.contribution).toMatchObject({ evidence_question: "Child question", status: "proposed", counts_toward_addressing: false });
    expansion.status = "planned";
    expect(engine.relationshipFit(state, gapId, tacticId, expansion.id).contribution.counts_toward_addressing).toBe(true);
    expect(engine.relationshipFit(state, gapId, tacticId).dimensions.find(d => d.dimension === "comparator")!.documented_tactic).toBe("Placebo");
    const other = await store.createGap({ statement: "Other scope", ...actor });
    expect(() => engine.relationshipFit({ ...state, gaps: [...state.gaps, { ...state.gaps[0]!, id: other }] }, other, tacticId, expansion.id)).toThrow(/scope/i);
    expect((await store.loadState()).expansions).toHaveLength(0);
  });
  it("keeps historical origin unknown despite locks and labels new AI proposals separately from human review", async () => {
    await store.assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, coverage: "partial", dimensions: { comparator: "no" }, note: "Historical judgement", ...actor });
    let state = await store.loadState();
    const coverage = state.coverages[0]!;
    await db().update(schema.coverages).set({ overall_lock: { ...coverage.overall_lock, locked: true, actor_name: "Past human" } }).where(eq(schema.coverages.id, coverage.id));
    expect((await fit())?.assessment_origin).toBeNull();
    const other = await store.createGap({ statement: "An AI assessment question", ...actor });
    // S4's writer supplies origin explicitly; the actor executing a model is not its author.
    await store.assignTacticToGap({ gap_id: other, tactic_id: tacticId, coverage: "partial", assessment_origin: "ai", dimensions: { population: "yes" }, note: "Sourced model judgement", ...actor });
    expect((await fit(other))!.assessment_origin).toBe("ai");
    expect((await fit(other))!.confirmation.locked).toBe(false);
    state = await store.loadState();
    const ai = state.coverages.find(c => c.gap_id === other)!;
    expect((await post({ action: "lock_dimension", coverage_id: ai.id, dimension: "population", value: "yes", rationale: "Human confirms this dimension only", expected_version: coverageReviewVersion(ai) })).status).toBe(200);
    expect((await fit(other))!.assessment_origin).toBe("ai");
    expect((await fit(other))!.confirmation.locked).toBe(false);
    expect((await fit(other))!.dimensions.find(d => d.dimension === "population")!.confirmation.locked).toBe(true);
    const dimensionReviewed = (await store.loadState()).coverages.find(c => c.id === ai.id)!;
    await post({ action: "lock_overall", coverage_id: ai.id, overall: "limited", rationale: "Human replaces overall with limited", expected_version: coverageReviewVersion(dimensionReviewed) });
    expect((await fit(other))!.assessment_origin).toBe("human");
  });
  it("renders accessible fit distinctions without edit or AI controls", async () => {
    await link(gapId, { overall: "partial", dimensions: JSON.stringify({ population: "yes", comparator: "no", outcomes: "unknown", timing: "partial" }), rationale: "Different comparator; outcomes unknown" });
    const model = await fit();
    expect(model).toBeDefined();
    const { RelationshipFit } = await import("@/components/relationship-fit");
    const html = renderToStaticMarkup(createElement(RelationshipFit, { fit: model!, tacticName: "Shared adult study" }));
    for (const text of ["Fit to this gap", "Documented match", "Known mismatch", "Unknown information", "Partial answer", "Unanswered requirements", "Saved judgement", "Human confirmation", "Freshness", "Assessment origin", "Design intent", "Delivery of evidence has not been verified"])
      expect(html).toContain(text);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
    const { TacticFitSelect } = await import("@/components/tactic-fit-select");
    const selector = renderToStaticMarkup(createElement(TacticFitSelect, { tactics: engine.buildTacticLibrary(await store.loadState()), previews: { [tacticId]: model! } }));
    expect(selector).toContain("Fit to this gap");
    expect(selector).toContain('name="tactic_id"');
  });

});
