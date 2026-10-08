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
import { prioritizeModule } from "@/accuracy/modules/partial-split/module";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { getClaim, insertClaim } from "@/accuracy/store/claim-store";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
vi.mock("@/lib/iegp/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iegp/db")>();
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse", {
    max: 6,
    connection: { application_name: "kan38-assembly-review-test" },
  });
  const database = drizzle(client);
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { ...actual, sharedDb: () => database };
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
        priority_origin: "review", priority_scoring: { mode: "deterministic", validated: false, score: 75 },
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
    expect(projectedGap?.metadata).toMatchObject({ priority: "high", priority_band: "high", priority_rationale: "Workflow reprioritization.", priority_origin: "review", priority_scoring: { mode: "deterministic", validated: false, score: 75 } });
    expect(projectedGap?.metadata).not.toHaveProperty("gap_ids");
    expect(projectedGap?.metadata).not.toHaveProperty("parent_gap_id");
    expect(live?.coverage).toHaveLength(1);
    expect(live?.bindings.every((binding) => binding.review_id)).toBe(true);
  });

  it("native production priority refuses missing factual validation while preserving approved payload and accepted band", async () => {
    const scope = await fixture();
    const { gapPub } = await approveCurrentAssembly(scope);
    const rawMetadata = { statement: "Raw drifted statement", parent_gap_id: "raw-parent", provenance: [], priority: "low", priority_band: "low", priority_origin: "review" };
    await accuracyDb().update(t.accuracyClaims).set({ statement: rawMetadata.statement, metadata: rawMetadata }).where(eq(t.accuracyClaims.id, gapPub.version.claim_id));
    const before = (await approvedLiveInventory(scope.workspace_id))!.claims.find(row => row.id === gapPub.version.claim_id)!;
    const ctx = { workspace_id: scope.workspace_id, route: { connected: false, auth: "none" } } as unknown as AccuracyModuleContext;

    const result = await prioritizeModule.run({ workspace_id: scope.workspace_id, gap_ids: [gapPub.version.claim_id] }, ctx);

    expect(result.output.placements).toHaveLength(0);
    expect("skipped" in result.output && result.output.skipped).toContainEqual({ gap_id: gapPub.version.claim_id, reason: "claim_validation_not_current" });
    const raw = await getClaim(scope.workspace_id, gapPub.version.claim_id);
    expect(raw?.statement).toBe(rawMetadata.statement);
    expect(raw?.metadata).toEqual(rawMetadata);
    const after = (await approvedLiveInventory(scope.workspace_id))!.claims.find(row => row.id === gapPub.version.claim_id)!;
    expect(after.statement).toBe(before.statement);
    expect(after.metadata).toEqual(before.metadata);
    expect(after.metadata).not.toHaveProperty("parent_gap_id");
  });

  it("native production priority preserves legacy metadata while retaining a scoring suggestion", async () => {
    const scope = await fixture();
    const payload = { statement: "Legacy source need", provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "supports the selected item" }], priority: "low", priority_band: "low", priority_origin: "review" };
    const claim = await insertClaim({ workspace_id: scope.workspace_id, claim_type: "gap", statement: payload.statement, validated: true, metadata: payload });
    const ctx = { workspace_id: scope.workspace_id, run: { note: () => {}, step: async (_name: string, operation: () => Promise<unknown>) => operation() }, route: { connected: false, auth: "none" } } as unknown as AccuracyModuleContext;

    const draft = await prioritizeModule.run({ workspace_id: scope.workspace_id, gap_ids: [claim.id] }, ctx);
    expect(draft.output.placements).toEqual([]);
    const { applyClaimValidation } = await import("@/accuracy/store/claim-store");
    await applyClaimValidation({ workspace_id: scope.workspace_id, claim_ids: [claim.id], action: "validate", actor: reviewer.actor, rationale: "Reviewed legacy source facts" });
    await prioritizeModule.run({ workspace_id: scope.workspace_id, gap_ids: [claim.id] }, ctx);

    expect((await getClaim(scope.workspace_id, claim.id))?.metadata).toMatchObject({ ...payload, priority_scoring: { validated: false, gap_id: claim.id } });
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

it("binds exact approved structured facts and current human validation to the reviewer", async () => {
  const scope = await fixture();
  const { emptyGapStructuredFields, claimValidationFreshness, claimFactualRevision } = await import("@/accuracy/domain/structured-fields");
  const payload = { ...gap(scope, "Source-backed treatment evidence"), structured: emptyGapStructuredFields("not_stated") };
  const { assembly } = await completeAssembly(scope, payload);
  await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
    decision: "approve", rationale: "Reviewed exact source and factual support", advisory_overrides: [], reviewer });
  const live = (await approvedLiveInventory(scope.workspace_id))!;
  const selected = live.claims.find(row => row.claim_type === "gap")!;
  expect(selected.metadata).toMatchObject({ structured: payload.structured,
    validation: { by: reviewer.actor.name, rationale: "Reviewed exact source and factual support", assembly_fingerprint: assembly.fingerprint } });
  expect(claimValidationFreshness(selected)).toBe("current");
  expect(live.coverage[0]).toMatchObject({ validated: true, dimensions: {
    gap_revision: claimFactualRevision(selected), actor: reviewer.actor, assembly_fingerprint: assembly.fingerprint,
  } });
});

