import { openingActionTokens } from "./support/opening-action-tokens";
/** Incoming comparison exercises real parse, ingestion actions and retained review outcomes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
 get: (name: string) => jar.values.has(name) ? { value: jar.values.get(name)! } : undefined,
 set: (name: string, value: string) => void jar.values.set(name, value),
 delete: (name: string) => void jar.values.delete(name),
}), headers: async () => new Headers() }));
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/iegp/db";
import type { IegpState } from "@/lib/iegp/types";
import type { ComparisonOutcome } from "@/lib/ingest/comparison-types";
import { sourceComparisons, sourceReviews } from "@/lib/iegp/schema";
import { acceptTacticExpansion, tacticVersion } from "@/lib/iegp/tactic-expansions";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceComparisonStatus } from "@/components/source-comparison-status";
import { createSession } from "@/modules/auth/session";
import { createWorkspace } from "@/modules/workspaces/store";
import { selectWorkspace } from "@/modules/workspaces/session";
import { runInWorkspace } from "@/modules/workspaces/context";
import { POST as blockPost } from "@/app/api/sources/blocks/route";
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { advanceIngest } from "@/app/api/iegp/ingest-pipeline";
import { getRun } from "@/modules/kernel/observability";
import { runStage } from "@/modules/kernel/run";
import { findProvider } from "@/modules/llm/provider";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";
import { setAiEnabled } from "@/modules/kernel/ai-switch";
import { wipePlatform } from "@/modules/kernel/db";
import * as store from "@/lib/iegp/store";
import * as reviews from "@/lib/iegp/source-review";
import { attachTacticSource } from "@/modules/stages/s3-tactic-extract/suggestions";
const actor = { name: "Incoming reviewer", function: "medical_affairs" as const };
const fields = { actor_name: actor.name, actor_function: actor.function };
const file = { title: "Incoming protocol", filename: "protocol.txt", source_type: "advisory_board" as const, stakeholder_function: actor.function, text: "The study includes children only. Outcomes improved. The appendix has no relevant scientific information." };
let gap: string, tactic: string, coverage: string;
/** Only the comparison prompt fields inspected by these provider doubles. */
type ComparisonInput = Pick<IegpState, "blocks" | "gaps"> & {
 tactic_source_provenance: { tactic_id: string; source_id: string; passage: string; retained: boolean }[];
 provenance_source_ids: string[];
};
let respond: (input: ComparisonInput) => unknown | Promise<unknown>;
let calls: ComparisonInput[];
async function post(body: Record<string, unknown>) { const response = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, ...await openingActionTokens(body), ...body }) })); return { status: response.status, body: await response.json() }; }
async function parse() { await runStage({ stage: "S0", input: { files: [file] }, actor, role: "medical_affairs" }); return runStage({ stage: "S1", input: {}, actor, role: "medical_affairs" }); }
async function comparison() { const { listSourceComparisons } = await import("@/lib/ingest/compare-source"); return (await listSourceComparisons())[0]; }
function outcome(input: ComparisonInput, judgment: ComparisonOutcome["judgment"] = "conflict", extra: Partial<ComparisonOutcome> = {}): ComparisonOutcome { return { block_id: input.blocks[0].id, passage: "The study includes children only.", match: "same", judgment, gap_id: gap, tactic_id: tactic, coverage_id: coverage, rationale: "The source challenges the adult population", ...extra }; }
beforeEach(async () => {
 jar.values.clear();
 await store.resetDemoSetup(); await wipePlatform(["source_files", "parsed_documents"]); await setAiEnabled({ enabled: true, actor_name: actor.name });
 gap = await store.createGap({ statement: "Adult comparative outcomes", ...fields });
 tactic = await store.recordMissedTactic({ name: "Adult study", type: "rwe_study", evidence_question: "Adult comparative outcomes", population: "Adults", status: "ongoing", ...fields });
 await post({ action: "assign_tactic", gap_id: gap, tactic_id: tactic, overall: "partial", rationale: "Original human judgement" });
 coverage = (await store.loadState()).coverages.find(c => c.gap_id === gap)!.id;
 calls = []; respond = input => ({ outcomes: [outcome(input)] });
 vi.stubEnv("XAI_API_KEY", "task146-deterministic-provider");
 vi.spyOn(findProvider("xai-grok")!, "complete").mockImplementation(async request => { const input = JSON.parse(request.user) as ComparisonInput; calls.push(input); return JSON.stringify(await respond(input)); });
});
afterEach(async () => { jar.values.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await setAiEnabled({ enabled: true, actor_name: actor.name }); });
describe("KAN-146 incoming document comparison", () => {
 it("keeps intentional dry parsing free of comparison checkpoints and checkpoint errors", async () => {
  await runStage({ stage: "S0", input: { files: [file] }, actor, role: "medical_affairs" });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await runStage({ stage: "S1", input: { dry_run: true }, actor, role: "medical_affairs" });
  expect((await store.loadState()).source_comparisons).toHaveLength(0);
  expect(errors).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
 });
 it.each([false, true])("persists the comparison provider run lifecycle (failure=%s)", async failure => {
  if (failure) respond = () => { throw new Error("Traceable provider failure"); };
  await parse();
  const checkpoint = await comparison();
  const run = await getRun(checkpoint.version);
  expect(run).toMatchObject({ module_id: "incoming-source-comparison", status: failure ? "error" : "ok", route: { provider_id: "xai-grok" }, finished_at: expect.any(String) });
  expect(run!.steps.some(step => step.name.startsWith("llm:"))).toBe(true);
  if (failure) expect(run!.error).toContain("Traceable provider failure");
  else expect(run!.output).toMatchObject({ outcomes: [expect.objectContaining({ coverage_id: coverage })] });
 });

 it("compares a direct parse against current plan records and preserves the human verdict", async () => {
  const before = await store.loadState(); await parse();
  expect((await listParsedDocuments())).toHaveLength(1);
  expect(await comparison()).toMatchObject({ status: "completed", basis_current: true });
  const after = await store.loadState(); expect(after.source_reviews).toHaveLength(1);
  expect(after.source_reviews![0]).toMatchObject({ kind: "discrepancy", origin: "ai", status: "pending", coverage_id: coverage });
  expect(after.coverages).toEqual(before.coverages); expect(after.gaps).toEqual(before.gaps);
  expect(calls[0].gaps.some((g) => g.id === gap)).toBe(true);
 });
 it("links support, treats unknown as neither agreement nor discrepancy, and ignores unrelated new claims", async () => {
  respond = input => ({ outcomes: [outcome(input, "support", { match: "overlaps" }), outcome(input, "unknown", { passage: "Outcomes improved." }), outcome(input, "unknown", { match: "new", gap_id: null, tactic_id: null, coverage_id: null, passage: "The appendix has no relevant scientific information." })] });
  await parse(); expect(await comparison()).toMatchObject({ status: "completed" });
  expect((await store.loadState()).source_reviews).toEqual([expect.objectContaining({ kind: "support" })]);
 });
 it("keeps successful parse and usable blocks when the provider fails, including pipeline checkpoints, and retries via public action", async () => {
  respond = () => { throw new Error("Comparison provider unavailable"); };
  const first = await advanceIngest({ files: [file], actor, role: "medical_affairs" });
  expect(await advanceIngest({ actor, role: "medical_affairs", job_id: first.job_id })).toMatchObject({ completed: 2 });
  const saved = await comparison(); expect(saved).toMatchObject({ status: "failed" }); expect(saved.error).toContain("unavailable");
  expect((await listSourceFiles())[0].status).toBe("parsed"); expect((await store.loadState()).blocks.length).toBeGreaterThan(0);
  respond = input => ({ outcomes: [outcome(input, "support")] });
  expect((await post({ action: "retry_source_comparison", source_id: saved.source_id })).status).toBe(200);
  expect(await comparison()).toMatchObject({ status: "completed" });
 });
 it("contains comparison failure on direct parsing paths too", async () => {
  respond = () => { throw new Error("Direct comparison failure"); }; await expect(parse()).resolves.toBeDefined();
  expect(await comparison()).toMatchObject({ status: "failed" }); expect(await listParsedDocuments()).toHaveLength(1);
 });
 it("persists AI-disabled independently and leaves manual review available", async () => {
  respond = async input => { await setAiEnabled({ enabled: false, actor_name: actor.name }); return { outcomes: [outcome(input)] }; };
  await parse(); expect(await comparison()).toMatchObject({ status: "ai_disabled" });
  expect(await listParsedDocuments()).toHaveLength(1); expect((await store.loadState()).source_reviews).toHaveLength(0);
  const sourceId = (await comparison()).source_id;
  const source = (await store.loadState()).sources.find(s => s.id === sourceId)!, block = (await store.loadState()).blocks.find(b => b.source_id === source.id)!;
  expect((await post({ action: "create_source_discrepancy", source_id: source.id, block_id: block.id, passage: "The study includes children only.", gap_id: gap, rationale: "Human can still review this source" })).status).toBe(200);
 });
 it("rejects invalid citations, foreign targets and mismatched relationships without declaring a clean result", async () => {
  for (const extra of [{ passage: "Invented model quote" }, { gap_id: "foreign-gap" }, { coverage_id: "foreign-coverage" }]) {
   respond = input => ({ outcomes: [outcome(input, "conflict", extra)] });
   if (!(await listParsedDocuments()).length) await parse(); else await post({ action: "retry_source_comparison", source_id: (await comparison()).source_id });
   expect(await comparison()).toMatchObject({ status: "failed" }); expect((await store.loadState()).source_reviews).toHaveLength(0);
  }
 });
 it("rechecks basis changes made while the model runs and never marks that basis checked", async () => {
  respond = async input => { await post({ action: "modify_tactic", tactic_id: tactic, population: "All ages", rationale: "Concurrent current scientific basis" }); return { outcomes: [outcome(input)] }; };
  await parse(); expect(await comparison()).toMatchObject({ status: "failed", basis_current: false }); expect((await store.loadState()).source_reviews).toHaveLength(0);
  respond = input => ({ outcomes: [outcome(input, "unknown")] });
  await post({ action: "retry_source_comparison", source_id: (await comparison()).source_id }); expect(await comparison()).toMatchObject({ status: "completed", basis_current: true });
 });
 it("resumes durable partial outcomes without another model call or duplicate paraphrased findings", async () => {
  respond = input => ({ outcomes: [outcome(input), outcome(input, "support", { passage: "Outcomes improved." })] });
  const original = reviews.linkSourceSupport;
  const failure = vi.spyOn(reviews, "linkSourceSupport").mockRejectedValueOnce(new Error("Interrupted outcome application"));
  await parse(); expect(await comparison()).toMatchObject({ status: "failed" }); expect((await store.loadState()).source_reviews).toHaveLength(1);
  const finding = (await store.loadState()).source_reviews![0];
  await post({ action: "resolve_source_discrepancy", review_id: finding.id, expected_version: finding.version, decision: "dismiss", rationale: "Human reviewed the saved concern" });
  failure.mockImplementation(original); const savedCalls = calls.length;
  respond = input => ({ outcomes: [outcome(input, "conflict", { rationale: "A paraphrase of the same conflict" })] });
  await post({ action: "retry_source_comparison", source_id: finding.source_id });
  expect(calls.length).toBe(savedCalls); expect(await comparison()).toMatchObject({ status: "completed" });
  expect((await store.loadState()).source_reviews).toHaveLength(2); expect((await store.loadState()).source_reviews!.find(r => r.id === finding.id)!.status).toBe("dismissed");
  await runStage({ stage: "S1", input: { file_ids: [(await listSourceFiles())[0].id] }, actor, role: "medical_affairs" });
  expect((await store.loadState()).source_reviews).toHaveLength(2); expect((await store.loadState()).source_reviews!.find(r => r.id === finding.id)!.status).toBe("dismissed");
 });
 it("shows changed completed basis as needing a new check and keeps accepted human changes on reprocessing", async () => {
  await parse(); const finding = (await store.loadState()).source_reviews![0]; const before = await store.loadState();
  await post({ action: "resolve_source_discrepancy", review_id: finding.id, expected_version: finding.version, expected_target_version: reviews.sourceReviewTargetVersion(before, finding, "tactic"), decision: "accept", reviewed_change: "true", correction_target: "tactic", correction_field: "population", correction_value: "Children", rationale: "Human reviewed underlying protocol change" });
  expect(await comparison()).toMatchObject({ status: "pending", basis_current: false });
  respond = input => ({ outcomes: [outcome(input, "conflict", { rationale: "Paraphrased same population concern" })] });
  await post({ action: "retry_source_comparison", source_id: finding.source_id });
  const after = await store.loadState(); expect(after.source_reviews).toHaveLength(1); expect(after.source_reviews![0].status).toBe("accepted"); expect(after.tactics.find(t => t.id === tactic)!.population).toBe("Children");
 });
 it.each([
  ["accept", "explicit"], ["accept", "omitted"], ["dismiss", "explicit"], ["dismiss", "omitted"],
 ] as const)("preserves the %s decision after a basis change from an %s relationship encoding", async (decision, firstEncoding) => {
  respond = input => ({ outcomes: [outcome(input, "conflict", { coverage_id: firstEncoding === "explicit" ? coverage : null })] });
  await parse(); const before = await store.loadState(); const finding = before.source_reviews![0];
  expect((await post({ action: "resolve_source_discrepancy", review_id: finding.id, expected_version: finding.version,
   decision, rationale: "Human reviewed this population concern", ...(decision === "accept" ? {
    expected_target_version: reviews.sourceReviewTargetVersion(before, finding, "tactic"), reviewed_change: "true",
    correction_target: "tactic", correction_field: "population", correction_value: "Children",
   } : {}) })).status).toBe(200);
  const decided = (await store.loadState()).source_reviews![0];
  expect((await post({ action: "modify_tactic", tactic_id: tactic, population: "All ages", rationale: "New reviewed population basis" })).status).toBe(200);
  expect(await comparison()).toMatchObject({ status: "pending", basis_current: false });
  respond = input => ({ outcomes: [outcome(input, "conflict", { coverage_id: firstEncoding === "explicit" ? null : coverage, rationale: "Paraphrased population concern" })] });
  expect((await post({ action: "retry_source_comparison", source_id: finding.source_id })).status).toBe(200);
  expect((await store.loadState()).source_reviews).toEqual([decided]);
  expect(await comparison()).toMatchObject({ status: "completed", basis_current: true, outcomes: [expect.objectContaining({ coverage_id: coverage })] });
 });
 it.each([
  ["accept", "explicit"], ["accept", "omitted"], ["dismiss", "explicit"], ["dismiss", "omitted"],
 ] as const)("normalizes legacy saved outcomes against the %s decision on a legacy %s review during durable retry", async (decision, reviewEncoding) => {
  await parse(); const before = await store.loadState(); const finding = before.source_reviews![0];
  expect((await post({ action: "resolve_source_discrepancy", review_id: finding.id, expected_version: finding.version,
   decision, rationale: "Human reviewed the legacy population concern", ...(decision === "accept" ? {
    expected_target_version: reviews.sourceReviewTargetVersion(before, finding, "tactic"), reviewed_change: "true",
    correction_target: "tactic", correction_field: "population", correction_value: "Children",
   } : {}) })).status).toBe(200);
  // Refresh the accepted correction's basis, then simulate pre-normalization persisted data.
  expect((await post({ action: "retry_source_comparison", source_id: finding.source_id })).status).toBe(200);
  const decided = { ...(await store.loadState()).source_reviews![0], coverage_id: reviewEncoding === "explicit" ? coverage : null };
  await db().update(sourceReviews).set({ record: decided }).where(eq(sourceReviews.id, decided.id));
  const saved = (await store.loadState()).source_comparisons![0];
  const legacyOutcomes = saved.outcomes!.map(row => ({ ...row, coverage_id: reviewEncoding === "explicit" ? null : coverage, rationale: "Saved paraphrase from an interrupted old attempt" }));
  await db().update(sourceComparisons).set({ record: { ...saved, status: "failed", outcomes: legacyOutcomes, error: "Interrupted old attempt" } }).where(eq(sourceComparisons.source_id, saved.source_id));
  const callCount = calls.length;
  expect((await post({ action: "retry_source_comparison", source_id: saved.source_id })).status).toBe(200);
  expect(calls).toHaveLength(callCount);
  expect((await store.loadState()).source_reviews).toEqual([decided]);
  expect(await comparison()).toMatchObject({ status: "completed", outcomes: [expect.objectContaining({ coverage_id: coverage })] });
 });
 it.each([
  ["coverage_id", "model"], ["gap_id", "model"], ["tactic_id", "model"],
  ["coverage_id", "saved"], ["gap_id", "saved"], ["tactic_id", "saved"],
 ] as const)("normalizes empty %s in a %s reply against a decided missing-target encoding", async (field, mode) => {
  const target = { coverage_id: null, [field]: null };
  respond = input => ({ outcomes: [outcome(input, "conflict", target)] });
  await parse(); const finding = (await store.loadState()).source_reviews![0];
  expect((await post({ action: "resolve_source_discrepancy", review_id: finding.id, expected_version: finding.version, decision: "dismiss", rationale: "Human reviewed this omitted-target concern" })).status).toBe(200);
  const callCount = calls.length;
  if (mode === "saved") {
   // Older JSON records may omit a nullable key entirely; keep that immutable review intact.
   await db().update(sourceReviews).set({ record: sql`${sourceReviews.record} - ${field}::text` }).where(eq(sourceReviews.id, finding.id));
   const saved = (await store.loadState()).source_comparisons![0];
   await db().update(sourceComparisons).set({ record: { ...saved, status: "failed", outcomes: saved.outcomes!.map(row => ({ ...row, [field]: "", rationale: "Legacy paraphrase of this omitted-target concern" })) } }).where(eq(sourceComparisons.source_id, saved.source_id));
  } else {
   await post({ action: "modify_tactic", tactic_id: tactic, population: "All ages", rationale: "Changed scientific basis for omitted-target recheck" });
   respond = input => ({ outcomes: [outcome(input, "conflict", { ...target, [field]: "", rationale: "New paraphrase of this omitted-target concern" })] });
  }
  const decided = (await store.loadState()).source_reviews;
  expect((await post({ action: "retry_source_comparison", source_id: finding.source_id })).status).toBe(200);
  if (mode === "saved") expect(calls).toHaveLength(callCount);
  expect((await store.loadState()).source_reviews).toEqual(decided);
  expect(await comparison()).toMatchObject({ status: "completed", outcomes: [expect.objectContaining({ [field]: field === "coverage_id" ? coverage : null })] });
 });
 it("keeps explicit parent and sibling expansion concerns distinct across a public recheck", async () => {
  const parent = (await store.loadState()).tactics.find(row => row.id === tactic)!;
  const scope = { name: "Added paediatric scope", evidence_question: "Paediatric outcomes", population: "Children", outcomes: "", geography: "", data_cut: "", analysis: "", instrument: "", study_design: "Cohort", gap_coverage: "Paediatric outcomes", cost_effort: "One team", timing: "Next year", feasibility_risks: "Recruitment", post_hoc: false, prospective_enrolment: false, protocol_amendment: true, start_date: null, evidence_available: null };
  for (const [name, population] of [["Child", "Children"], ["Sibling", "Adolescents"]]) await acceptTacticExpansion({ proposal_id: `comparison-${name}`, tactic_id: tactic, gap_id: gap, scope: { ...scope, name, population }, rationale: "Reviewed separate additional scope", actor, expected_tactic_version: tacticVersion(parent) });
  const ids = (await store.loadState()).coverages.filter(row => row.gap_id === gap && row.tactic_id === tactic).map(row => row.id);
  expect(ids).toHaveLength(3);
  respond = input => ({ outcomes: ids.map(id => outcome(input, "conflict", { coverage_id: id })) });
  await parse(); const findings = (await store.loadState()).source_reviews!;
  expect(new Set(findings.map(row => row.coverage_id))).toEqual(new Set(ids));
  for (const finding of findings) expect((await post({ action: "resolve_source_discrepancy", review_id: finding.id, expected_version: finding.version, decision: "dismiss", rationale: "Human reviewed this separate scope" })).status).toBe(200);
  const decided = (await store.loadState()).source_reviews;
  await post({ action: "modify_tactic", tactic_id: tactic, population: "All ages", rationale: "Changed parent scientific basis" });
  expect((await post({ action: "retry_source_comparison", source_id: findings[0].source_id })).status).toBe(200);
  expect((await store.loadState()).source_reviews).toEqual(decided);
  expect(await comparison()).toMatchObject({ status: "completed" });
 });
 it.each(["model", "saved"] as const)("rejects ambiguous omitted expansion scope in an entire %s reply before applying outcomes", async mode => {
  const parent = (await store.loadState()).tactics.find(row => row.id === tactic)!;
  await acceptTacticExpansion({ proposal_id: "comparison-ambiguous", tactic_id: tactic, gap_id: gap,
   scope: { name: "Paediatric scope", evidence_question: "Paediatric outcomes", population: "Children", outcomes: "", geography: "", data_cut: "", analysis: "", instrument: "", study_design: "Cohort", gap_coverage: "Paediatric outcomes", cost_effort: "One team", timing: "Next year", feasibility_risks: "Recruitment", post_hoc: false, prospective_enrolment: false, protocol_amendment: true, start_date: null, evidence_available: null },
   rationale: "Reviewed additional scope", actor, expected_tactic_version: tacticVersion(parent) });
  const reply = (input: ComparisonInput) => ({ outcomes: [outcome(input, "support"), outcome(input, "conflict", { coverage_id: null })] });
  respond = mode === "model" ? reply : input => ({ outcomes: [outcome(input, "conflict")] });
  await parse();
  let decided: NonNullable<Awaited<ReturnType<typeof store.loadState>>["source_reviews"]>[number] | undefined;
  if (mode === "saved") {
   const finding = (await store.loadState()).source_reviews![0];
   expect((await post({ action: "resolve_source_discrepancy", review_id: finding.id, expected_version: finding.version, decision: "dismiss", rationale: "Human reviewed before the interrupted legacy batch" })).status).toBe(200);
   decided = (await store.loadState()).source_reviews!.find(row => row.id === finding.id);
   const saved = (await store.loadState()).source_comparisons![0];
   await db().update(sourceComparisons).set({ record: { ...saved, status: "failed", outcomes: reply(calls[0]).outcomes, error: "Interrupted old ambiguous reply" } }).where(eq(sourceComparisons.source_id, saved.source_id));
   const callCount = calls.length;
   expect((await post({ action: "retry_source_comparison", source_id: saved.source_id })).status).toBe(200);
   expect(calls).toHaveLength(callCount);
  }
  expect(await comparison()).toMatchObject({ status: "failed", error: expect.stringContaining("explicit relationship") });
  expect((await store.loadState()).source_reviews).toEqual(decided ? [decided] : []);
  const failed = await comparison();
  respond = input => ({ outcomes: [outcome(input, "support"), outcome(input, "conflict")] });
  const previousCalls = calls.length;
  expect((await post({ action: "retry_source_comparison", source_id: failed.source_id })).status).toBe(200);
  expect(await comparison()).toMatchObject({ status: "completed", basis_current: true });
  expect(calls).toHaveLength(previousCalls + 1);
  expect((await store.loadState()).source_reviews).toHaveLength(2);
  if (decided) expect((await store.loadState()).source_reviews!.find(row => row.id === decided.id)).toEqual(decided);
 });
 it("persists pending before prompting and refuses an older concurrent completion", async () => {
  respond = async input => {
   const pending = await comparison();
   expect(pending).toMatchObject({ status: "pending" });
   if (calls.length === 1) {
    // A real public retry completes while the older provider request is still awaiting its result.
    expect((await post({ action: "retry_source_comparison", source_id: pending.source_id })).status).toBe(200);
    return { outcomes: [outcome(input, "conflict")] };
   }
   return { outcomes: [outcome(input, "support")] };
  };
  await parse(); expect(calls).toHaveLength(2);
  expect((await store.loadState()).source_reviews).toEqual([expect.objectContaining({ kind: "support" })]);
  expect(await comparison()).toMatchObject({ status: "completed", basis_current: true });
 });
 it("keeps actual foreign-plan records out of prompts and rejects a model-returned cross-plan target", async () => {
  const workspace = await createWorkspace({ name: "Foreign incoming comparison", owner: "foreign-comparison@example.test" });
  const foreignGap = await runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, () => store.createGap({ statement: "Foreign plan only scientific question", ...fields }));
  respond = input => {
   expect(input.gaps.some((row) => row.id === foreignGap)).toBe(false);
   return { outcomes: [outcome(input, "conflict", { gap_id: foreignGap, tactic_id: null, coverage_id: null })] };
  };
  await parse(); expect(await comparison()).toMatchObject({ status: "failed" });
  expect((await store.loadState()).source_reviews).toHaveLength(0);
  await runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, async () => {
   expect((await store.loadState()).source_reviews).toHaveLength(0);
   expect((await store.loadState()).gaps[0].statement).toBe("Foreign plan only scientific question");
  });
 });
 it("refuses viewer retry despite a spoofed reviewer role", async () => {
  respond = () => { throw new Error("Temporary failure"); }; await parse(); const saved = await comparison();
  const email = "comparison-viewer@example.test";
  await createSession({ provider_id: "demo", subject: email, email, actor_name: "Viewer", actor_function: "medical_affairs", role: "viewer" });
  const workspace = await createWorkspace({ name: "Viewer incoming comparison", owner: email });
  await selectWorkspace(workspace.id);
  expect((await post({ action: "retry_source_comparison", source_id: saved.source_id, role: "medical_affairs" })).status).toBe(403);
  jar.values.clear(); expect(await comparison()).toEqual(saved);
 });
 it("detects a changed retained passage while the model is running", async () => {
  respond = async input => {
   const response = await blockPost(new Request("http://localhost/api/sources/blocks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, action: "edit", block_id: input.blocks[0].id, text: "The study now includes all ages.", rationale: "Human source correction during check" }) }));
   expect(response.status).toBe(200);
   return { outcomes: [outcome(input)] };
  };
  await parse(); expect(await comparison()).toMatchObject({ status: "failed", basis_current: false });
  expect((await store.loadState()).source_reviews).toHaveLength(0);
 });
 it.each(["removed", "changed", "surrounding", "unrelated"] as const)("versions a standalone target's actual cited provenance (%s)", async change => {
  const blockAction = async (body: Record<string, unknown>) => {
   const response = await blockPost(new Request("http://localhost/api/sources/blocks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, rationale: "Reviewed target source edit", ...body }) }));
   const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result;
  };
  const quote = "The protocol enrols adults only.";
  const source = await blockAction({ action: "manual_source", title: "Existing target protocol", source_type: "advisory_board", stakeholder_function: actor.function, blocks: [{ text: quote }, { text: "Unrelated administration." }] });
  const standalone = await store.recordMissedTactic({ name: "Unmapped adult protocol", type: "rwe_study", evidence_question: "Adult outcomes", population: "Adults", status: "ongoing", ...fields });
  await attachTacticSource({ tactic_id: standalone, source_id: source.source_id, source_quote: quote });
  expect((await store.loadState()).coverages.some(row => row.tactic_id === standalone)).toBe(false);
  respond = async input => {
   expect(input.tactic_source_provenance).toContainEqual({ tactic_id: standalone, source_id: source.source_id, passage: quote, retained: true });
   expect(input.provenance_source_ids).toContain(source.source_id);
   const text = change === "removed" ? "Administrative notes only." : change === "changed" ? "The protocol enrols children only." : change === "surrounding" ? `Updated preface. ${quote} Updated appendix.` : "Updated administration.";
   await blockAction({ action: "edit", block_id: source.block_ids[change === "unrelated" ? 1 : 0], text });
   return { outcomes: [outcome(input, "conflict", { gap_id: null, tactic_id: standalone, coverage_id: null })] };
  };
  await parse();
  const changed = change === "removed" || change === "changed";
  expect(await comparison()).toMatchObject({ status: changed ? "failed" : "completed", basis_current: !changed });
  expect((await store.loadState()).source_reviews).toHaveLength(changed ? 0 : 1);
  expect(await listParsedDocuments()).toHaveLength(1);
 });
 it("preserves source content and saved outcomes when a later invalid model outcome rejects the whole reply", async () => {
  respond = input => ({ outcomes: [outcome(input, "support"), outcome(input, "conflict", { passage: "Fabricated later claim" })] });
  await parse(); expect(await comparison()).toMatchObject({ status: "failed", outcomes: null });
  expect((await store.loadState()).source_reviews).toHaveLength(0);
  expect((await listSourceFiles())[0].status).toBe("parsed");
 });
 it("records disabled on retry and refuses automatic work while AI stays off", async () => {
  respond = () => { throw new Error("Initial check unavailable"); }; await parse();
  await setAiEnabled({ enabled: false, actor_name: actor.name });
  const saved = await comparison(); const priorCalls = calls.length;
  expect((await post({ action: "retry_source_comparison", source_id: saved.source_id })).status).toBe(200);
  expect(await comparison()).toMatchObject({ status: "ai_disabled" }); expect(calls).toHaveLength(priorCalls);
 });
 it("only displays a clean check result for a current completed comparison", async () => {
  respond = () => ({ outcomes: [] }); await parse(); const saved = await comparison();
  for (const status of ["pending", "failed", "ai_disabled"] as const) {
   const html = renderToStaticMarkup(createElement(SourceComparisonStatus, { sourceId: saved.source_id, comparison: { ...saved, status } }));
   expect(html).toContain('role="status"'); expect(html).not.toContain("no discrepancies detected");
  }
  expect(renderToStaticMarkup(createElement(SourceComparisonStatus, { sourceId: saved.source_id, comparison: { ...saved, basis_current: false } }))).not.toContain("no discrepancies detected");
  expect(renderToStaticMarkup(createElement(SourceComparisonStatus, { sourceId: saved.source_id, comparison: saved }))).toContain("Check completed: no discrepancies detected in the compared claims.");
 });
});
