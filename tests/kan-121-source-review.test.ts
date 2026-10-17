import { openingActionTokens } from "./support/opening-action-tokens";
/** Cited manual source review through the public action and persisted read model. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
 get: (name: string) => jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined,
 set: (name: string, value: string) => void jar.values.set(name, value),
 delete: (name: string) => void jar.values.delete(name),
}), headers: async () => new Headers() }));
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { wipePlatform } from "@/modules/kernel/db";
import { createSession } from "@/modules/auth/session";
import { createWorkspace } from "@/modules/workspaces/store";
import { selectWorkspace } from "@/modules/workspaces/session";
import { runInWorkspace } from "@/modules/workspaces/context";
import { setAiEnabled } from "@/modules/kernel/ai-switch";
import { POST as sourcePost } from "@/app/api/sources/blocks/route";
import { sourceReviewTargetVersion, sourceReviewCitationCurrent, createSourceDiscrepancy } from "@/lib/iegp/source-review";
import { createManualSource } from "@/lib/iegp/source-blocks";
import * as store from "@/lib/iegp/store";
import { relationshipFit } from "@/lib/iegp/engine";
const actor = { actor_name: "Source reviewer", actor_function: "medical_affairs" as const };
let gapId: string, tacticId: string, coverageId: string, sourceId: string, blockId: string;
async function post(body: Record<string, unknown>) {
 const opening = await openingActionTokens(body);
 const response = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...actor, ...opening, ...body }) }));
 return { status: response.status, body: await response.json() };
}
function claim(action = "create_source_discrepancy", extra: Record<string, unknown> = {}) { return post({ action, source_id: sourceId, block_id: blockId, passage: "The study includes children only.", gap_id: gapId, tactic_id: tacticId, coverage_id: coverageId, rationale: "The retained protocol challenges the adult population", ...extra }); }
async function findings() { return (await store.loadState()).source_reviews ?? []; }
beforeEach(async () => {
 jar.values.clear();
 await store.resetDemoSetup(); await wipePlatform();
 gapId = await store.createGap({ statement: "Adult comparative outcomes", ...actor });
 tacticId = await store.recordMissedTactic({ name: "Source review study", type: "rwe_study", evidence_question: "Adult comparative evidence", population: "Adults", status: "ongoing", ...actor });
 const assigned = await post({ action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, overall: "partial", rationale: "Original human judgement" }); expect(assigned.status).toBe(200);
 coverageId = (await store.loadState()).coverages.find(c => c.gap_id === gapId)!.id;
 const source = await createManualSource({ title: "Retained protocol", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "The study includes children only. Operational appendix." }], rationale: "Manual fixture", actor: { name: actor.actor_name, function: actor.actor_function } });
 sourceId = source.source_id; blockId = source.blocks[0]!.id;
});
describe("KAN-145 cited manual source review", () => {
 it("deduplicates supporting links and preserves coverage without AI", async () => {
  await setAiEnabled({ enabled: false, actor_name: actor.actor_name });
  const before = await store.loadState();
  const first = await claim("link_source_support", { origin: "ai" }); expect(first.status).toBe(200);
  expect((await claim("link_source_support")).body.id).toBe(first.body.id);
  const after = await store.loadState(); expect(after.source_reviews).toHaveLength(1);
  expect(after.source_reviews![0]).toMatchObject({ kind: "support", origin: "human", passage: "The study includes children only.", coverage_id: coverageId });
  expect(after.coverages).toEqual(before.coverages); expect(after.gaps).toEqual(before.gaps);
  expect((await claim()).status).toBe(200);
 });
 it("shows pending challenges independently and dismisses only the selected finding with history", async () => {
  const before = await store.loadState(); const first = await claim(); expect(first.status).toBe(200);
  expect((await claim()).body.id).toBe(first.body.id);
  await claim("create_source_discrepancy", { passage: "Operational appendix.", rationale: "A second independent challenge" });
  const row = (await findings())[0];
  expect(relationshipFit(await store.loadState(), gapId, tacticId).review_reasons.join(" ")).toMatch(/pending source discrepancy/i);
  expect((await post({ action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version, decision: "dismiss", rationale: "Appendix does not change the recorded judgement" })).status).toBe(200);
  expect((await claim()).body.id).toBe(first.body.id);
  const after = await store.loadState(); expect(after.coverages).toEqual(before.coverages); expect(after.gaps).toEqual(before.gaps);
  expect(after.source_reviews!.find(r => r.id === row.id)).toMatchObject({ status: "dismissed", history: [expect.objectContaining({ decision: "dismiss", rationale: "Appendix does not change the recorded judgement" })] });
  expect(relationshipFit(after, gapId, tacticId).review_reasons.filter(r => /pending source discrepancy/i.test(r))).toHaveLength(1);
  expect((await post({ action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version, decision: "dismiss", rationale: "Stale open form" })).status).toBe(400);
 });
 it("requires a real retained passage and same-plan matching relationship targets", async () => {
  for (const extra of [{ passage: "Invented fact" }, { source_id: "foreign-source" }, { block_id: "foreign-block" }, { gap_id: "foreign-gap" }, { tactic_id: "foreign-tactic" }, { coverage_id: "foreign-coverage" }]) expect((await claim("create_source_discrepancy", extra)).status, JSON.stringify(extra)).toBe(400);
  expect(await findings()).toHaveLength(0);
 });
 it("accepts only an explicitly reviewed source-backed correction through the canonical edit owner", async () => {
  expect((await claim()).status).toBe(200); const row = (await findings())[0];
  const before = await store.loadState();
  const base = { action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version, decision: "accept", rationale: "Reviewed the protocol and correct population", correction_target: "tactic", correction_field: "population", correction_value: "Children" };
  expect((await post(base)).status).toBe(400);
  const { sourceReviewTargetVersion } = await import("@/lib/iegp/source-review");
  const expected_target_version = sourceReviewTargetVersion(before, row, "tactic");
  expect((await post({ ...base, reviewed_change: "true", expected_target_version: "stale" })).status).toBe(400);
  expect((await post({ ...base, reviewed_change: "true", expected_target_version })).status).toBe(200);
  const after = await store.loadState(); expect(after.tactics.find(t => t.id === tacticId)!.population).toBe("Children");
  expect(after.coverages.find(c => c.id === coverageId)).toMatchObject({ stale: true, overall: "partial", overall_lock: before.coverages.find(c => c.id === coverageId)!.overall_lock });
  expect(after.source_reviews![0]).toMatchObject({ status: "accepted", history: [expect.objectContaining({ correction: expect.objectContaining({ field: "population", value: "Children" }) })] });
  expect(after.audit.some(a => a.entity_id === tacticId && a.action === "modify")).toBe(true);
 });
 it("fails safely after the cited support or target changes and preserves the pending finding", async () => {
  await claim(); const row = (await findings())[0];
  const { sourceReviewTargetVersion } = await import("@/lib/iegp/source-review");
  const version = sourceReviewTargetVersion(await store.loadState(), row, "gap");
  await post({ action: "modify_gap", gap_id: gapId, statement: "Changed requirement", rationale: "Another reviewer accepted an edit" });
  expect((await post({ action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version, expected_target_version: version, decision: "accept", reviewed_change: "true", correction_target: "gap", correction_field: "statement", correction_value: "Children evidence", rationale: "Old form" })).status).toBe(400);
  expect((await findings())[0].status).toBe("pending");
 });
 it("retains the immutable citation after a public source edit and refuses stale-source acceptance", async () => {
  await claim(); const row = (await findings())[0];
  const response = await sourcePost(new Request("http://localhost/api/sources/blocks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "edit", block_id: blockId, text: "The amended study includes all ages.", rationale: "A new protocol replaced the original", ...actor }) }));
  expect(response.status).toBe(200);
  const before = await store.loadState();
  expect(sourceReviewCitationCurrent(before, row)).toBe(false);
  expect((await post({ action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version, expected_target_version: sourceReviewTargetVersion(before, row, "tactic"), decision: "accept", reviewed_change: "true", correction_target: "tactic", correction_field: "population", correction_value: "Children", rationale: "Opened before the source changed" })).status).toBe(400);
  const after = await store.loadState(); expect(after.source_reviews![0]).toEqual(row);
  expect(after.source_reviews![0].passage).toBe("The study includes children only.");
  expect(after.coverages).toEqual(before.coverages); expect(after.tactics).toEqual(before.tactics);
 });
 it("accepts a gap correction without clearing sibling findings or stale review reasons and preserves decisions on retry", async () => {
  await claim(); const row = (await findings())[0];
  await claim("create_source_discrepancy", { rationale: "An independent concern remains" });
  const before = await store.loadState();
  expect((await post({ action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version, expected_target_version: sourceReviewTargetVersion(before, row, "gap"), decision: "accept", reviewed_change: "true", correction_target: "gap", correction_field: "statement", correction_value: "Comparative outcomes in children", rationale: "Reviewed the cited protocol against the gap statement" })).status).toBe(200);
  const accepted = (await findings()).find(r => r.id === row.id)!;
  expect((await claim()).body.id).toBe(row.id);
  const after = await store.loadState(); expect(after.source_reviews!.find(r => r.id === row.id)).toEqual(accepted);
  expect(after.gaps.find(g => g.id === gapId)!.statement).toBe("Comparative outcomes in children");
  expect(after.coverages.find(c => c.id === coverageId)).toMatchObject({ stale: true, overall: "partial" });
  const reasons = relationshipFit(after, gapId, tacticId).review_reasons.join(" ");
  expect(reasons).toMatch(/independent concern/); expect(reasons).toMatch(/changed/i);
  expect(after.audit.some(a => a.entity_id === gapId && a.action === "modify")).toBe(true);
 });
 it("supports whole-record scope, rejects mismatched local relationships and does not trust public origin", async () => {
  const otherGap = await store.createGap({ statement: "Other decision", ...actor });
  expect((await claim("create_source_discrepancy", { gap_id: otherGap })).status).toBe(400);
  expect((await claim("create_source_discrepancy", { gap_id: otherGap, coverage_id: "" })).status).toBe(400);
  expect((await claim("create_source_discrepancy", { tactic_id: "", coverage_id: "", origin: "ai" })).status).toBe(200);
  expect((await findings())[0]).toMatchObject({ origin: "human", gap_id: gapId, tactic_id: null, coverage_id: null });
  expect(relationshipFit(await store.loadState(), gapId, tacticId).review_reasons.join(" ")).toMatch(/pending source discrepancy/i);
  const aiId = await createSourceDiscrepancy({ source_id: sourceId, block_id: blockId, passage: "Operational appendix.", tactic_id: tacticId, rationale: "Trusted comparison owner proposal", origin: "ai", ...actor });
  expect((await findings()).find(r => r.id === aiId)).toMatchObject({ origin: "ai", status: "pending", gap_id: null, tactic_id: tacticId });
 });
 it("rejects actual foreign-plan citations, targets and findings without changing either plan", async () => {
  const workspace = await createWorkspace({ name: "Foreign source review plan", owner: "foreign-reviewer@example.test" });
  const foreign = await runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, async () => {
   const gap = await store.createGap({ statement: "Foreign plan requirement", ...actor });
   const source = await createManualSource({ title: "Foreign protocol", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "Foreign protocol passage" }], rationale: "Foreign fixture", actor: { name: actor.actor_name, function: actor.actor_function } });
   const id = await createSourceDiscrepancy({ source_id: source.source_id, block_id: source.blocks[0].id, passage: "Foreign protocol passage", gap_id: gap, rationale: "Foreign concern", origin: "human", ...actor });
   return { source, gap, id };
  });
  expect((await claim("create_source_discrepancy", { source_id: foreign.source.source_id, block_id: foreign.source.blocks[0].id, passage: "Foreign protocol passage" })).status).toBe(400);
  expect((await claim("create_source_discrepancy", { gap_id: foreign.gap })).status).toBe(400);
  expect((await post({ action: "resolve_source_discrepancy", review_id: foreign.id, expected_version: "anything", decision: "dismiss", rationale: "Foreign decision" })).status).toBe(400);
  expect(await findings()).toHaveLength(0);
  await runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, async () => expect((await findings())[0]).toMatchObject({ id: foreign.id, status: "pending", history: [] }));
 });
 it("denies viewer creation and resolution even when the request spoofs a reviewer", async () => {
  await claim(); const row = (await findings())[0];
  const email = "source-viewer@example.test";
  await createSession({ provider_id: "demo", subject: email, email, actor_name: "Read only reviewer", actor_function: "medical_affairs", role: "viewer" });
  const workspace = await createWorkspace({ name: "Viewer review plan", owner: email });
  await selectWorkspace(workspace.id);
  expect((await claim()).status).toBe(403);
  expect((await claim("link_source_support")).status).toBe(403);
  expect((await post({ action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version, decision: "dismiss", rationale: "Spoofing authorised reviewer", role: "medical_affairs" })).status).toBe(403);
  jar.values.clear(); expect((await findings())[0]).toEqual(row);
 });

});