it("keeps an explicit manual pending coverage successor inactive until exact approval, without a provider", async () => {
  const scope = await fixture();
  const { assembly } = await approveCurrentAssembly(scope);
  const { createCoverageAssemblyRevision } = await import("@/accuracy/kernel/assembly-revision");
  const gap = assembly.items.find(item => item.claim_type === "gap")!, tactic = assembly.items.find(item => item.claim_type === "tactic")!;
  const result = await createCoverageAssemblyRevision({ workspace_id: scope.workspace_id, org_id: scope.org_id,
    parent_assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint, expected_head_id: assembly.id,
    author: { ...reviewer, role: "contributor" }, gap_version_id: gap.id, tactic_version_id: tactic.id,
    overall: "pending", evidence: [], reason: "Evidence needs a new human assessment" });
  expect(result.assembly.items).toEqual(assembly.items);
  expect(result.review_state.status).toBe("pending");
  await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
  await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: result.assembly.id,
    expected_fingerprint: assembly.fingerprint, decision: "approve", rationale: "Stale approval", reviewer }))
    .rejects.toMatchObject({ code: "conflict" });
  await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: result.assembly.id,
    expected_fingerprint: result.assembly.fingerprint, decision: "approve", rationale: "Reviewed explicitly pending pair",
    advisory_overrides: result.review_state.advisories.map(finding => ({ code: finding.code, item_version_ids: finding.item_version_ids, reason: "Pending work remains visible" })), reviewer });
  const live = (await approvedLiveInventory(scope.workspace_id))!;
  expect(live.coverage[0]).toMatchObject({ overall: "pending", validated: false });
  expect(live.mappings).toEqual([]);
  const { listCoveragePage, assessCoveragePage } = await import("@/accuracy/store/coverage-store");
  expect((await listCoveragePage({ workspace_id: scope.workspace_id })).pairs[0]).toMatchObject({ overall: "pending", protected: true });
  expect((await assessCoveragePage({ workspace_id: scope.workspace_id, assess: async () => { throw new Error("Explicit human pending must remain protected"); } })).attempts).toEqual([]);
});

