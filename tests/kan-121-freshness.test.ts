/** Public edits retain historical judgements while current coverage follows reviewed inputs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
import "@/modules";
import { sql } from "drizzle-orm";
import { POST } from "@/app/api/iegp/route";
import { POST as planPost } from "@/app/api/plan/route";
import { POST as sourcePost } from "@/app/api/sources/blocks/route";
import { wipePlatform } from "@/modules/kernel/db";
import { createManualSource } from "@/lib/iegp/source-blocks";
import { db, poolSize, withWorkspaceTransaction } from "@/lib/iegp/db";
import { setupContextFromState } from "@/lib/iegp/planning-context";
import { planVersion } from "@/modules/stages/s10-timeline/module";
import * as store from "@/lib/iegp/store";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { coverageReviewVersion, getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import { relationshipFit, displayedGapStatus } from "@/lib/iegp/engine";
import { gapRecord } from "@/lib/iegp/gap-record";
const actor = { actor_name: "Freshness reviewer", actor_function: "medical_affairs" as const };
const required = Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, { applicability: "required", requirement: `Reviewed ${d}`, rationale: "Required decision input" }]));
const yes = Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, "yes"]));
let gapId: string, tacticId: string;
async function post(body: Record<string, unknown>) {
 const response = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...actor, ...body }) }));
 return { status: response.status, body: await response.json() };
}
async function actionRoute(handler: (request: Request) => Promise<Response>, body: Record<string, unknown>) {
 const response = await handler(new Request("http://localhost/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...actor, ...body }) }));
 return { status: response.status, body: await response.json() };
}
async function reassess() {
 await review();
 return post({ action: "lock_overall", coverage_id: (await row()).id, overall: "full", expected_version: coverageReviewVersion(await row()), expected_basis_version: getRequirementBasisReview(await store.loadState(), gapId).version, rationale: "Explicitly reviewed the accepted current basis" });
}
async function review(gap_id = gapId) { return post({ action: "review_requirement_basis", gap_id, expected_version: getRequirementBasisReview(await store.loadState(), gap_id).version, requirements: JSON.stringify(required), rationale: "Reviewed all current requirements" }); }
async function link(gap_id = gapId, tactic_id = tacticId) { return post({ action: "assign_tactic", gap_id, tactic_id, overall: "full", dimensions: JSON.stringify(yes), rationale: "Explicitly assessed current design", expected_basis_version: getRequirementBasisReview(await store.loadState(), gap_id).version }); }
async function row() { return (await store.loadState()).coverages.find(c => c.gap_id === gapId && c.tactic_id === tacticId)!; }
beforeEach(async () => {
 await store.resetDemoSetup();
 await wipePlatform();
 gapId = await store.createGap({ statement: "Adult comparative evidence", ...actor });
 await store.recordMissedTactic({ name: "Shared freshness study", type: "rwe_study", evidence_question: "Adult comparative outcomes", status: "ongoing", ...actor });
 tacticId = (await store.loadState()).tactics.find(t => t.name === "Shared freshness study")!.id;
 expect((await review()).status).toBe(200); expect((await link()).status).toBe(200);
});
describe("KAN-144 assessment freshness through real actions", () => {
 it.skipIf(poolSize("workspace") < 4).each(["lock_overall", "lock_dimension"])("serializes shared-tactic %s/overall reviews before either gap owner", async action => {
  const other = await store.createGap({ statement: "Independent shared-tactic decision", ...actor });
  await review(other); await link(other);
  await db().execute(sql`update coverages set needs_review = false where tactic_id = ${tacticId}`);
  const first = await row();
  const second = (await store.loadState()).coverages.find(c => c.gap_id === other)!;
  let ready!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const owner = withWorkspaceTransaction(async () => {
   await db().execute(sql`select id from tactics where id = ${tacticId} for update`);
   ready(); await resume;
  });
  await held;
  const pending = [post({ action, coverage_id: first.id, expected_version: coverageReviewVersion(first), overall: "limited", dimension: "population", value: "no", rationale: "First independent review" }),
   post({ action: "lock_overall", coverage_id: second.id, expected_version: coverageReviewVersion(second), overall: "partial", rationale: "Second independent review" })];
  try {
   // Observe actual PostgreSQL waits; no sleep decides when the owner is released.
   await vi.waitFor(async () => {
    const waiting = await db().execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from tactics where id = %for update%'`);
    expect(waiting.length).toBe(2);
   }, { timeout: 3000, interval: 20 });
  } finally { release(); await owner; await Promise.all(pending); }
  expect((await Promise.all(pending)).map(result => result.status)).toEqual([200, 200]);
  const rows = (await store.loadState()).coverages;
  expect(rows.find(c => c.id === second.id)).toMatchObject({ overall: "partial", overall_rationale: "Second independent review", needs_review: true });
  const reviewed = rows.find(c => c.id === first.id)!;
  expect(reviewed.needs_review).toBe(true);
  if (action === "lock_overall") {
   expect(reviewed).toMatchObject({ overall: "limited", overall_rationale: "First independent review" });
   expect(reviewed.assessment_history!.at(-1)!.overall).toBe("full");
  } else expect(reviewed.dimensions.population).toMatchObject({ value: "no", rationale: "First independent review", lock: { locked: true } });
 });

 it("retains freshness after titles change but invalidates every shared parent design assessment", async () => {
  const second = await store.createGap({ statement: "Another payer decision", ...actor });
  await review(second); await link(second);
  const old = await row();
  expect((await post({ action: "modify_tactic", tactic_id: tacticId, name: "Renamed study", rationale: "Correct title only" })).status).toBe(200);
  expect((await post({ action: "modify_gap", gap_id: gapId, name: "Renamed question", rationale: "Correct title only" })).status).toBe(200);
  expect((await row()).stale).toBe(false);
  expect((await post({ action: "modify_tactic", tactic_id: tacticId, comparator: "Active comparator", rationale: "Accepted protocol correction" })).status).toBe(200);
  const state = await store.loadState();
  expect(state.coverages.filter(c => c.tactic_id === tacticId).every(c => c.stale)).toBe(true);
  expect((await row()).overall_lock).toEqual(old.overall_lock);
  expect((await row()).overall).toBe("full");
  expect(displayedGapStatus(state.gaps.find(g => g.id === gapId)!)).toBe("validated_partial");
  expect(relationshipFit(state, gapId, tacticId).review_reasons.join(" ")).toMatch(/tactic design.*comparator/i);
  expect(coverageReviewVersion(await row())).not.toBe(coverageReviewVersion(old));
 });
 it("invalidates only the affected gap after a need edit and preserves confirmation history", async () => {
  const other = await store.createGap({ statement: "Independent question", ...actor }); await review(other); await link(other);
  const state = await store.loadState(), old = await row();
  const need = state.need_gap_links.find(l => l.gap_id === gapId)!.need_id;
  expect((await post({ action: "edit_need", need_id: need, statement: "Children rather than adults", rationale: "Accepted population correction" })).status).toBe(200);
  expect((await row()).stale).toBe(true);
  expect((await row()).confirmed_requirement_basis).toEqual(old.confirmed_requirement_basis);
  const after = await store.loadState();
  expect(after.coverages.find(c => c.gap_id === other)!.stale).toBe(false);
  expect((await gapRecord(gapId))!.coverages[0].fit!.review_reasons.join(" ")).toMatch(/need.*changed/i);
 });
 it("keeps sibling acknowledgement and dimension review separate from explicit current reassessment", async () => {
  const old = await row();
  await post({ action: "modify_tactic", tactic_id: tacticId, population: "Children", rationale: "Correct study population" });
  const stale = await row();
  expect((await post({ action: "lock_overall", coverage_id: old.id, overall: "full", expected_version: coverageReviewVersion(old), expected_basis_version: getRequirementBasisReview(await store.loadState(), gapId).version, rationale: "Stale open form" })).status).toBe(400);
  await post({ action: "confirm_coverage_review", coverage_id: old.id });
  expect((await row()).stale).toBe(true);
  await post({ action: "lock_dimension", coverage_id: old.id, dimension: "population", value: "yes", expected_version: coverageReviewVersion(await row()), rationale: "Reviewed changed design" });
  expect((await row()).stale).toBe(true);
  expect((await post({ action: "lock_overall", coverage_id: old.id, overall: "full", expected_version: coverageReviewVersion(await row()), expected_basis_version: getRequirementBasisReview(await store.loadState(), gapId).version, rationale: "Explicitly reassessed the current protocol" })).status).toBe(200);
  const current = await row(); expect(current.stale).toBe(false);
  expect(current.assessment_history?.some(e => e.action === "invalidate" && e.overall_lock.locked_at === old.overall_lock.locked_at)).toBe(true);
  expect(current.assessment_history?.some(e => e.action === "reassess" && e.overall_lock.locked_at === stale.overall_lock.locked_at)).toBe(true);
  expect(displayedGapStatus((await store.loadState()).gaps.find(g => g.id === gapId)!)).toBe("validated_addressed");
 });
 it("rejects a form opened at C when a real design transition returns from C to historical B", async () => {
  const original = await row();
  for (const population of ["Design B", "Design C"]) {
   expect((await post({ action: "modify_tactic", tactic_id: tacticId, population, rationale: "Accepted population amendment" })).status).toBe(200);
  }
  const atC = await row();
  expect((await post({ action: "modify_tactic", tactic_id: tacticId, population: "Design B", rationale: "Return to earlier population" })).status).toBe(200);
  const atB = await row();
  expect(coverageReviewVersion(atB)).not.toBe(coverageReviewVersion(atC));
  expect(atB.assessment_history).toHaveLength(atC.assessment_history!.length + 1);
  expect(atB.overall_lock).toEqual(original.overall_lock);
  const refused = await post({ action: "lock_overall", coverage_id: atC.id, overall: "full", expected_version: coverageReviewVersion(atC), expected_basis_version: getRequirementBasisReview(await store.loadState(), gapId).version, rationale: "Obsolete form from design C" });
  expect(refused.status).toBe(400);
  expect(await row()).toEqual(atB);
 });
 it.each([false, true])("rejects old overall and dimension tokens on an unassessed relationship (dimension confirmed: %s)", async confirmed => {
  const other = await store.createGap({ statement: "Unassessed question", ...actor });
  await review(other);
  expect((await post({ action: "assign_tactic", gap_id: other, tactic_id: tacticId, link_mode: "unassessed", request_id: crypto.randomUUID() })).status).toBe(200);
  let unassessed = (await store.loadState()).coverages.find(c => c.gap_id === other)!;
  if (confirmed) {
   expect((await post({ action: "lock_dimension", coverage_id: unassessed.id, dimension: "population", value: "yes", expected_version: coverageReviewVersion(unassessed), rationale: "Reviewed original population" })).status).toBe(200);
   unassessed = (await store.loadState()).coverages.find(c => c.id === unassessed.id)!;
  }
  expect((await post({ action: "modify_tactic", tactic_id: tacticId, population: "Different population", rationale: "Accepted design amendment" })).status).toBe(200);
  for (const action of ["lock_dimension", "lock_overall"]) {
   const result = await post({ action, coverage_id: unassessed.id, expected_version: coverageReviewVersion(unassessed), dimension: "population", value: "yes", overall: "partial", rationale: "Old form before design amendment" });
   expect(result.status, action).toBe(400);
  }
  const after = (await store.loadState()).coverages.find(c => c.id === unassessed.id)!;
  expect(after.overall).toBe("unassessed");
  expect(after.dimensions).toEqual(unassessed.dimensions);
  expect(coverageReviewVersion(after)).not.toBe(coverageReviewVersion(unassessed));
 });
 // Run with DATABASE_POOL_MAX=2 or more; a one-connection pool cannot interleave transactions.
 it.skipIf(poolSize("workspace") < 2)("keeps an independent transaction's newly reassessed relationship and complete history unchanged", async () => {
  const other = await store.createGap({ statement: "Independent B decision", ...actor });
  const otherTactic = await store.recordMissedTactic({ name: "Independent B study", type: "rwe_study", evidence_question: "Independent B evidence", status: "ongoing", ...actor });
  await review(other); await link(other, otherTactic);
  let ready!: () => void, resume!: () => void;
  const captured = new Promise<void>(resolve => { ready = resolve; });
  const proceed = new Promise<void>(resolve => { resume = resolve; });
  let backendA: unknown;
  const transactionA = withWorkspaceTransaction(async () => {
   const assessmentGapIds = await store.lockAssessmentOwners({ gap_ids: [gapId] });
   backendA = (await db().execute(sql`select pg_backend_pid() as pid`))[0].pid;
   const before = await store.loadState();
   await post({ action: "modify_gap", gap_id: gapId, statement: "Accepted A decision", rationale: "Independent A amendment" });
   ready();
   await proceed;
   // Replay A's accepted operation after B has changed and been reviewed independently.
   await store.invalidateRelationshipAssessments({ before, gap_ids: assessmentGapIds, reason: "A amendment replay", ...actor });
  });
  await Promise.race([captured, transactionA.then(() => { throw new Error("A finished before its barrier"); })]);
  let reviewedB: Awaited<ReturnType<typeof row>>;
  try {
   reviewedB = await withWorkspaceTransaction(async () => {
    const backendB = (await db().execute(sql`select pg_backend_pid() as pid`))[0].pid;
    expect(backendB).not.toBe(backendA);
    expect((await post({ action: "modify_gap", gap_id: other, statement: "Accepted B decision", rationale: "Independent B amendment" })).status).toBe(200);
    expect((await review(other)).status).toBe(200);
    const current = (await store.loadState()).coverages.find(c => c.gap_id === other)!;
    expect((await post({ action: "lock_overall", coverage_id: current.id, overall: "full", expected_version: coverageReviewVersion(current), expected_basis_version: getRequirementBasisReview(await store.loadState(), other).version, rationale: "Explicitly reassessed current B" })).status).toBe(200);
    return (await store.loadState()).coverages.find(c => c.id === current.id)!;
   });
  } finally {
   resume();
   await transactionA;
  }
  expect(reviewedB!.stale).toBe(false);
  expect(reviewedB!.assessment_history!.length).toBeGreaterThan(1);
  const afterB = (await store.loadState()).coverages.find(c => c.gap_id === other)!;
  expect(afterB).toEqual(reviewedB!);
  expect(displayedGapStatus((await store.loadState()).gaps.find(g => g.id === other)!)).toBe("validated_addressed");
 });
 it("marks a freshly reassessed relationship outdated when its rejected linked need is restored", async () => {
  const needId = (await store.loadState()).need_gap_links.find(l => l.gap_id === gapId)!.need_id;
  expect((await post({ action: "lock_need", need_id: needId, status: "rejected", note: "Requirement set aside" })).status).toBe(200);
  expect((await reassess()).status).toBe(200);
  const before = await row();
  expect(before.stale).toBe(false);
  expect((await post({ action: "restore_need", need_id: needId, note: "Restore for a new decision" })).status).toBe(200);
  const after = await row();
  expect(after.stale).toBe(true);
  expect(after.overall_lock).toEqual(before.overall_lock);
  expect(after.confirmed_requirement_basis).toEqual(before.confirmed_requirement_basis);
  expect(after.assessment_history).toHaveLength(before.assessment_history!.length + 1);
  expect(displayedGapStatus((await store.loadState()).gaps.find(g => g.id === gapId)!)).toBe("validated_partial");
 });
 it("retains Addressed with another current Full and preserves lifecycle eligibility", async () => {
  await store.recordMissedTactic({ name: "Independent study", type: "rwe_study", evidence_question: "Adult evidence", status: "ongoing", ...actor });
  const second = (await store.loadState()).tactics.find(t => t.name === "Independent study")!.id;
  await link(gapId, second);
  await post({ action: "modify_tactic", tactic_id: tacticId, comparator: "Different comparator", rationale: "Protocol changed" });
  let state = await store.loadState(); expect((await row()).stale).toBe(true);
  expect(displayedGapStatus(state.gaps.find(g => g.id === gapId)!)).toBe("validated_addressed");
  await post({ action: "lock_tactic", tactic_id: second, status: "cancelled", note: "Study cancelled" });
  state = await store.loadState(); expect(state.gaps.find(g => g.id === gapId)!.computed_status).toBe("validated_partial");
 });
 it("invalidates accepted need additions and both sides of a move", async () => {
  const extra = await store.createNeed({ gap_id: gapId, statement: "Additional requirement", rationale: "Add sourced requirement", ...actor });
  expect((await row()).stale).toBe(true);
  await review(); await post({ action: "lock_overall", coverage_id: (await row()).id, overall: "full", expected_version: coverageReviewVersion(await row()), expected_basis_version: getRequirementBasisReview(await store.loadState(), gapId).version, rationale: "Reassess with added requirement" });
  const other = await store.createGap({ statement: "Destination decision", ...actor }); await review(other); await link(other);
  expect((await post({ action: "move_need", need_id: extra, from_gap_id: gapId, to_gap_id: other, rationale: "Correct requirement ownership" })).status).toBe(200);
  expect((await row()).stale).toBe(true);
  expect((await store.loadState()).coverages.find(c => c.gap_id === other)!.stale).toBe(true);
 });
 it("marks an assessment outdated when the reviewed requirement meaning changes", async () => {
  const before = await row();
  await post({ action: "review_requirement_basis", gap_id: gapId, expected_version: getRequirementBasisReview(await store.loadState(), gapId).version, requirements: JSON.stringify({ ...required, comparator: { applicability: "required", requirement: "Active comparator required", rationale: "Decision changed" } }), rationale: "Accepted new requirement meaning" });
  expect((await row()).stale).toBe(true);
  expect((await row()).overall_lock).toEqual(before.overall_lock);
 });
 it.each(["unlink", "settings", "geography", "objective", "need status"])("invalidates the relationship after accepted %s changes", async (change) => {
  const extra = change === "unlink" ? await store.createNeed({ gap_id: gapId, statement: "Additional unlinkable need", rationale: "Supporting evidence", ...actor }) : null;
  if (extra) expect((await reassess()).status).toBe(200);
  let result;
  if (change === "unlink") result = await post({ action: "unlink_need", need_id: extra, gap_id: gapId, rationale: "Remove obsolete evidence link" });
  else if (change === "settings") result = await actionRoute(planPost, { action: "set_gap_settings", gap_id: gapId, settings: ["Specialist care"], rationale: "Accepted setting requirement" });
  else if (change === "geography") result = await actionRoute(planPost, { action: "set_gap_metadata", gap_id: gapId, metadata: { geography: "Japan" }, rationale: "Accepted geographic requirement" });
  else if (change === "objective") result = await post({ action: "set_gap_objective", gap_id: gapId, objective_id: (await store.loadState()).objectives[1]!.id, rationale: "Accepted decision linkage" });
  else result = await post({ action: "lock_need", need_id: (await store.loadState()).need_gap_links.find(l => l.gap_id === gapId)!.need_id, status: "rejected", note: "Requirement withdrawn" });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect((await row()).stale).toBe(true);
 });
 it("keeps objective titles, owners and gap notes cosmetic but invalidates objective meaning", async () => {
  const context = setupContextFromState(await store.loadState());
  // Normalize the wizard context first; this may fill previously absent meaning fields.
  await post({ action: "save_product_setup", context }); await reassess();
  const current = setupContextFromState(await store.loadState());
  current.objectives = current.objectives.map(o => ({ ...o, name: `${o.name} title`, owner: "New administrator" }));
  expect((await post({ action: "save_product_setup", context: current })).status).toBe(200);
  expect((await actionRoute(planPost, { action: "set_gap_metadata", gap_id: gapId, metadata: { notes: "Administrative meeting note" }, rationale: "Add context note" })).status).toBe(200);
  expect((await row()).stale).toBe(false);
  current.objectives[0]!.key_decision = "A different regulatory decision";
  expect((await post({ action: "save_product_setup", context: current })).status).toBe(200);
  expect((await row()).stale).toBe(true);
 });
 it("preserves quoted support when unrelated passages, headings and surrounding context change", async () => {
  const source = await createManualSource({ title: "Source passage fixture", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "Adults need comparative evidence." }, { text: "Unrelated operational notes." }], rationale: "Source fixture", actor: { name: actor.actor_name, function: actor.actor_function } });
  const cited = source.blocks[0]!, unrelated = source.blocks[1]!;
  gapId = await store.createGap({ statement: "Source-backed question", source_id: source.source_id, source_quote: "Adults need comparative evidence.", need_provenance: { block_id: cited.id }, ...actor });
  await review(); await link(); const original = await row();
  for (const edit of [{ block_id: cited.id, heading: "Corrected heading" }, { block_id: unrelated.id, text: "Unrelated operational notes updated." }]) {
   const result = await actionRoute(sourcePost, { action: "edit", ...edit, rationale: "Accepted source edit" });
   expect(result.status, JSON.stringify(result.body)).toBe(200); expect((await row()).stale).toBe(false);
  }
  const result = await actionRoute(sourcePost, { action: "edit", block_id: cited.id, text: "Adults need comparative evidence. The new protocol also includes children.", rationale: "Accepted source correction" });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect((await row()).stale).toBe(false); expect((await row()).overall_lock).toEqual(original.overall_lock);
  const refused = await actionRoute(sourcePost, { action: "edit", block_id: cited.id, text: "Children need different evidence.", rationale: "Remove cited support" });
  expect(refused.status).toBe(409); expect((await row()).stale).toBe(false);
 });
 it.each([true, false])("preserves cited meaning across split/merge (quoted: %s), then detects changed support", async quoted => {
  const support = "Adults need comparative evidence. Children need separate evidence.";
  const source = await createManualSource({ title: "Structural support", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "Unrelated preface." }, { text: support }], rationale: "Source fixture", actor: { name: actor.actor_name, function: actor.actor_function } });
  const cited = source.blocks[1]!;
  gapId = await store.createGap({ statement: "Structural source question", source_id: source.source_id, source_quote: "Children need separate evidence.", need_provenance: { block_id: cited.id }, ...actor });
  const state = await store.loadState(), need = state.needs.find(n => state.need_gap_links.some(l => l.gap_id === gapId && l.need_id === n.id))!;
  if (!quoted) { need.source_quote = ""; await store.persistState(state); }
  await review(); await link(); const original = await row();
  const split = await actionRoute(sourcePost, { action: "split", block_id: cited.id, at_text: "Children", rationale: "Separate paragraphs without changing text" });
  expect(split.status, JSON.stringify(split.body)).toBe(200); expect((await row()).stale).toBe(false);
  const splitNeed = (await store.loadState()).needs.find(n => n.id === need.id)!;
  if (quoted) expect(splitNeed.block_id).toBe(split.body.second_id);
  else expect(splitNeed.source_basis_text).toBe(support);
  const merged = await actionRoute(sourcePost, { action: "merge", block_id: cited.id, rationale: "Recombine supporting paragraphs" });
  expect(merged.status, JSON.stringify(merged.body)).toBe(200); expect((await row()).stale).toBe(false);
  const absorbed = await actionRoute(sourcePost, { action: "merge", block_id: source.blocks[0]!.id, rationale: "Absorb cited block into its predecessor" });
  expect(absorbed.status, JSON.stringify(absorbed.body)).toBe(200); expect((await row()).stale).toBe(false);
  const retained = await store.loadState(); await store.persistState(retained);
  expect((await store.loadState()).needs.find(n => n.id === need.id)).toEqual(retained.needs.find(n => n.id === need.id));
  expect((await row()).overall_lock).toEqual(original.overall_lock);
  if (quoted) {
   const changed = await post({ action: "edit_need", need_id: need.id, source_quote: "Adults need comparative evidence.", rationale: "Deliberately change supporting citation" });
   expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  } else {
   // A deliberate citation change must discard the old structural retention.
   const recited = await post({ action: "edit_need", need_id: need.id, source_quote: "Adults need comparative evidence.", rationale: "Choose narrower supporting citation" });
   expect(recited.status, JSON.stringify(recited.body)).toBe(200);
   expect((await row()).stale).toBe(true);
   expect((await store.loadState()).needs.find(n => n.id === need.id)?.source_basis_text).toBeNull();
   await store.persistState(retained);
   const changed = await actionRoute(sourcePost, { action: "edit", block_id: source.blocks[0]!.id, text: "Unrelated preface. Adults need comparative evidence. Children need different evidence.", rationale: "Change actual retained support" });
   expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  }
  expect((await row()).stale).toBe(true); expect((await row()).overall_lock).toEqual(original.overall_lock);
  expect((await store.loadState()).needs.find(n => n.id === need.id)?.source_basis_text).toBeNull();
 });
 it.each(["merge", "split"])("invalidates accepted S2 %s membership with its own-basis reason", async decision => {
  const source = await createManualSource({ title: "Incoming source", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "Comparative evidence in children is also required." }], rationale: "Source fixture", actor: { name: actor.actor_name, function: actor.actor_function } });
  const result = await store.commitExtractedRecords({ source_id: source.source_id, title: "Incoming source", stakeholder_function: "medical_affairs", ...actor, needs: [], gaps: [], tactics: [], overlaps: [{ id: "freshness-overlap", run_id: "freshness-run", gap_id: gapId, name: "Children", statement: "Comparative evidence in children", domain: "comparative_effectiveness", source_quote: "Comparative evidence in children is also required.", shared_part: "Comparative evidence", new_part: "Children", merged_name: "Adult and child evidence", merged_statement: "Comparative adult and child evidence", split_name: "Children", split_statement: "Comparative child evidence" }] });
  expect((await row()).stale).toBe(false);
  const accepted = await post({ action: `accept_gap_${decision}`, suggestion_id: result.suggestion_id_by_row["freshness-overlap"], rationale: "Accepted incoming evidence scope" });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect((await row()).stale).toBe(true); expect((await row()).needs_review).toBe(false);
 });
 it("does not duplicate invalidation history when the shared accepted-edit operation is retried", async () => {
  await withWorkspaceTransaction(async () => {
   const assessmentGapIds = await store.lockAssessmentOwners({ tactic_ids: [tacticId] });
   const before = await store.loadState();
   await store.modifyTactic({ tactic_id: tacticId, fields: { comparator: "New comparator" }, rationale: "Accepted correction", ...actor });
   const count = (await row()).assessment_history!.length;
   expect(await store.invalidateRelationshipAssessments({ before, gap_ids: assessmentGapIds, reason: "Retry accepted correction", ...actor })).toEqual([]);
   expect((await row()).assessment_history).toHaveLength(count);
  });
 });
 it("preserves the approved final snapshot and saves a new final revision only after current reassessment", async () => {
  expect((await post({ action: "validate_gap", gap_id: gapId, note: "Confirm the final inventory question" })).status).toBe(200);
  const activity = await actionRoute(planPost, { action: "add_activity", tactic_id: tacticId, start_date: "2027-01-01", end_date: "2027-06-01", rationale: "Date the final-plan activity" });
  expect(activity.status, JSON.stringify(activity.body)).toBe(200);
  const saved = await actionRoute(planPost, { action: "save_plan", status: "final", rationale: "Approve the initial inventory" });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const original = saved.body.plan;
  await post({ action: "modify_tactic", tactic_id: tacticId, comparator: "Updated active comparator", rationale: "Accepted protocol amendment" });
  const blocked = await actionRoute(planPost, { action: "save_plan", status: "final", rationale: "Cannot approve before reassessment" });
  expect(blocked.status).toBe(400); expect(blocked.body.error).toMatch(/Partially Addressed/);
  expect(await planVersion(original.version)).toEqual(original);
  expect((await reassess()).status).toBe(200);
  expect((await post({ action: "validate_gap", gap_id: gapId, note: "Confirm the reassessed inventory" })).status).toBe(200);
  const revised = await actionRoute(planPost, { action: "save_plan", status: "final", rationale: "Approve the reassessed revised inventory" });
  expect(revised.status, JSON.stringify(revised.body)).toBe(200);
  expect(revised.body.plan.version).toBe(original.version + 1);
  expect(revised.body.plan.snapshot.package_fingerprint).not.toBe(original.snapshot.package_fingerprint);
  expect(await planVersion(original.version)).toEqual(original);
 });

});
