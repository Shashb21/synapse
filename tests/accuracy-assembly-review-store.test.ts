import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { applyExtractionBatch, createExtractionBatch } from "@/accuracy/store/extraction-batch-store";
import { approvedLiveInventory, assemblyReviewState, reviewAssembly } from "@/accuracy/store/assembly-review-store";
import { newId, nowIso } from "@/modules/kernel/ids";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
vi.mock("@/lib/iegp/db", async () => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse", {
    max: 6,
    connection: { application_name: "kan38-assembly-review-test" },
  });
  const database = drizzle(client);
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { db: () => database };
});

const workspaces: string[] = [];
const actor = { name: "Assembly Agent", function: "medical_affairs" as const };
const reviewer = {
  subject: "subject-reviewer",
  provider: "test-idp",
  actor: { name: "Review Lead", function: "medical_affairs" as const },
  role: "medical_affairs" as const,
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const org_id = await createOrganization("assembly review test");
  const workspace_id = await createWorkspace({ org_id, name: "assembly review", slug: newId("slug") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "Shared source text supports the selected item.", parser: "test", created_at: nowIso() });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

async function addSource(scope: Fixture, text = "Second source text supports the selected item.") {
  const source = await insertSourceFile({ workspace_id: scope.workspace_id, filename: `${newId("source")}.txt`, mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id: scope.workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text, parser: "test", created_at: nowIso() });
  return { ...scope, source_file_id: source.id, block_id };
}

function gap(scope: Fixture, statement: string, id = newId("gap")) {
  return { id, statement, external_id: id, provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "supports the selected item" }] };
}

function tactic(scope: Fixture, name: string, id = newId("tac")) {
  return { id, name, type: "publication", status: "planned", evidence_question: "Will this address the gap?",
    origin: "inventory", provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "supports the selected item" }] };
}

async function extractionRun(scope: Fixture, claim_type: "gap" | "tactic", final: unknown, evaluation_context: "production" | "experiment" = "production") {
  const id = newId("run");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: claim_type === "gap" ? "need_extract" : "inventory_extract", agent_role: "judge",
    module_id: "test", module_version: "1", status: "ok", started_at: now, finished_at: now,
    actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id }, output: final, steps: [], evaluation_context });
  return id;
}

async function coverageRun(scope: Fixture, gap_version_id: string, tactic_version_id: string, gap_payload: Record<string, unknown>, tactic_payload: Record<string, unknown>) {
  const id = newId("run");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: "coverage_decide", agent_role: "judge", module_id: "coverage", module_version: "1",
    status: "ok", started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, gap_id: gap_version_id, tactic_id: tactic_version_id, block_bundle_ids: [scope.block_id],
      selected_versions: { gap_version_id, tactic_version_id, gap_payload, tactic_payload } },
    output: { gap_id: gap_version_id, tactic_id: tactic_version_id, overall: "partial", quote_block_ids: [scope.block_id], confidence: 0.75, rationale: "Partial support." },
    steps: [] });
  return id;
}

async function publishKind(scope: Fixture, claim_type: "gap" | "tactic", payload: Record<string, unknown>, evaluation_context: "production" | "experiment" = "production") {
  const final = claim_type === "gap"
    ? { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [payload] }
    : { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [payload] };
  const run_id = await extractionRun(scope, claim_type, final, evaluation_context);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, [claim_type === "gap" ? "need_extract" : "inventory_extract"]);
  const created: string[] = [];
  await applyExtractionBatch(batch, [run_id], created, async () => {
    created.push(...(await publishGeneratedItemHistory({ ...scope, run_id, claim_type, final_claims: [{
      id: payload.id as string, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type,
      statement: claim_type === "gap" ? payload.statement as string : payload.name as string,
    }] })).claim_ids);
  });
  const [version] = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.run_id, run_id)));
  if (!version) throw new Error("fixture failed to publish version");
  return { run_id, batch, version };
}