it.each(["single source", "multiple sources", "later priority decision", "split again after inverse", "copy archived split", "copy stale priority", "assessment resume", "assessment adoption", "legacy assessment adoption"])("publishes managed split/inverse only after exact reviews: %s", async scenario => {
  const scope = await fixture();
  const { assembly } = await approveCurrentAssembly(scope);
  if (scenario === "multiple sources") {
    const other = await addSource(scope);
    const extra = await completeAssembly(other, gap(other, "Independent source question"), tactic(other, "Independent source tactic"));
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: extra.assembly.id, expected_fingerprint: extra.assembly.fingerprint,
      decision: "approve", rationale: "Reviewed independent source", advisory_overrides: [], reviewer });
  }
  const { readAccuracySplitInputs, applyAccuracySplit, rollbackAccuracySplit, listAccuracySplitOperations } = await import("@/accuracy/store/partial-split-store");
  const selectedGap = assembly.items.find(item => item.claim_type === "gap")!;
  const state = await readAccuracySplitInputs({ workspace_id: scope.workspace_id, gap_id: selectedGap.canonical_claim_id });
  const proposal = { workspace_id: scope.workspace_id, parent_gap_id: selectedGap.canonical_claim_id, ...state.revisions, confirmed: true,
    addressed_name: "Addressed source portion", addressed_statement: "Source-backed addressed portion", open_name: "Unresolved residual",
    open_statement: "Remaining unresolved treatment question", addressed_tactic_ids: state.supporting.map(pair => pair.tactic_id),
    uncovered_dimensions: ["population" as const], addressed_evidence: state.evidence, open_evidence: [], confidence: 100, rationale: ["Human confirmed the exact slices"] };
  const author = { ...reviewer, role: "contributor" as const };
  const request = { workspace_id: scope.workspace_id, proposal, operation_key: newId("split-key"), actor: author.actor, author, rationale: "Confirmed source-backed split" };
  const beforeClaims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id));
  const assemblyOwner = await import("@/accuracy/store/assembly-store");
  const failCheck = vi.spyOn(assemblyOwner, "createAssembly").mockRejectedValueOnce(new Error("Injected successor check failure"));
  try { await expect(applyAccuracySplit(request)).rejects.toThrow("Injected successor check failure"); } finally { failCheck.mockRestore(); }
  expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id))).toEqual(beforeClaims);
  expect(await listAccuracySplitOperations(scope.workspace_id)).toEqual([]);
  expect((await approvedLiveInventory(scope.workspace_id))!.claims.some(row => row.id === selectedGap.canonical_claim_id)).toBe(true);
  const candidate = await applyAccuracySplit(request);
  expect(candidate).toMatchObject({ state: "awaiting_approval" });
  expect(await applyAccuracySplit(request)).toEqual(candidate);
  expect((await getClaim(scope.workspace_id, selectedGap.canonical_claim_id))?.status).not.toBe("retired");
  await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
  const reviewCandidate = async (assembly_id: string) => {
    const detail = await assemblyReviewState(scope.workspace_id, assembly_id);
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id, expected_fingerprint: detail.fingerprint,
      expected_review_id: detail.expected_review_id, decision: "approve", rationale: "Reviewed exact successor and pending work", reviewer,
      advisory_overrides: detail.advisories.map(f => ({ code: f.code, item_version_ids: f.item_version_ids, reason: "Residual stays pending" })) });
  };
  if (scenario === "legacy assessment adoption") {
    const { readAssembly } = await import("@/accuracy/store/assembly-store");
    const { assemblyFingerprint } = await import("@/accuracy/domain/assembly");
    const oldAssembly = (await readAssembly(scope.workspace_id, candidate.assembly_id!))!;
    const coverage = oldAssembly.coverage.map(pair => { const old = { ...pair }; delete old.intent; return old; });
    const revisions = await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(eq(t.accuracyAssemblyRevisions.workspace_id, scope.workspace_id));
    for (const revision of revisions) await accuracyDb().update(t.accuracyAssemblyRevisions).set({ change: { ...revision.change,
      coverage: revision.change.coverage?.map(pair => { const old = { ...pair }; delete old.intent; return old; }) } }).where(eq(t.accuracyAssemblyRevisions.id, revision.id));
    await accuracyDb().update(t.accuracyAssemblies).set({ coverage, fingerprint: assemblyFingerprint({ ...oldAssembly, coverage }) })
      .where(eq(t.accuracyAssemblies.id, oldAssembly.id));
  }
  await reviewCandidate(candidate.assembly_id!);
  if (scenario === "legacy assessment adoption") {
    const rows = await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, scope.workspace_id));
    for (const row of rows) {
      const dimensions = { ...(row.dimensions as Record<string, unknown>) };
      delete dimensions.coverage_intent; delete dimensions.human_rejected;
      await accuracyDb().update(t.accuracyCoverageJoins).set({ dimensions }).where(eq(t.accuracyCoverageJoins.id, row.id));
    }
  }
  const live = (await approvedLiveInventory(scope.workspace_id))!;
  expect(live.claims.map(row => row.id)).not.toContain(selectedGap.canonical_claim_id);
  expect(live.claims.map(row => row.id)).toContain(candidate.open_residual_gap_id);
  expect(live.coverage.find(row => row.gap_id === candidate.open_residual_gap_id)).toMatchObject({ overall: "pending", validated: false });
  expect((await listAccuracySplitOperations(scope.workspace_id))[0].state).toBe("applied");
  if (scenario.includes("assessment")) {
    const { assessCoveragePage, listCoveragePage } = await import("@/accuracy/store/coverage-store");
    const { accuracyTransactionActive } = await import("@/accuracy/store/db");
    const residual = (await listCoveragePage({ workspace_id: scope.workspace_id })).pairs.find(pair => pair.gap.id === candidate.open_residual_gap_id)!;
    expect(residual).toMatchObject({ protected: false, overall: "pending", validated: false });
    const failed = await assessCoveragePage({ workspace_id: scope.workspace_id, assess: async () => { throw new Error("Residual provider unavailable"); } });
    expect(failed.attempts).toHaveLength(1);
    expect(failed.progress.failed).toBe(1);
    const assessed = await assessCoveragePage({ workspace_id: scope.workspace_id, assess: async () => {
      expect(accuracyTransactionActive()).toBe(false);
      return { overall: "partial", rationale: "Residual model suggestion", evidence: [scope.block_id], run_id: "residual-model" };
    } });
    expect(assessed.attempts).toHaveLength(1);
    expect(await approvedLiveInventory(scope.workspace_id)).toEqual(live);
    const refreshed = (await listCoveragePage({ workspace_id: scope.workspace_id })).pairs.find(pair => pair.gap.id === candidate.open_residual_gap_id)!;
    expect(refreshed).toMatchObject({ overall: "pending", validated: false, protected: false,
      suggestion: { overall: "partial", freshness: "current", evidence: [scope.block_id] } });
    expect((await assessCoveragePage({ workspace_id: scope.workspace_id, assess: async () => { throw new Error("Saved success must not repeat"); } })).attempts).toEqual([]);
    if (scenario === "assessment resume") {
      // Assessment alone is not a later human edit. The guarded inverse can still be approved.
      const inverse = await rollbackAccuracySplit({ workspace_id: scope.workspace_id, operation_id: candidate.operation_id,
        actor: author.actor, author, rationale: "Inverse after non-authoritative assessment" });
      expect(inverse).toMatchObject({ state: "awaiting_inverse_approval" });
      if (!inverse) throw new Error("Managed inverse must return its successor");
      await reviewCandidate(inverse.assembly_id);
      expect((await approvedLiveInventory(scope.workspace_id))!.claims.map(row => row.id)).toContain(selectedGap.canonical_claim_id);
    } else {
      const { upsertCoverageDecision } = await import("@/accuracy/store/coverage-store");
      const adopted = await upsertCoverageDecision({ workspace_id: scope.workspace_id, gap_id: residual.gap.id, tactic_id: residual.tactic.id,
        expected_gap_revision: residual.gap_revision, expected_tactic_revision: residual.tactic_revision,
        overall: refreshed.suggestion!.overall, evidence: refreshed.suggestion!.evidence, rationale: "Human reviewed the residual assessment", actor: author.actor, author });
      expect(adopted.awaiting_approval).toBe(true);
      await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
      await expect(reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: adopted.assembly_id!, expected_fingerprint: assembly.fingerprint,
        decision: "approve", rationale: "Stale review is forbidden", reviewer })).rejects.toMatchObject({ code: "conflict" });
      await reviewCandidate(adopted.assembly_id!);
      const accepted = (await listCoveragePage({ workspace_id: scope.workspace_id })).pairs.find(pair => pair.gap.id === candidate.open_residual_gap_id)!;
      expect(accepted).toMatchObject({ overall: "partial", validated: true, protected: true });
      await expect(rollbackAccuracySplit({ workspace_id: scope.workspace_id, operation_id: candidate.operation_id,
        actor: author.actor, author, rationale: "Cannot erase the later human adoption" })).rejects.toMatchObject({ code: "rollback_blocked" });
    }
    return;
  }
  if (scenario === "copy stale priority") {
    const { readAccuracyPriorityInputs, validateAccuracyPlacement, listAccuracyPlacements } = await import("@/accuracy/store/priority-store");
    const input = await readAccuracyPriorityInputs({ workspace_id: scope.workspace_id, gap_id: candidate.open_residual_gap_id });
    await validateAccuracyPlacement({ workspace_id: scope.workspace_id, gap_id: candidate.open_residual_gap_id, actor: author.actor,
      expected_input_revision: input.input_revision, expected_config_revision: input.config_revision, band: "defer", rationale: "Human triage before factual drift" });
    await accuracyDb().update(t.accuracyClaims).set({ statement: "Later residual factual drift" }).where(eq(t.accuracyClaims.id, candidate.open_residual_gap_id));
    const { copyExperimentWorkspace } = await import("@/accuracy/experiments/copy-workspace");
    const copy = await copyExperimentWorkspace({ source_workspace_id: scope.workspace_id, source_file_ids: [scope.source_file_id] });
    workspaces.unshift(copy.workspace_id);
    const placement = (await listAccuracyPlacements(copy.workspace_id))[0];
    expect(placement).toMatchObject({ band: "defer", validated: false, validation: { freshness: "stale" } });
    return;
  }
  if (scenario === "copy archived split") {
    const { copyExperimentWorkspace } = await import("@/accuracy/experiments/copy-workspace");
    const { createExperiment } = await import("@/accuracy/experiments/records");
    const { updateClaim } = await import("@/accuracy/store/claim-edit");
    const { runMixedComparison } = await import("@/accuracy/experiments/mixed-comparison");
    const nomination = { assembly_id: assembly.id, fingerprint: assembly.fingerprint };
    const comparison = await runMixedComparison({ source_workspace_id: scope.workspace_id, source_file_ids: [scope.source_file_id],
      mixed: nomination, baseline: nomination, pack_id: "beone-bgb-58067-prmt5i", actor: author.actor });
    for (const attempt of Object.values(comparison.attempts)) if (attempt) workspaces.unshift(attempt.workspace_id);
    await accuracyDb().delete(t.accuracyMixedComparisons).where(eq(t.accuracyMixedComparisons.id, comparison.header.id));
    expect(comparison.result?.evidence.primary_error?.phase).not.toBe("setup");
    expect(comparison.attempts.mixed).not.toBeNull();
    let source_workspace_id = scope.workspace_id, source_file_id = scope.source_file_id;
    for (let iteration = 0; iteration < 2; iteration++) {
      const copy = await copyExperimentWorkspace({ source_workspace_id, source_file_ids: [source_file_id] });
      workspaces.unshift(copy.workspace_id);
      await createExperiment({ ...copy, source_workspace_id, pack_id: "beone-bgb-58067-prmt5i", condition: {} });
      const operations = await listAccuracySplitOperations(copy.workspace_id);
      expect(operations).toHaveLength(1);
      expect(operations[0].state).toBe("archived");
      const before = await getClaim(copy.workspace_id, operations[0].parent_gap_id);
      await updateClaim({ workspace_id: copy.workspace_id, claim_id: operations[0].open_residual_gap_id,
        patch: { statement: `Later human decision in isolated copy ${iteration}` }, actor: author.actor, rationale: "Copied residual refined without source authority" });
      await expect(rollbackAccuracySplit({ workspace_id: copy.workspace_id, operation_id: operations[0].id,
        actor: author.actor, author, rationale: "Attempt replay of archived source operation" })).rejects.toMatchObject({ code: "operation_conflict" });
      expect(await getClaim(copy.workspace_id, operations[0].parent_gap_id)).toEqual(before);
      const history = (copy.baseline_snapshot as { managed_history: { split_operations: Array<{ state: string }> } }).managed_history;
      expect(history.split_operations[0].state).toBe("applied");
      source_workspace_id = copy.workspace_id; source_file_id = copy.source_id_map[source_file_id];
    }
    expect((await listAccuracySplitOperations(scope.workspace_id))[0].state).toBe("applied");
    return;
  }
  if (scenario === "later priority decision") {
    const { readAccuracyPriorityInputs, setAccuracyPlacement } = await import("@/accuracy/store/priority-store");
    const input = await readAccuracyPriorityInputs({ workspace_id: scope.workspace_id, gap_id: candidate.open_residual_gap_id });
    await setAccuracyPlacement({ workspace_id: scope.workspace_id, gap_id: candidate.open_residual_gap_id, actor: author.actor,
      expected_input_revision: input.input_revision, expected_config_revision: input.config_revision, band: "defer", rationale: "Later human triage must survive" });
    await expect(rollbackAccuracySplit({ workspace_id: scope.workspace_id, operation_id: candidate.operation_id,
      actor: author.actor, author, rationale: "Attempt inverse after human decision" })).rejects.toMatchObject({ code: "rollback_blocked" });
    expect((await listAccuracySplitOperations(scope.workspace_id))[0].state).toBe("applied");
    return;
  }
  const inverse = await rollbackAccuracySplit({ workspace_id: scope.workspace_id, operation_id: candidate.operation_id,
    actor: author.actor, author, rationale: "Restore the original reviewed question" });
  expect(inverse).toMatchObject({ state: "awaiting_inverse_approval" });
  await reviewCandidate(inverse!.assembly_id);
  expect((await approvedLiveInventory(scope.workspace_id))!.claims.map(row => row.id)).toContain(selectedGap.canonical_claim_id);
  expect((await listAccuracySplitOperations(scope.workspace_id))[0].state).toBe("rolled_back");
  expect((await assemblyReviewState(scope.workspace_id, assembly.id)).latest_decision?.decision).toBe("approve");
  if (scenario === "split again after inverse") {
    const restored = await readAccuracySplitInputs({ workspace_id: scope.workspace_id, gap_id: selectedGap.canonical_claim_id });
    const again = await applyAccuracySplit({ ...request, operation_key: newId("split-key"),
      proposal: { ...proposal, ...restored.revisions, addressed_statement: "New reviewed addressed portion", open_statement: "New remaining question" } });
    await reviewCandidate(again.assembly_id!);
    expect((await listAccuracySplitOperations(scope.workspace_id)).find(operation => operation.id === again.operation_id)?.state).toBe("applied");
  }
});

