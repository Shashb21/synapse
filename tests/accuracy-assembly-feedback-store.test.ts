/** Real PostgreSQL proof and persistence tests for production assembly feedback. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { assemblyFingerprint, type Assembly, type ResolvedAssemblyItem } from "@/accuracy/domain/assembly";
import { assemblyCheckFingerprint } from "@/accuracy/domain/assembly-review";
import { createAssemblyFeedback, listAssemblyFeedback, listAssemblyFeedbackRuns } from "@/accuracy/store/assembly-feedback-store";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { newId, nowIso } from "@/modules/kernel/ids";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
vi.mock("@/lib/iegp/db", async () => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse", {
    max: 6, connection: { application_name: "kan42-feedback-store-test" },
  });
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { db: () => drizzle(client) };
});

const workspaces: string[] = [];
const now = () => nowIso();
const actor = { subject: "contributor-subject", provider: "test-idp", actor: { name: "Contributor", function: "medical_affairs" as const } };

async function fixture() {
  const org_id = await createOrganization("feedback test");
  const workspace_id = await createWorkspace({ org_id, name: "feedback", slug: newId("slug") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "evidence.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "A source quote supports the item.", parser: "test", created_at: now() });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

type Scope = Awaited<ReturnType<typeof fixture>>;
type Kind = "need_extract" | "inventory_extract";

async function anotherSource(scope: Scope): Promise<Scope> {
  const source = await insertSourceFile({ workspace_id: scope.workspace_id, filename: "other-evidence.txt",
    mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id: scope.workspace_id,
    source_file_id: source.id, index: 0, kind: "paragraph", heading: null,
    text: "A source quote supports the item.", parser: "test", created_at: now() });
  return { ...scope, source_file_id: source.id, block_id };
}

async function item(scope: Scope, kind: Kind, label: string, human = false) {
  const call_kind = kind;
  const claim_type = kind === "need_extract" ? "gap" : "tactic";
  const run_id = newId("arun");
  const payload = claim_type === "gap"
    ? { id: newId("gap"), statement: label, external_id: newId("ext"), provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "source quote" }] }
    : { id: newId("tactic"), name: label, type: "publication", status: "planned", evidence_question: "Question?", origin: "inventory", provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "source quote" }] };
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind, agent_role: "judge", module_id: "test", module_version: "1", status: "ok", started_at: now(), finished_at: now(),
    actor_name: "Agent", actor_function: "medical_affairs", input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id },
    output: claim_type === "gap" ? { gaps: [payload] } : { tactics: [payload] }, steps: [], evaluation_context: "production" });
  const batch_id = newId("batch");
  await accuracyDb().insert(t.accuracyExtractionBatches).values({ id: batch_id, workspace_id: scope.workspace_id,
    source_file_id: scope.source_file_id, requested_kinds: [kind], run_ids: [run_id], created_claim_ids: [], drafts_persisted: true, created_at: now() });
  const claim_id = newId("claim");
  await accuracyDb().insert(t.accuracyClaims).values({ id: claim_id, workspace_id: scope.workspace_id, claim_type, statement: label,
    status: "validated", validated: true, source_file_id: scope.source_file_id, metadata: {}, created_at: now(), updated_at: now() });
  const id = newId("item");
  const human_origin = human ? { kind: "human" as const, revision_id: newId("rev"), subject: actor.subject, provider: actor.provider,
    actor: actor.actor, action: "add" as const, reason: "Human change", parent_assembly_id: newId("assembly"), predecessor_version_id: null,
    source_file_id: scope.source_file_id, provenance: payload.provenance, created_at: now() } : null;
  await accuracyDb().insert(t.accuracyItemVersions).values({ id, workspace_id: scope.workspace_id, claim_id,
    run_id: human ? null : run_id, human_origin: human_origin ?? undefined, snapshot_id: null, iteration: null, item_index: 0,
    origin_key: newId("origin"), claim_type, fingerprint: newId("fingerprint"), payload, source_file_id: scope.source_file_id, created_at: now() });
  const resolved: ResolvedAssemblyItem = { id, claim_id, run_id: human ? null : run_id, ...(human_origin ? { human_origin } : {}),
    snapshot_id: null, iteration: null, item_index: 0, payload, source_file_id: scope.source_file_id, created_at: now(),
    claim_type, canonical_claim_id: claim_id, reason: "selected" };
  return { resolved, run_id, batch_id, call_kind, source_file_id: scope.source_file_id };
}

async function assembly(scope: Scope, items: Awaited<ReturnType<typeof item>>[], decision: "approve" | "reject" | null = "approve") {
  const id = newId("assembly");
  const body = {
    source_file_ids: [...new Set(items.map(entry => entry.source_file_id))],
    items: items.map(entry => entry.resolved), mappings: [], coverage: [], linking_complete: true,
    extraction_runs: items.map(entry => ({ call_kind: entry.call_kind, run_id: entry.run_id, source_file_id: entry.source_file_id,
      item_count: 1, outcome: "items" as const, evaluation_context: "production" as const })),
  };
  const fingerprint = assemblyFingerprint(body);
  const checks: Assembly["checks"] = { checker_version: "test", status: "passed", findings: [] };
  await accuracyDb().insert(t.accuracyAssemblies).values({ id, workspace_id: scope.workspace_id, created_at: now(), actor_name: "Agent",
    actor_function: "medical_affairs", fingerprint, source_file_ids: body.source_file_ids, mappings: [], coverage: [],
    extraction_runs: body.extraction_runs, linking_complete: true, output: { gaps: [], tactics: [] }, checks });
  for (let position = 0; position < items.length; position++) {
    await accuracyDb().insert(t.accuracyAssemblyItems).values({ id: newId("selection"), workspace_id: scope.workspace_id,
      assembly_id: id, item_version_id: items[position].resolved.id, position, reason: "selected", resolved_item: items[position].resolved });
  }
  const review_id = newId("review");
  if (decision) await accuracyDb().insert(t.accuracyAssemblyReviews).values({ id: review_id, workspace_id: scope.workspace_id,
    assembly_id: id, fingerprint, checks_fingerprint: assemblyCheckFingerprint(checks), decision, rationale: "reviewed", advisory_overrides: [],
    reviewer_subject: "reviewer", reviewer_provider: "test-idp", reviewer_actor_name: "Reviewer", reviewer_actor_function: "medical_affairs",
    reviewer_role: "medical_affairs", created_at: now() });
  return { id, fingerprint, review_id, items };
}

type SavedAssembly = Awaited<ReturnType<typeof assembly>>;
function binding(saved: SavedAssembly, entry: Awaited<ReturnType<typeof item>>) {
  return { source_file_id: entry.source_file_id, call_kind: entry.call_kind, batch_id: entry.batch_id, run_id: entry.run_id,
    assembly_id: saved.id, assembly_fingerprint: saved.fingerprint, review_id: saved.review_id };
}

async function consumer(scope: Scope, bindings: unknown, overrides: { status?: string; evaluation_context?: string; steps?: unknown } = {}) {
  const id = newId("consumer");
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: "merge_dedupe", agent_role: "judge", module_id: "test", module_version: "1",
    status: overrides.status ?? "ok", started_at: now(), finished_at: now(), actor_name: "Agent", actor_function: "medical_affairs",
    input: { workspace_id: scope.workspace_id }, output: {},
    steps: overrides.steps ?? [{ name: "assembly:approved-live-bindings", data: bindings }],
    evaluation_context: overrides.evaluation_context ?? "production" });
  return id;
}

function feedback(scope: Scope, saved: SavedAssembly, consumer_run_id: string, selected_item_version_ids: string[] = []) {
  return { workspace_id: scope.workspace_id, assembly_id: saved.id, expected_fingerprint: saved.fingerprint,
    approval_review_id: saved.review_id, consumer_run_id, selected_item_version_ids,
    category: "edited" as const, rationale: "Contributor revised wording after use.", contributor: actor };
}

afterEach(async () => { for (const workspace_id of workspaces.splice(0)) await deleteWorkspace(workspace_id); });
afterAll(() => closePool());

describe("assembly feedback store", () => {
  it("records exact consumed items and immutable evidence for whole and subset feedback", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const tactic = await item(scope, "inventory_extract", "Tactic");
    const saved = await assembly(scope, [gap, tactic]);
    const run_id = await consumer(scope, [binding(saved, gap), binding(saved, tactic)]);

    const runs = await listAssemblyFeedbackRuns(scope.workspace_id, saved.id);
    const whole = await createAssemblyFeedback(feedback(scope, saved, run_id));
    const subset = await createAssemblyFeedback(feedback(scope, saved, run_id, [tactic.resolved.id]));

    expect(runs).toEqual([expect.objectContaining({ run_id, approval_review_id: saved.review_id,
      consumed_item_version_ids: [gap.resolved.id, tactic.resolved.id] })]);
    expect(whole.selected_item_version_ids).toEqual([gap.resolved.id, tactic.resolved.id]);
    expect(subset.selected_item_version_ids).toEqual([tactic.resolved.id]);
    expect(whole.items).toEqual(expect.arrayContaining([expect.objectContaining({ item_version_id: gap.resolved.id,
      source_file_id: scope.source_file_id, evidence: [expect.objectContaining({ block_id: scope.block_id, quote: "source quote" })] })]));
    expect(await listAssemblyFeedback(scope.workspace_id, saved.id)).toHaveLength(2);
  });

  it("rejects forged selections and malformed or unapproved consumption without writing", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const saved = await assembly(scope, [gap]);
    const valid_run = await consumer(scope, [binding(saved, gap)]);
    const malformed_run = await consumer(scope, [{ ...binding(saved, gap), batch_id: "wrong" }]);
    const failed_run = await consumer(scope, [binding(saved, gap)], { status: "error" });
    const experiment_run = await consumer(scope, [binding(saved, gap)], { evaluation_context: "experiment" });
    const unbound_run = await consumer(scope, [], { steps: [] });

    for (const run_id of [malformed_run, failed_run, experiment_run, unbound_run]) {
      await expect(createAssemblyFeedback(feedback(scope, saved, run_id))).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(createAssemblyFeedback(feedback(scope, saved, valid_run, ["foreign-version"]))).rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedback(scope.workspace_id, saved.id)).toEqual([]);
  });

  it("projects only historically bound kinds across replaced heads and keeps successor history separate", async () => {
    const scope = await fixture();
    const oldGap = await item(scope, "need_extract", "Original gap");
    const oldTactic = await item(scope, "inventory_extract", "Original tactic");
    const original = await assembly(scope, [oldGap, oldTactic]);
    const newTactic = await item(scope, "inventory_extract", "Replacement tactic");
    const successor = await assembly(scope, [newTactic]);
    const run_id = await consumer(scope, [binding(original, oldGap), binding(successor, newTactic)]);

    const runs = await listAssemblyFeedbackRuns(scope.workspace_id, original.id);
    const observed = await createAssemblyFeedback(feedback(scope, original, run_id));

    expect(runs[0].consumed_item_version_ids).toEqual([oldGap.resolved.id]);
    expect(observed.selected_item_version_ids).toEqual([oldGap.resolved.id]);
    await expect(createAssemblyFeedback(feedback(scope, original, run_id, [oldTactic.resolved.id])))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedback(scope.workspace_id, successor.id)).toEqual([]);
    expect(await listAssemblyFeedback(scope.workspace_id, original.id)).toHaveLength(1);
  });

  it("includes opposite-kind human versions only without a separately owned source/kind binding", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const humanTactic = await item(scope, "inventory_extract", "Human tactic", true);
    const prior = await assembly(scope, [gap, humanTactic]);
    const withoutOwner = await consumer(scope, [binding(prior, gap)]);
    const otherTactic = await item(scope, "inventory_extract", "Separate tactic");
    const owner = await assembly(scope, [otherTactic]);
    const withOwner = await consumer(scope, [binding(prior, gap), binding(owner, otherTactic)]);

    const first = await createAssemblyFeedback(feedback(scope, prior, withoutOwner));
    const second = await createAssemblyFeedback(feedback(scope, prior, withOwner));

    expect(first.selected_item_version_ids).toEqual([gap.resolved.id, humanTactic.resolved.id]);
    expect(first.items.find(entry => entry.item_version_id === humanTactic.resolved.id)?.evidence[0].block_id).toBe(scope.block_id);
    expect(second.selected_item_version_ids).toEqual([gap.resolved.id]);
  });

  it("rejects foreign tenants and exact review or fingerprint mismatches", async () => {
    const scope = await fixture();
    const foreign = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const saved = await assembly(scope, [gap]);
    const run_id = await consumer(scope, [binding(saved, gap)]);
    const foreignGap = await item(foreign, "need_extract", "Foreign gap");
    const foreignSaved = await assembly(foreign, [foreignGap]);
    const foreignRun = await consumer(foreign, [binding(foreignSaved, foreignGap)]);

    await expect(createAssemblyFeedback(feedback(scope, saved, foreignRun))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createAssemblyFeedback(feedback(scope, saved, run_id, [foreignGap.resolved.id])))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(createAssemblyFeedback({ ...feedback(scope, saved, run_id), approval_review_id: foreignSaved.review_id }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(createAssemblyFeedback({ ...feedback(scope, saved, run_id), expected_fingerprint: "forged" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedback(foreign.workspace_id, saved.id)).toEqual([]);
  });

  it("rejects unapproved and rejected reviews, ambiguous bindings, and malformed selections atomically", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const unreviewed = await assembly(scope, [gap], null);
    const rejected = await assembly(scope, [gap], "reject");
    const unreviewedRun = await consumer(scope, [binding(unreviewed, gap)]);
    const rejectedRun = await consumer(scope, [binding(rejected, gap)]);
    const approved = await assembly(scope, [gap]);
    const duplicateRun = await consumer(scope, [binding(approved, gap), binding(approved, gap)]);
    const twoSteps = await consumer(scope, [binding(approved, gap)], {
      steps: [{ name: "assembly:approved-live-bindings", data: [binding(approved, gap)] },
        { name: "assembly:approved-live-bindings", data: [binding(approved, gap)] }],
    });

    for (const [saved, run_id] of [[unreviewed, unreviewedRun], [rejected, rejectedRun],
      [approved, duplicateRun], [approved, twoSteps]] as const) {
      await expect(createAssemblyFeedback(feedback(scope, saved, run_id))).rejects.toMatchObject({ code: "invalid_input" });
    }
    const validRun = await consumer(scope, [binding(approved, gap)]);
    await expect(createAssemblyFeedback({ ...feedback(scope, approved, validRun), category: "edited", rationale: "  " }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(createAssemblyFeedback({ ...feedback(scope, approved, validRun), selected_item_version_ids: [gap.resolved.id, gap.resolved.id] }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedback(scope.workspace_id, approved.id)).toEqual([]);
  });

  it("fails closed when another binding in the same consumer record is corrupt", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const tactic = await item(scope, "inventory_extract", "Tactic");
    const gapAssembly = await assembly(scope, [gap]);
    const tacticAssembly = await assembly(scope, [tactic]);
    const run_id = await consumer(scope, [binding(gapAssembly, gap), { ...binding(tacticAssembly, tactic), batch_id: "wrong-batch" }]);

    await expect(createAssemblyFeedback(feedback(scope, gapAssembly, run_id))).rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedbackRuns(scope.workspace_id, gapAssembly.id)).toEqual([]);
    expect(await listAssemblyFeedback(scope.workspace_id, gapAssembly.id)).toEqual([]);
  });

  it("validates every review even when two bindings reuse a cached assembly", async () => {
    const scope = await fixture();
    const other = await anotherSource(scope);
    const gap = await item(scope, "need_extract", "First gap");
    const tactic = await item(scope, "inventory_extract", "First tactic");
    const shared = await assembly(scope, [gap, tactic]);
    const otherGap = await item(other, "need_extract", "Other gap");
    const target = await assembly(other, [otherGap]);
    const run_id = await consumer(scope, [binding(shared, gap), { ...binding(shared, tactic), review_id: "forged-review" },
      binding(target, otherGap)]);

    await expect(createAssemblyFeedback(feedback(scope, target, run_id))).rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedbackRuns(scope.workspace_id, target.id)).toEqual([]);
    expect(await listAssemblyFeedback(scope.workspace_id, target.id)).toEqual([]);
  });

  it("rejects an applied batch whose complete run ownership is ambiguous", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const duplicateKind = await item(scope, "need_extract", "Another gap");
    const saved = await assembly(scope, [gap]);
    const run_id = await consumer(scope, [binding(saved, gap)]);
    await accuracyDb().update(t.accuracyExtractionBatches).set({
      requested_kinds: ["need_extract", "inventory_extract"], run_ids: [gap.run_id, duplicateKind.run_id],
    }).where(eq(t.accuracyExtractionBatches.id, gap.batch_id));

    await expect(createAssemblyFeedback(feedback(scope, saved, run_id))).rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedback(scope.workspace_id, saved.id)).toEqual([]);
  });

  it("rejects a batch that lists a successful downstream call as an extraction kind", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const saved = await assembly(scope, [gap]);
    const run_id = await consumer(scope, [binding(saved, gap)]);
    const downstream_id = newId("arun");
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: downstream_id, org_id: scope.org_id,
      workspace_id: scope.workspace_id, call_kind: "merge_dedupe", agent_role: "judge", module_id: "test",
      module_version: "1", status: "ok", started_at: now(), finished_at: now(), actor_name: "Agent",
      actor_function: "medical_affairs", input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id },
      output: {}, steps: [], evaluation_context: "production" });
    await accuracyDb().update(t.accuracyExtractionBatches).set({ requested_kinds: ["need_extract", "merge_dedupe"],
      run_ids: [gap.run_id, downstream_id] }).where(eq(t.accuracyExtractionBatches.id, gap.batch_id));

    await expect(createAssemblyFeedback(feedback(scope, saved, run_id))).rejects.toMatchObject({ code: "invalid_input" });
    expect(await listAssemblyFeedbackRuns(scope.workspace_id, saved.id)).toEqual([]);
  });

  it("removes feedback before its review, assembly and consumer parents on workspace deletion", async () => {
    const scope = await fixture();
    const gap = await item(scope, "need_extract", "Gap");
    const saved = await assembly(scope, [gap]);
    const run_id = await consumer(scope, [binding(saved, gap)]);
    await createAssemblyFeedback(feedback(scope, saved, run_id));

    const result = await deleteWorkspace(scope.workspace_id);
    workspaces.splice(workspaces.indexOf(scope.workspace_id), 1);

    expect(result.deleted.assembly_feedback).toBe(1);
    expect(await accuracyDb().select().from(t.accuracyAssemblyFeedback).where(eq(t.accuracyAssemblyFeedback.workspace_id, scope.workspace_id))).toEqual([]);
  });
});