async function publishEmptyKind(scope: Fixture, claim_type: "gap" | "tactic") {
  const final = claim_type === "gap"
    ? { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [] }
    : { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [] };
  const run_id = await extractionRun(scope, claim_type, final);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, [claim_type === "gap" ? "need_extract" : "inventory_extract"]);
  await applyExtractionBatch(batch, [run_id], [], async () => {});
  return { run_id, batch };
}

async function completeAssembly(scope: Fixture, gapPayload = gap(scope, "Earlier source-backed gap"), tacticPayload = tactic(scope, "Publish field guide")) {
  const gapFinal = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [gapPayload] };
  const tacticFinal = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [tacticPayload] };
  const gapRun = await extractionRun(scope, "gap", gapFinal);
  const tacticRun = await extractionRun(scope, "tactic", tacticFinal);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract", "inventory_extract"]);
  const created: string[] = [];
  await applyExtractionBatch(batch, [gapRun, tacticRun], created, async () => {
    created.push(...(await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap", final_claims: [{
      id: gapPayload.id as string, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: gapPayload.statement as string,
    }] })).claim_ids);
    created.push(...(await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic", final_claims: [{
      id: tacticPayload.id as string, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tacticPayload.name as string,
    }] })).claim_ids);
  });
  const versions = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id));
  const gapVersion = versions.find((row) => row.run_id === gapRun);
  const tacticVersion = versions.find((row) => row.run_id === tacticRun);
  if (!gapVersion || !tacticVersion) throw new Error("fixture failed to publish versions");
  const gapPub = { run_id: gapRun, batch, version: gapVersion };
  const tacticPub = { run_id: tacticRun, batch, version: tacticVersion };
  const coverage_run_id = await coverageRun(scope, gapPub.version.id, tacticPub.version.id, gapPub.version.payload, tacticPub.version.payload);
  const assembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
    selections: [{ item_version_id: gapPub.version.id, reason: "approved gap" }, { item_version_id: tacticPub.version.id, reason: "approved tactic" }],
    mappings: [{ gap_version_id: gapPub.version.id, tactic_version_id: tacticPub.version.id }],
    coverage_run_ids: [coverage_run_id], extraction_runs: [
      { call_kind: "need_extract", run_id: gapPub.run_id, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      { call_kind: "inventory_extract", run_id: tacticPub.run_id, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
    ], linking_complete: true, generation_key: batch.id });
  return { assembly, gapPub, tacticPub };
}

async function approveCurrentAssembly(scope: Fixture) {
  const result = await completeAssembly(scope);
  await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: result.assembly.id,
    expected_fingerprint: result.assembly.fingerprint, expected_review_id: null, decision: "approve",
    rationale: "Approved for live inventory.", advisory_overrides: [], reviewer });
  return result;
}

afterEach(async () => {
  for (const id of workspaces.splice(0)) await deleteWorkspace(id);
});

afterAll(() => closePool());