it("refuses live consumption when persisted facts drift behind an exact review token", async () => {
  const scope = await fixture();
  const { assembly } = await approveCurrentAssembly(scope);
  const selected = assembly.items.find(item => item.claim_type === "gap")!;
  await accuracyDb().update(t.accuracyClaims).set({ statement: "Changed factual question after approval" })
    .where(eq(t.accuracyClaims.id, selected.canonical_claim_id));
  await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
});

it("retains both source heads in a manual cross-source successor and leaves other pairs pending", async () => {
  const scope = await fixture();
  const first = await approveCurrentAssembly(scope);
  const secondScope = await addSource(scope);
  const second = await completeAssembly(secondScope, gap(secondScope, "A separate source question"), tactic(secondScope, "A separate source tactic"));
  await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: second.assembly.id, expected_fingerprint: second.assembly.fingerprint,
    decision: "approve", rationale: "Reviewed second source inventory", advisory_overrides: [], reviewer });
  const { createCoverageAssemblyRevision } = await import("@/accuracy/kernel/assembly-revision");
  const successor = await createCoverageAssemblyRevision({ workspace_id: scope.workspace_id, org_id: scope.org_id,
    parent_assembly_id: first.assembly.id, expected_head_id: first.assembly.id, expected_fingerprint: first.assembly.fingerprint,
    author: { ...reviewer, role: "contributor" }, gap_version_id: first.gapPub.version.id, tactic_version_id: second.tacticPub.version.id,
    overall: "partial", evidence: [scope.block_id, secondScope.block_id], reason: "Human reviewed support across both sources" });
  expect(successor.assembly.items).toHaveLength(4);
  expect(successor.assembly.coverage).toHaveLength(4);
  await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
  await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: successor.assembly.id, expected_fingerprint: successor.assembly.fingerprint,
    decision: "approve", rationale: "Reviewed exact cross-source selection", reviewer,
    advisory_overrides: successor.review_state.advisories.map(f => ({ code: f.code, item_version_ids: f.item_version_ids, reason: "Other cross-source pair remains pending" })) });
  const live = (await approvedLiveInventory(scope.workspace_id))!;
  expect(live.claims).toHaveLength(4);
  expect(new Set(live.bindings.map(binding => binding.assembly_id))).toEqual(new Set([successor.assembly.id]));
  expect(live.coverage.filter(pair => pair.overall === "pending")).toEqual([expect.objectContaining({ validated: false })]);
});

it("refuses an unresolved approved-history copy atomically instead of retaining source review references", async () => {
  const scope = await fixture();
  await approveCurrentAssembly(scope);
  const { copyExperimentWorkspace } = await import("@/accuracy/experiments/copy-workspace");
  const [claim] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id));
  await accuracyDb().update(t.accuracyClaims).set({ metadata: { ...(claim.metadata as object), validation: { assembly_review_id: "missing-external-review" } } }).where(eq(t.accuracyClaims.id, claim.id));
  const before = await accuracyDb().select({ id: t.accuracyWorkspaces.id }).from(t.accuracyWorkspaces);
  await expect(copyExperimentWorkspace({ source_workspace_id: scope.workspace_id, source_file_ids: [scope.source_file_id] }))
    .rejects.toMatchObject({ code: "unresolved_reference" });
  expect(await accuracyDb().select({ id: t.accuracyWorkspaces.id }).from(t.accuracyWorkspaces)).toEqual(before);
});

it.each(["current", "stale"])("archives managed approval history and repeats copies without manufacturing approval authority: %s", async freshness => {
  const scope = await fixture();
  const approved = await approveCurrentAssembly(scope);
  const { copyExperimentWorkspace } = await import("@/accuracy/experiments/copy-workspace");
  const { createExperiment, getExperiment } = await import("@/accuracy/experiments/records");
  if (freshness === "stale") await accuracyDb().update(t.accuracyClaims).set({ statement: "Later source factual drift" })
    .where(eq(t.accuracyClaims.id, approved.gapPub.version.claim_id));
  const original = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id));
  let source_workspace_id = scope.workspace_id, source_file_id = scope.source_file_id;
  for (let iteration = 0; iteration < 2; iteration++) {
    const copy = await copyExperimentWorkspace({ source_workspace_id, source_file_ids: [source_file_id] });
    workspaces.unshift(copy.workspace_id);
    if (iteration === 0) await expect(copyExperimentWorkspace({ source_workspace_id: copy.workspace_id, source_file_ids: [copy.source_id_map[source_file_id]] }))
      .rejects.toMatchObject({ code: "unresolved_reference" });
    const record = await createExperiment({ ...copy, source_workspace_id, pack_id: "beone-bgb-58067-prmt5i", condition: {} });
    const stored = await getExperiment({ workspace_id: copy.workspace_id, experiment_id: record.id });
    const archive = (stored!.baseline_snapshot as { managed_history: { authority: string; item_versions: Array<{ id: string; workspace_id: string }>; reviews: Array<{ id: string; rationale: string }> } }).managed_history;
    expect(archive.authority).toBe("audit_only");
    const { claimValidationFreshness } = await import("@/accuracy/domain/structured-fields");
    const audited = (stored!.baseline_snapshot as { managed_history: { claim_audit: Array<{ metadata: unknown }> } }).managed_history.claim_audit;
    const originalGap = original.find(row => row.id === approved.gapPub.version.claim_id)!;
    expect(claimValidationFreshness(originalGap)).toBe(freshness);
    expect(audited.some(row => JSON.stringify(row.metadata).includes(String((originalGap.metadata as { validation: { factual_revision: string } }).validation.factual_revision)))).toBe(true);
    expect(archive.item_versions).toHaveLength(2);
    expect(archive.item_versions.every(row => row.workspace_id === copy.workspace_id)).toBe(true);
    expect(archive.reviews).toHaveLength(1);
    const graph = (stored!.baseline_snapshot as { managed_history: import("@/accuracy/experiments/baseline-history").ManagedBaselineHistory }).managed_history;
    expect(graph.reviews[0]).toMatchObject({ assembly_id: graph.assemblies[0].id, rationale: "Approved for live inventory." });
    for (const version of graph.item_versions) {
      expect(version.source_file_id).toBe(copy.source_id_map[source_file_id]);
      expect(Object.values(copy.claim_id_map)).toContain(version.claim_id);
      expect((version.payload.provenance as Array<{ source_file_id: string }>)[0].source_file_id).toBe(copy.source_id_map[source_file_id]);
      expect(graph.runs.map(row => row.id)).toContain(version.run_id);
    }
    for (const claim of graph.claim_audit) {
      const metadata = claim.metadata as { validation?: { assembly_review_id?: string } };
      if (metadata.validation?.assembly_review_id) expect(graph.reviews.map(row => row.id)).toContain(metadata.validation.assembly_review_id);
    }
    expect(archive.item_versions.some(row => approved.assembly.items.some(item => row.id === item.id))).toBe(false);
    expect(await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, copy.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyAssemblies).where(eq(t.accuracyAssemblies.workspace_id, copy.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyAssemblyReviews).where(eq(t.accuracyAssemblyReviews.workspace_id, copy.workspace_id))).toEqual([]);
    const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id));
    expect(claims.every(claim => !claim.validated)).toBe(true);
    for (const claim of claims) {
      expect(claim.metadata).not.toHaveProperty("approved_assembly_item_version_id");
      expect(claim.metadata).not.toHaveProperty("validation.assembly_review_id");
    }
    expect((await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, copy.workspace_id))).every(row => !row.validated)).toBe(true);
    expect(await approvedLiveInventory(copy.workspace_id)).toBeNull();
    source_workspace_id = copy.workspace_id; source_file_id = copy.source_id_map[source_file_id];
  }
  expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id))).toEqual(original);
});