describe("assembly review store", () => {
  it("stores exact approved review decisions and returns an identical initial retry", async () => {
    const scope = await fixture();
    const { assembly } = await completeAssembly(scope);

    const first = await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approved for downstream use.", advisory_overrides: [], reviewer });
    const retry = await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approved for downstream use.", advisory_overrides: [], reviewer });

    expect(retry.id).toBe(first.id);
    await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "reject",
      rationale: "Competing decision.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });
    await expect(assemblyReviewState(scope.workspace_id, assembly.id)).resolves.toMatchObject({
      status: "approved",
      expected_review_id: first.id,
      latest_decision: expect.objectContaining({ id: first.id, decision: "approve" }),
    });
  });

  it("rechecks persisted body and checks instead of trusting stored output/checks", async () => {
    const scope = await fixture();
    const { assembly } = await completeAssembly(scope);

    await accuracyDb().update(t.accuracyAssemblies).set({ checks: { checker_version: "assembly-domain-v1", status: "passed", findings: [
      { code: "coverage_stub_advisory", severity: "advisory", item_version_ids: [], message: "Stored report was changed." },
    ] } }).where(eq(t.accuracyAssemblies.id, assembly.id));
    await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "reject",
      rationale: "Do not trust changed stored checks.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });

    await accuracyDb().update(t.accuracyAssemblies).set({ checks: assembly.checks }).where(eq(t.accuracyAssemblies.id, assembly.id));
    await accuracyDb().update(t.accuracyAssemblies).set({ output: { gaps: [{ statement: "tampered mutable output" }], tactics: [] } })
      .where(eq(t.accuracyAssemblies.id, assembly.id));

    await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Should fail.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });

    const incomplete = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [], mappings: [], coverage_run_ids: [], linking_complete: false });
    await accuracyDb().update(t.accuracyAssemblies).set({ checks: { checker_version: "assembly-domain-v1", status: "passed", findings: [] } })
      .where(eq(t.accuracyAssemblies.id, incomplete.id));

    await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: incomplete.id,
      expected_fingerprint: incomplete.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Do not trust stored checks.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });
  });

  it("returns null for legacy workspaces and exposes exact approved payloads with safe workflow overlays only", async () => {
    const legacy = await fixture();
    expect(await approvedLiveInventory(legacy.workspace_id)).toBeNull();

    const scope = await fixture();
    const { assembly, gapPub } = await completeAssembly(scope);
    await accuracyDb().update(t.accuracyClaims).set({
      statement: "mutable claim edit after approval",
      metadata: {
        gap_ids: ["mutable-gap-link"],
        parent_gap_id: "mutable-parent",
        priority: "high",
        priority_band: "high",
        priority_rationale: "Workflow reprioritization.",
        priority_origin: "review",
      },
    }).where(eq(t.accuracyClaims.id, gapPub.version.claim_id));
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approved for live inventory.", advisory_overrides: [], reviewer });

    const live = await approvedLiveInventory(scope.workspace_id);
    expect(live?.claims.map((claim) => [claim.id, claim.statement, claim.validated])).toContainEqual([
      gapPub.version.claim_id,
      "Earlier source-backed gap",
      true,
    ]);
    const projectedGap = live?.claims.find((claim) => claim.id === gapPub.version.claim_id);
    expect(projectedGap?.metadata).toMatchObject({ priority: "high", priority_band: "high", priority_rationale: "Workflow reprioritization.", priority_origin: "review" });
    expect(projectedGap?.metadata).not.toHaveProperty("gap_ids");
    expect(projectedGap?.metadata).not.toHaveProperty("parent_gap_id");
    expect(live?.coverage).toHaveLength(1);
    expect(live?.bindings.every((binding) => binding.review_id)).toBe(true);
  });

  it("approves empty production assemblies and keeps manual approvals out of implicit head resolution", async () => {
    const empty = await fixture();
    const emptyPub = await publishEmptyKind(empty, "gap");
    const emptyAssembly = await createAssembly({ workspace_id: empty.workspace_id, actor, source_file_ids: [empty.source_file_id],
      selections: [], mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id: emptyPub.run_id, source_file_id: empty.source_file_id, item_count: 0, outcome: "empty", evaluation_context: "production" },
      ], linking_complete: true, generation_key: emptyPub.batch.id });
    await expect(reviewAssembly({ workspace_id: empty.workspace_id, assembly_id: emptyAssembly.id,
      expected_fingerprint: emptyAssembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approved empty extraction.", advisory_overrides: [], reviewer })).resolves.toMatchObject({ decision: "approve" });
    await expect(approvedLiveInventory(empty.workspace_id)).resolves.toMatchObject({ claims: [], coverage: [], bindings: [expect.objectContaining({ batch_id: emptyPub.batch.id })] });

    const manual = await fixture();
    const published = await publishKind(manual, "gap", gap(manual, "Manual approved gap"));
    const manualAssembly = await createAssembly({ workspace_id: manual.workspace_id, actor, source_file_ids: [manual.source_file_id],
      selections: [{ item_version_id: published.version.id, reason: "manual current selection" }],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id: published.run_id, source_file_id: manual.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true });
    await expect(reviewAssembly({ workspace_id: manual.workspace_id, assembly_id: manualAssembly.id,
      expected_fingerprint: manualAssembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Manual review with current verified lineage.", advisory_overrides: [], reviewer })).resolves.toMatchObject({ decision: "approve" });
    await expect(approvedLiveInventory(manual.workspace_id)).rejects.toMatchObject({ code: "approval_required" });

    const missingContext = await createAssembly({ workspace_id: manual.workspace_id, actor, source_file_ids: [manual.source_file_id],
      selections: [{ item_version_id: published.version.id, reason: "manual missing context" }],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id: published.run_id, source_file_id: manual.source_file_id, item_count: 1, outcome: "items" } as never,
      ], linking_complete: true });
    await expect(reviewAssembly({ workspace_id: manual.workspace_id, assembly_id: missingContext.id,
      expected_fingerprint: missingContext.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Missing context must not count as production.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails closed for missing, rejected, stale, or experiment-only managed heads without falling back", async () => {
    const scope = await fixture();
    const { assembly } = await completeAssembly(scope);
    await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });

    const rejection = await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "reject",
      rationale: "Do not use this proposal.", advisory_overrides: [], reviewer });
    expect(rejection.decision).toBe("reject");
    await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });

    const newerGap = await publishKind(scope, "gap", gap(scope, "Newer unassembled gap"));
    expect(newerGap.batch.id).not.toBe(assembly.id);
    await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });

    const experimentScope = await fixture();
    await publishKind(experimentScope, "gap", gap(experimentScope, "Experiment gap"), "experiment");
    await expect(approvedLiveInventory(experimentScope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
  });

  it("retains an approved tactic head when a later gap-only head is approved", async () => {
    const scope = await fixture();
    const { assembly } = await completeAssembly(scope);
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approve initial combined head.", advisory_overrides: [], reviewer });

    const newerGap = await publishKind(scope, "gap", gap(scope, "Newer approved gap"));
    await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Stale retry.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });
    const gapAssembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [{ item_version_id: newerGap.version.id, reason: "new gap head" }],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id: newerGap.run_id, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: newerGap.batch.id });
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: gapAssembly.id,
      expected_fingerprint: gapAssembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approve the gap-only replacement.", advisory_overrides: [], reviewer });

    const live = await approvedLiveInventory(scope.workspace_id);
    expect(live?.claims.map((claim) => [claim.claim_type, claim.statement]).sort()).toEqual([
      ["gap", "Newer approved gap"],
      ["tactic", "Publish field guide"],
    ]);
    expect(live?.bindings.map((binding) => [binding.call_kind, binding.batch_id])).toEqual(expect.arrayContaining([
      ["need_extract", newerGap.batch.id],
      ["inventory_extract", assembly.generation_key],
    ]));
  });

  it("scopes projected selected items by source and kind", async () => {
    const scope = await fixture();
    const other = await addSource(scope);
    const sourceOneGap = await publishKind(scope, "gap", gap(scope, "Source one gap"));
    const sourceTwoPayload = gap(other, "Source two gap");
    const sourceTwoRun = await extractionRun(other, "gap", { workspace_id: other.workspace_id, source_file_id: other.source_file_id, gaps: [sourceTwoPayload] });
    await publishGeneratedItemHistory({ ...other, run_id: sourceTwoRun, claim_type: "gap", final_claims: [{
      id: sourceTwoPayload.id as string, workspace_id: other.workspace_id, source_file_id: other.source_file_id, claim_type: "gap",
      statement: sourceTwoPayload.statement as string,
    }] });
    const [sourceTwoVersion] = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.run_id, sourceTwoRun)));
    const assembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id, other.source_file_id],
      selections: [
        { item_version_id: sourceOneGap.version.id, reason: "current source head" },
        { item_version_id: sourceTwoVersion.id, reason: "same-kind other source item" },
      ],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id: sourceOneGap.run_id, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: sourceOneGap.batch.id });
    await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approve source-scoped head.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });

    const projection = await fixture();
    const projectedGap = await publishKind(projection, "gap", gap(projection, "Projected source gap"));
    const sourceScopedAssembly = await createAssembly({ workspace_id: projection.workspace_id, actor, source_file_ids: [projection.source_file_id],
      selections: [{ item_version_id: projectedGap.version.id, reason: "current source head" }],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id: projectedGap.run_id, source_file_id: projection.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: projectedGap.batch.id });
    await reviewAssembly({ workspace_id: projection.workspace_id, assembly_id: sourceScopedAssembly.id,
      expected_fingerprint: sourceScopedAssembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approve source-scoped head.", advisory_overrides: [], reviewer });

    const live = await approvedLiveInventory(projection.workspace_id);
    expect(live?.claims.map((claim) => claim.statement)).toEqual(["Projected source gap"]);
  });

  it("rejects selected item versions from stale or undeclared extraction runs", async () => {
    const scope = await fixture();
    const stale = await publishKind(scope, "gap", gap(scope, "Older same-source gap"));
    const current = await publishKind(scope, "gap", gap(scope, "Current same-source gap"));
    const staleSelectionAssembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [{ item_version_id: stale.version.id, reason: "stale run selection" }],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id: current.run_id, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: current.batch.id });

    await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: staleSelectionAssembly.id,
      expected_fingerprint: staleSelectionAssembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Should not approve a stale selected version.", advisory_overrides: [], reviewer })).rejects.toMatchObject({ code: "conflict" });
  });

  it("uses an earlier selected snapshot payload and fails closed for changed-version coverage", async () => {
    const snapshotScope = await fixture();
    const snapshotPayload = gap(snapshotScope, "Earlier snapshot gap", "stable-gap");
    const finalPayload = gap(snapshotScope, "Final changed gap", "stable-gap-final");
    const run_id = await extractionRun(snapshotScope, "gap", { workspace_id: snapshotScope.workspace_id, source_file_id: snapshotScope.source_file_id, gaps: [finalPayload] });
    const snapshot_id = newId("evt");
    await accuracyDb().insert(t.accuracyAgentEvents).values({ id: snapshot_id, run_id, workspace_id: snapshotScope.workspace_id,
      event_type: "snapshot", iteration: 0, payload: { output: { workspace_id: snapshotScope.workspace_id, source_file_id: snapshotScope.source_file_id, gaps: [snapshotPayload] } },
      recorded_at: nowIso() });
    const batch = await createExtractionBatch(snapshotScope.workspace_id, snapshotScope.source_file_id, ["need_extract"]);
    await applyExtractionBatch(batch, [run_id], [], async () => {
      await publishGeneratedItemHistory({ ...snapshotScope, run_id, claim_type: "gap", final_claims: [{
        id: finalPayload.id as string, workspace_id: snapshotScope.workspace_id, source_file_id: snapshotScope.source_file_id, claim_type: "gap",
        statement: finalPayload.statement as string,
      }] });
    });
    const [snapshotVersion] = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, snapshotScope.workspace_id), eq(t.accuracyItemVersions.snapshot_id, snapshot_id)));
    const snapshotAssembly = await createAssembly({ workspace_id: snapshotScope.workspace_id, actor, source_file_ids: [snapshotScope.source_file_id],
      selections: [{ item_version_id: snapshotVersion.id, reason: "review chose supported snapshot" }],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "need_extract", run_id, source_file_id: snapshotScope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: batch.id });
    await reviewAssembly({ workspace_id: snapshotScope.workspace_id, assembly_id: snapshotAssembly.id,
      expected_fingerprint: snapshotAssembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approve earlier snapshot.", advisory_overrides: [], reviewer });
    expect((await approvedLiveInventory(snapshotScope.workspace_id))?.claims.map((claim) => claim.statement)).toEqual(["Earlier snapshot gap"]);

    const changed = await fixture();
    const { assembly, gapPub, tacticPub } = await approveCurrentAssembly(changed);
    const tacticV2 = tactic(changed, "Updated field guide", tacticPub.version.claim_id);
    const tacticRun2 = await extractionRun(changed, "tactic", { workspace_id: changed.workspace_id, source_file_id: changed.source_file_id, tactics: [tacticV2] });
    const tacticBatch2 = await createExtractionBatch(changed.workspace_id, changed.source_file_id, ["inventory_extract"]);
    await applyExtractionBatch(tacticBatch2, [tacticRun2], [], async () => {
      await accuracyDb().insert(t.accuracyItemVersions).values({ id: newId("iver"), workspace_id: changed.workspace_id,
        claim_id: tacticPub.version.claim_id, run_id: tacticRun2, snapshot_id: null, iteration: null, item_index: 0,
        origin_key: newId("origin"), claim_type: "tactic", fingerprint: newId("fp"), payload: tacticV2,
        source_file_id: changed.source_file_id, created_at: nowIso() });
    });
    const [newTacticVersion] = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, changed.workspace_id), eq(t.accuracyItemVersions.run_id, tacticRun2)));
    const tacticAssembly = await createAssembly({ workspace_id: changed.workspace_id, actor, source_file_ids: [changed.source_file_id],
      selections: [{ item_version_id: newTacticVersion.id, reason: "new tactic same canonical head" }],
      mappings: [], coverage_run_ids: [], extraction_runs: [
        { call_kind: "inventory_extract", run_id: tacticRun2, source_file_id: changed.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: tacticBatch2.id });
    await reviewAssembly({ workspace_id: changed.workspace_id, assembly_id: tacticAssembly.id,
      expected_fingerprint: tacticAssembly.fingerprint, expected_review_id: null, decision: "approve",
      rationale: "Approve changed tactic head.", advisory_overrides: [], reviewer });

    expect(assembly.generation_key).not.toBe(tacticBatch2.id);
    expect(gapPub.version.claim_id).toBeDefined();
    await expect(approvedLiveInventory(changed.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
  });

  it("serializes concurrent review and batch publication and cleans up review records", async () => {
    const scope = await fixture();
    const { assembly } = await completeAssembly(scope);
    const newerGap = await publishKind(scope, "gap", gap(scope, "Concurrent newer gap"));
    await accuracyDb().update(t.accuracyExtractionBatches).set({ drafts_persisted: false, run_ids: [], created_claim_ids: [] })
      .where(eq(t.accuracyExtractionBatches.id, newerGap.batch.id));

    const [reviewResult, publishResult] = await Promise.allSettled([
      reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
        expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "approve",
        rationale: "Concurrent approval.", advisory_overrides: [], reviewer }),
      applyExtractionBatch(newerGap.batch, [newerGap.run_id], [newerGap.version.claim_id], async () => {}),
    ]);
    expect(publishResult.status).toBe("fulfilled");
    if (reviewResult.status === "fulfilled") {
      await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
    } else {
      expect(reviewResult.reason).toMatchObject({ code: "conflict" });
    }

    const cleanupScope = await fixture();
    const approved = await approveCurrentAssembly(cleanupScope);
    const deleted = await deleteWorkspace(cleanupScope.workspace_id);
    workspaces.splice(workspaces.indexOf(cleanupScope.workspace_id), 1);
    expect(deleted.deleted.assembly_reviews).toBeGreaterThan(0);
    expect(deleted.deleted.assembly_items).toBeGreaterThan(0);
    expect(deleted.deleted.assemblies).toBeGreaterThan(0);
    await expect(assemblyReviewState(cleanupScope.workspace_id, approved.assembly.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