it.each(["success", "failure"])("refuses a managed assessment after exact approval changes during %s", async outcome => {
  const scope = await fixture();
  const first = await approveCurrentAssembly(scope);
  const other = await addSource(scope);
  const second = await completeAssembly(other, gap(other, "Independent need"), tactic(other, "Independent tactic"));
  await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: second.assembly.id, expected_fingerprint: second.assembly.fingerprint,
    decision: "approve", rationale: "Reviewed independent source", advisory_overrides: [], reviewer });
  const { assessCoveragePage, listCoveragePage } = await import("@/accuracy/store/coverage-store");
  const original = await listCoveragePage({ workspace_id: scope.workspace_id });
  await expect(assessCoveragePage({ workspace_id: scope.workspace_id, assess: async () => {
    const state = await assemblyReviewState(scope.workspace_id, first.assembly.id);
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: first.assembly.id, expected_fingerprint: state.fingerprint,
      expected_review_id: state.expected_review_id, decision: "approve", rationale: "A later exact human review", advisory_overrides: [], reviewer });
    if (outcome === "failure") throw new Error("Provider failed during approval change");
    return { overall: "partial", rationale: "Source-backed suggestion", evidence: [scope.block_id], run_id: "stale-provider-result" };
  } })).rejects.toMatchObject({ code: "stale_snapshot" });
  const after = await listCoveragePage({ workspace_id: scope.workspace_id });
  expect(after.snapshot).not.toBe(original.snapshot);
  expect(after.progress).toMatchObject({ assessed: 2, validated: 2, pending: 2, failed: 0 });
  expect(after.pairs.filter(pair => !pair.validated).every(pair => pair.overall === "pending" && !pair.suggestion)).toBe(true);
});


it.each(["current", "legacy"])("keeps %s human rejections and decisions protected while automatic pending work resumes", async format => {
  const scope = await fixture();
  const first = await approveCurrentAssembly(scope);
  const other = await addSource(scope);
  const second = await completeAssembly(other, gap(other, "Independent unmet need"), tactic(other, "Independent publication"));
  await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: second.assembly.id, expected_fingerprint: second.assembly.fingerprint,
    decision: "approve", rationale: "Independent source approved", advisory_overrides: [], reviewer });
  const { upsertCoverageDecision, rejectCoveragePair, coveragePairRevisions, listCoveragePage, assessCoveragePage, saveCoverageAssessment } = await import("@/accuracy/store/coverage-store");
  const { readAssembly } = await import("@/accuracy/store/assembly-store");
  const { assemblyFingerprint } = await import("@/accuracy/domain/assembly");
  const author = { ...reviewer, role: "contributor" as const };
  const rejected = { workspace_id: scope.workspace_id, gap_id: first.gapPub.version.claim_id, tactic_id: second.tacticPub.version.claim_id };
  const actualDecision = { workspace_id: scope.workspace_id, gap_id: first.gapPub.version.claim_id, tactic_id: first.tacticPub.version.claim_id };
  const approveCandidate = async (assembly_id: string) => {
    const state = await assemblyReviewState(scope.workspace_id, assembly_id);
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id, expected_fingerprint: state.fingerprint,
      expected_review_id: state.expected_review_id, decision: "approve", rationale: "Exact human review", reviewer,
      advisory_overrides: state.advisories.map(f => ({ code: f.code, item_version_ids: f.item_version_ids, reason: "Unassessed pairs remain pending" })) });
  };
  const rejection = await rejectCoveragePair({ ...rejected, ...await coveragePairRevisions(rejected), actor: author.actor, author,
    // Even this exact reserved text must not reclassify the explicit FIRST pair as automatic.
    rationale: "This selected pair awaits assessment" });
  if (format === "legacy") {
    // Reconstruct the persisted pre-intent contract, including its immutable fingerprint and lineage.
    const assembly = (await readAssembly(scope.workspace_id, rejection.assembly_id!))!;
    const coverage = assembly.coverage.map(pair => { const old = { ...pair }; delete old.intent; return old; });
    const rows = await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(eq(t.accuracyAssemblyRevisions.workspace_id, scope.workspace_id));
    for (const row of rows) await accuracyDb().update(t.accuracyAssemblyRevisions).set({ change: { ...row.change,
      coverage: row.change.coverage?.map(pair => { const old = { ...pair }; delete old.intent; return old; }) } }).where(eq(t.accuracyAssemblyRevisions.id, row.id));
    await accuracyDb().update(t.accuracyAssemblies).set({ coverage, fingerprint: assemblyFingerprint({ ...assembly, coverage }) })
      .where(eq(t.accuracyAssemblies.id, assembly.id));
  }
  await approveCandidate(rejection.assembly_id!);
  if (format === "legacy") {
    const rows = await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, scope.workspace_id));
    for (const row of rows) {
      const dimensions = { ...(row.dimensions as Record<string, unknown>) };
      delete dimensions.coverage_intent; delete dimensions.human_rejected;
      await accuracyDb().update(t.accuracyCoverageJoins).set({ dimensions }).where(eq(t.accuracyCoverageJoins.id, row.id));
    }
    const legacyPage = await listCoveragePage({ workspace_id: scope.workspace_id });
    expect(legacyPage.pairs.find(pair => pair.gap.id === rejected.gap_id && pair.tactic.id === rejected.tactic_id)).toMatchObject({ protected: true, overall: "pending" });
    expect(legacyPage.pairs.filter(pair => !pair.protected)).toHaveLength(1);
  }
  // A later successor must retain BOTH the explicit rejection and the automatic placeholder's meaning.
  const accepted = await upsertCoverageDecision({ ...actualDecision, ...await coveragePairRevisions(actualDecision), overall: "limited",
    evidence: [scope.block_id], rationale: "Accepted precise human coverage", actor: author.actor, author });
  await approveCandidate(accepted.assembly_id!);
  const before = (await approvedLiveInventory(scope.workspace_id))!;
  const page = await listCoveragePage({ workspace_id: scope.workspace_id });
  const pending = page.pairs.find(pair => !pair.protected)!;
  expect(pending).toMatchObject({ overall: "pending", validated: false });
  expect(page.pairs.find(pair => pair.gap.id === rejected.gap_id && pair.tactic.id === rejected.tactic_id)).toMatchObject({ protected: true, overall: "pending", validated: false });
  expect(page.pairs.find(pair => pair.gap.id === actualDecision.gap_id && pair.tactic.id === actualDecision.tactic_id)).toMatchObject({ protected: true, overall: "limited", validated: true });
  for (const identity of [rejected, actualDecision]) await saveCoverageAssessment({ ...identity, ...await coveragePairRevisions(identity), expected_snapshot: page.snapshot,
    overall: "full", rationale: "Model must not overwrite this choice", evidence: [scope.block_id], run_id: "protected-attempt" });
  expect(await approvedLiveInventory(scope.workspace_id)).toEqual(before);
  const assessed = await assessCoveragePage({ workspace_id: scope.workspace_id, assess: async () => ({ overall: "partial", rationale: "Only automatic work",
    evidence: [other.block_id], run_id: "unassessed-attempt" }) });
  expect(assessed.attempts).toEqual([{ gap_id: pending.gap.id, tactic_id: pending.tactic.id }]);
  expect(await approvedLiveInventory(scope.workspace_id)).toEqual(before);
  const adopted = await upsertCoverageDecision({ workspace_id: scope.workspace_id, gap_id: pending.gap.id, tactic_id: pending.tactic.id,
    expected_gap_revision: pending.gap_revision, expected_tactic_revision: pending.tactic_revision, overall: "partial", evidence: [other.block_id],
    rationale: "Human adopts the automatic pair result", actor: author.actor, author });
  await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
  await approveCandidate(adopted.assembly_id!);
  expect((await listCoveragePage({ workspace_id: scope.workspace_id })).pairs.every(pair => pair.protected)).toBe(true);
  expect((await assessCoveragePage({ workspace_id: scope.workspace_id, assess: async () => { throw new Error("Protected pair reached model"); } })).attempts).toEqual([]);
});
