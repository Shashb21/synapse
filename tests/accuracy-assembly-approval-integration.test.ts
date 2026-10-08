import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as legacySchema from "@/lib/iegp/schema";
import { and, eq } from "drizzle-orm";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { statusDeriveModule, type StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";
import { activeAccuracyModuleId, activateAccuracyModule, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { GET as assembliesGet, POST as assembliesPost } from "@/app/api/accuracy/assemblies/route";
import { POST as priorityPost } from "@/app/api/accuracy/claims/priority/route";
import { POST as claimsPost } from "@/app/api/accuracy/claims/route";
import { POST as coverageAssist } from "@/app/api/accuracy/coverage/assist/route";
import { GET as missFlagGet, POST as missFlagPost } from "@/app/api/accuracy/review/route";
import { withAssemblyExperiment, withAssemblyPreparation } from "@/accuracy/kernel/assembly-context";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { approvedLiveInventory, reviewAssembly } from "@/accuracy/store/assembly-review-store";
import { applyClaimValidation, getClaim, insertClaim, listDownstreamClaims, persistClaimPatch, updateClaimMetadata } from "@/accuracy/store/claim-store";
import { listCoveragePairs } from "@/accuracy/store/coverage-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { applyExtractionBatch, createExtractionBatch } from "@/accuracy/store/extraction-batch-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import * as t from "@/accuracy/store/schema";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace, deleteWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { addFacilitatorTag, createWorkshopSnapshot } from "@/accuracy/store/workshop-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Role } from "@/modules/auth/roles";
import type { AccuracyModule } from "@/accuracy/kernel/contracts";
import { z } from "zod";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));

const actor = { name: "Assembly Agent", function: "medical_affairs" as const };
const reviewer = {
  subject: "reviewer-subject",
  provider: "test-idp",
  actor: { name: "Review Lead", function: "medical_affairs" as const },
  role: "medical_affairs" as const,
};
const workspaces: string[] = [];

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  await ensureAccuracySchema();
  const org_id = await createOrganization(newId("kan38-org"));
  const workspace_id = await createWorkspace({ org_id, name: "KAN38 workspace", slug: newId("kan38") });
  workspaces.push(workspace_id);
  await grantOrganizationAccess({ subject: reviewer.subject, org_id });
  const source = await insertSourceFile({ workspace_id, filename: "source.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "Shared source text supports the selected item.", parser: "test", created_at: nowIso() });
  const alternate_block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: alternate_block_id, workspace_id, source_file_id: source.id,
    index: 1, kind: "paragraph", heading: null, text: "Alternate source text is not part of the approved coverage input.", parser: "test", created_at: nowIso() });
  return { org_id, workspace_id, source_file_id: source.id, block_id, alternate_block_id };
}

function gap(scope: Fixture, statement = "Approved exact gap", id = newId("gap")) {
  return { id, statement, external_id: id,
    provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "supports the selected item" }] };
}

function tactic(scope: Fixture, name = "Approved exact tactic", id = newId("tac")) {
  return { id, name, type: "publication", status: "planned", evidence_question: "Does this close the gap?",
    origin: "inventory", provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "supports the selected item" }] };
}

async function extractionRun(scope: Fixture, claim_type: "gap" | "tactic", payload: Record<string, unknown> | Record<string, unknown>[]) {
  const id = newId("arun");
  const now = nowIso();
  const output = claim_type === "gap"
    ? { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: Array.isArray(payload) ? payload : [payload] }
    : { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: Array.isArray(payload) ? payload : [payload] };
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: claim_type === "gap" ? "need_extract" : "inventory_extract", agent_role: "judge", module_id: "test", module_version: "1",
    status: "ok", started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id }, output, steps: [] });
  return id;
}

async function coverageRun(
  scope: Fixture,
  gap_version_id: string,
  tactic_version_id: string,
  gap_payload: Record<string, unknown>,
  tactic_payload: Record<string, unknown>,
  overall = "partial",
) {
  const id = newId("arun");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: "coverage_decide", agent_role: "judge", module_id: "coverage", module_version: "1",
    status: "ok", started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, gap_id: gap_version_id, tactic_id: tactic_version_id, block_bundle_ids: [scope.block_id],
      selected_versions: { gap_version_id, tactic_version_id, gap_payload, tactic_payload } },
    output: { gap_id: gap_version_id, tactic_id: tactic_version_id, overall, quote_block_ids: [scope.block_id], confidence: 0.8, rationale: "Version-bound support." },
    steps: [] });
  return id;
}

async function publishAssembly(scope: Fixture, gapPayload = gap(scope), tacticPayload = tactic(scope), overall = "partial", opts?: { map?: boolean; residual?: boolean }) {
  const gapRun = await extractionRun(scope, "gap", gapPayload);
  const tacticPayloads = opts?.residual ? [tacticPayload, tactic(scope, "Residual partial tactic")] : [tacticPayload];
  const tacticRun = await extractionRun(scope, "tactic", tacticPayloads);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract", "inventory_extract"]);
  const created: string[] = [];
  await applyExtractionBatch(batch, [gapRun, tacticRun], created, async () => {
    created.push(...(await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: gapPayload.id as string, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: gapPayload.statement as string }] })).claim_ids);
    created.push(...(await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic",
      final_claims: tacticPayloads.map(payload => ({ id: payload.id as string, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: payload.name as string })) })).claim_ids);
  });
  const versions = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id));
  const gapVersion = versions.find(row => row.run_id === gapRun)!;
  const tacticVersion = versions.find(row => row.run_id === tacticRun && row.payload.name === tacticPayload.name)!;
  const residualTacticVersion = versions.find(row => row.run_id === tacticRun && row.id !== tacticVersion.id);
  const coverage_run_id = await coverageRun(scope, gapVersion.id, tacticVersion.id, gapVersion.payload, tacticVersion.payload, overall);
  const residualCoverage = residualTacticVersion ? await coverageRun(scope, gapVersion.id, residualTacticVersion.id,
    gapVersion.payload, residualTacticVersion.payload, "partial") : null;
  const assembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
    selections: [{ item_version_id: gapVersion.id, reason: "gap head" }, { item_version_id: tacticVersion.id, reason: "tactic head" },
      ...(residualTacticVersion ? [{ item_version_id: residualTacticVersion.id, reason: "residual evidence" }] : [])],
    mappings: opts?.map === false ? [] : [{ gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id },
      ...(residualTacticVersion ? [{ gap_version_id: gapVersion.id, tactic_version_id: residualTacticVersion.id }] : [])], coverage_run_ids: [coverage_run_id, ...(residualCoverage ? [residualCoverage] : [])],
    extraction_runs: [
      { call_kind: "need_extract", run_id: gapRun, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      { call_kind: "inventory_extract", run_id: tacticRun, source_file_id: scope.source_file_id, item_count: tacticPayloads.length, outcome: "items", evaluation_context: "production" },
    ],
    linking_complete: true, generation_key: batch.id });
  return { assembly, gapVersion, tacticVersion, residualTacticVersion };
}

async function publishInventoryOnlyAssembly(scope: Fixture, tacticPayload = tactic(scope)) {
  const tacticRun = await extractionRun(scope, "tactic", tacticPayload);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["inventory_extract"]);
  const created: string[] = [];
  await applyExtractionBatch(batch, [tacticRun], created, async () => {
    created.push(...(await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic",
      final_claims: [{ id: tacticPayload.id as string, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tacticPayload.name as string }] })).claim_ids);
  });
  const [tacticVersion] = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.run_id, tacticRun)));
  const assembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
    selections: [{ item_version_id: tacticVersion!.id, reason: "inventory head" }],
    mappings: [], coverage_run_ids: [],
    extraction_runs: [
      { call_kind: "inventory_extract", run_id: tacticRun, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
    ],
    linking_complete: true, generation_key: batch.id });
  return { assembly, tacticVersion: tacticVersion! };
}

async function approve(scope: Fixture, assembly: Awaited<ReturnType<typeof createAssembly>>) {
  return reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
    expected_review_id: null, decision: "approve", rationale: "Approved for exact live consumption.", advisory_overrides: [], reviewer });
}

function session(role: Role = reviewer.role, subject = reviewer.subject) {
  sessionContext.mockResolvedValue({ signed_in: true, demo: false, role, actor: reviewer.actor,
    session: { subject, email: "assembly-owner@example.test", provider_id: reviewer.provider, actor: reviewer.actor, role } });
}

async function reviewPost(body: Record<string, unknown>) {
  return assembliesPost(new Request("http://localhost/api/accuracy/assemblies", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

async function promoteMissFlag(body: Record<string, unknown>) {
  return missFlagPost(new Request("http://localhost/api/accuracy/review", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

async function claimIds(workspace_id: string) {
  const rows = await accuracyDb().select({ id: t.accuracyClaims.id }).from(t.accuracyClaims)
    .where(eq(t.accuracyClaims.workspace_id, workspace_id));
  return rows.map(row => row.id).sort();
}

beforeEach(() => { vi.stubEnv("OWNER_EMAILS", "assembly-owner@example.test"); session(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of workspaces.splice(0)) await deleteWorkspace(id);
});

describe("KAN-38 assembly approval enforcement", () => {
  it("blocks managed live readers until approval and then serves exact approved payloads", async () => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);

    await expect(listDownstreamClaims(scope.workspace_id, { limit: null })).rejects.toMatchObject({ code: "approval_required" });
    await expect(runAccuracyModule({ call_kind: "merge_dedupe", agent_role: "none", input: { workspace_id: scope.workspace_id },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toBeInstanceOf(AssemblyReviewError);
    await expect(withAssemblyPreparation(() => listDownstreamClaims(scope.workspace_id, { limit: null }))).resolves.toHaveLength(2);

    await approve(scope, assembly);
    await accuracyDb().update(t.accuracyClaims).set({ statement: "Mutable edit must not become live" })
      .where(and(eq(t.accuracyClaims.workspace_id, scope.workspace_id), eq(t.accuracyClaims.id, gapVersion.claim_id)));

    await expect(listDownstreamClaims(scope.workspace_id, { claim_type: "gap", limit: null })).rejects.toMatchObject({ code: "approval_required" });
    await accuracyDb().update(t.accuracyClaims).set({ statement: "Approved exact gap" })
      .where(and(eq(t.accuracyClaims.workspace_id, scope.workspace_id), eq(t.accuracyClaims.id, gapVersion.claim_id)));
    const live = await listDownstreamClaims(scope.workspace_id, { claim_type: "gap", limit: null });
    expect(live.map(row => row.statement)).toEqual(["Approved exact gap"]);
    const tacticLive = await listDownstreamClaims(scope.workspace_id, { claim_type: "tactic", limit: null });
    expect(tacticLive[0]?.metadata).toMatchObject({
      evidence_question: "Does this close the gap?",
      gap_ids: [gapVersion.claim_id],
    });
    expect((await listCoveragePairs(scope.workspace_id)).map(pair => [pair.gap.statement, pair.tactic.statement, pair.overall]))
      .toEqual([["Approved exact gap", "Approved exact tactic", "partial"]]);
    const result = await runAccuracyModule<{ survivors: number }>({ call_kind: "merge_dedupe", agent_role: "none", input: { workspace_id: scope.workspace_id },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor });
    expect(result.output.survivors).toBe(2);
  });

  it("pauses immediately after rejection or newer applied publication without falling back", async () => {
    const scope = await fixture();
    const { assembly } = await publishAssembly(scope);
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      expected_review_id: null, decision: "reject", rationale: "Rejected by reviewer.", advisory_overrides: [], reviewer });
    await expect(listDownstreamClaims(scope.workspace_id, { limit: null })).rejects.toMatchObject({ code: "approval_required" });

    const approvedScope = await fixture();
    const { assembly: approved } = await publishAssembly(approvedScope);
    await approve(approvedScope, approved);
    const newer = gap(approvedScope, "Newer unapproved gap");
    const newerRun = await extractionRun(approvedScope, "gap", newer);
    const newerBatch = await createExtractionBatch(approvedScope.workspace_id, approvedScope.source_file_id, ["need_extract"]);
    await applyExtractionBatch(newerBatch, [newerRun], [], async () => {
      await publishGeneratedItemHistory({ ...approvedScope, run_id: newerRun, claim_type: "gap",
        final_claims: [{ id: newer.id, workspace_id: approvedScope.workspace_id, source_file_id: approvedScope.source_file_id, claim_type: "gap", statement: newer.statement }] });
    });
    await expect(listDownstreamClaims(approvedScope.workspace_id, { limit: null })).rejects.toMatchObject({ code: "approval_required" });
  });

  it("rejects explicit ID bypasses while allowing isolated experiments", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    const before = await coverageAssist(new Request("http://localhost/api/accuracy/coverage/assist", { method: "POST",
      body: JSON.stringify({ workspace_id: scope.workspace_id, gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id }) }));
    expect(before.status).toBe(409);

    await approve(scope, assembly);
    const ok = await coverageAssist(new Request("http://localhost/api/accuracy/coverage/assist", { method: "POST",
      body: JSON.stringify({ workspace_id: scope.workspace_id, gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id }) }));
    expect(ok.status).toBe(200);
    await expect(withAssemblyExperiment(() => runAccuracyModule({ call_kind: "merge_dedupe", agent_role: "none", input: { workspace_id: scope.workspace_id },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor, evaluation_context: "experiment" }))).resolves.toMatchObject({ call_kind: "merge_dedupe" });
  });

  it("rejects supplied production payloads that differ from the approved inventory", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "1");
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    await approve(scope, assembly);
    const beforeRuns = await accuracyDb().select().from(t.accuracyModuleRuns)
      .where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.call_kind, "coverage_decide")));

    await expect(runAccuracyModule({ call_kind: "status_derive", agent_role: "none",
      input: { workspace_id: scope.workspace_id, tactics: [{ id: tacticVersion.claim_id, status: "completed" }] },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });
    await expect(runAccuracyModule({ call_kind: "status_derive", agent_role: "none",
      input: { workspace_id: scope.workspace_id, coverages: [{ gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id, overall: "covers", validated: true }] },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });
    await expect(runAccuracyModule({ call_kind: "coverage_decide", agent_role: "proposer",
      input: { workspace_id: scope.workspace_id, gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id, block_bundle_ids: [scope.block_id],
        selected_versions: { gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id,
          gap_payload: { statement: "forged" }, tactic_payload: tacticVersion.payload } },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });
    await expect(runAccuracyModule({ call_kind: "coverage_decide", agent_role: "proposer",
      input: { workspace_id: scope.workspace_id, gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id, block_bundle_ids: [scope.alternate_block_id],
        selected_versions: { gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id,
          gap_payload: gapVersion.payload, tactic_payload: tacticVersion.payload } },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });

    const persistedRuns = await accuracyDb().select().from(t.accuracyModuleRuns)
      .where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.call_kind, "coverage_decide")));
    expect(persistedRuns).toHaveLength(beforeRuns.length);
  });

  it("rejects an unselected Gantt tactic before opening a run", async () => {
    const scope = await fixture();
    const { assembly } = await publishAssembly(scope);
    await approve(scope, assembly);
    await expect(runAccuracyModule({ call_kind: "gantt_project", agent_role: "none",
      input: { workspace_id: scope.workspace_id, tactics: [{ id: "forged", validated: true, start: "2026-01-01", end: "2026-02-01" }] },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });
    const runs = await accuracyDb().select().from(t.accuracyModuleRuns)
      .where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.call_kind, "gantt_project")));
    expect(runs).toEqual([]);
  });

  it.each(["statement", "eligibility", "names"])("rejects forged ideation %s before opening a run", async (field) => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);
    await approve(scope, assembly);
    const row = { id: gapVersion.claim_id, statement: "Approved exact gap", status: "open", priority_band: null as string | null, validated: true };
    if (field === "statement") row.statement = "Forged source question";
    if (field === "eligibility") row.priority_band = "high";
    await expect(runAccuracyModule({ call_kind: "ideate",
      input: { workspace_id: scope.workspace_id, gaps: [row], existing_tactic_names: field === "names" ? [] : ["Approved exact tactic"] },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });
    const runs = await accuracyDb().select().from(t.accuracyModuleRuns)
      .where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.call_kind, "ideate")));
    expect(runs).toEqual([]);
  });

  it.each(["coverages", "tactics"])("rejects empty status %s without changing persisted metadata", async (field) => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope, gap(scope), tactic(scope), "full");
    await approve(scope, assembly);
    const args = { call_kind: "status_derive" as const, agent_role: "none" as const,
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor };
    const valid = await runAccuracyModule<StatusDeriveOutput>({ ...args, input: { workspace_id: scope.workspace_id } });
    expect(valid.output.statuses).toMatchObject([{ computed: "addressed" }]);
    await expect(runAccuracyModule({ ...args, input: { workspace_id: scope.workspace_id, [field]: [] } }))
      .rejects.toMatchObject({ code: "conflict" });
    const [stored] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, gapVersion.claim_id));
    expect(stored.metadata).toMatchObject({ computed_status: "addressed" });
  });

  it.each(["coverages", "tactics"])("rejects partial status %s for full-plus-partial approved evidence", async (field) => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope, gap(scope), tactic(scope), "full", { residual: true });
    await approve(scope, assembly);
    const args = { call_kind: "status_derive" as const, workspace_id: scope.workspace_id, org_id: scope.org_id, actor };
    const valid = await runAccuracyModule<StatusDeriveOutput>({ ...args, input: { workspace_id: scope.workspace_id, gap_ids: [gapVersion.claim_id] } });
    expect(valid.output.statuses).toMatchObject([{ gap_id: gapVersion.claim_id, computed: "addressed" }]);
    const incomplete = field === "coverages"
      ? [{ gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id, overall: "full", validated: true }]
      : [{ id: tacticVersion.claim_id, status: "planned" }];
    await expect(runAccuracyModule({ ...args, input: { workspace_id: scope.workspace_id, gap_ids: [gapVersion.claim_id], [field]: incomplete } }))
      .rejects.toMatchObject({ code: "conflict" });
    expect((await getClaim(scope.workspace_id, gapVersion.claim_id))?.metadata).toMatchObject({ computed_status: "addressed" });
  });

  it("selects gaps while retaining complete evidence and respecting persist false", async () => {
    const scope = await fixture();
    const first = await publishAssembly(scope);
    await approve(scope, first.assembly);
    const source = await insertSourceFile({ workspace_id: scope.workspace_id, filename: "second.txt", mime: "text/plain", checksum: newId("sum") });
    const block_id = newId("block");
    await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id: scope.workspace_id, source_file_id: source.id,
      index: 0, kind: "paragraph", heading: null, text: "Second source supports the selected item.", parser: "test", created_at: nowIso() });
    const secondScope = { ...scope, source_file_id: source.id, block_id };
    const second = await publishAssembly(secondScope, gap(secondScope, "Second gap"), tactic(secondScope, "Second tactic"), "full");
    await approve(secondScope, second.assembly);
    const live = (await approvedLiveInventory(scope.workspace_id))!;
    const input = { workspace_id: scope.workspace_id, gap_ids: [second.gapVersion.claim_id],
      tactics: live.claims.filter(row => row.claim_type === "tactic").map(row => ({ id: row.id, status: "planned" })),
      coverages: live.coverage.map(row => ({ gap_id: row.gap_id, tactic_id: row.tactic_id, overall: row.overall, validated: row.validated })) };
    const args = { call_kind: "status_derive" as const, workspace_id: scope.workspace_id, org_id: scope.org_id, actor };
    const preview = await runAccuracyModule<StatusDeriveOutput>({ ...args, input: { ...input, persist: false } });
    expect(preview.output.statuses).toEqual([{ gap_id: second.gapVersion.claim_id, computed: "addressed", status: "addressed", override: false }]);
    expect((await getClaim(scope.workspace_id, second.gapVersion.claim_id))?.metadata).not.toHaveProperty("computed_status");
    const result = await runAccuracyModule<StatusDeriveOutput>({ ...args, input });
    expect(result.output.statuses).toEqual(preview.output.statuses);
    expect((await getClaim(scope.workspace_id, second.gapVersion.claim_id))?.metadata).toMatchObject({ computed_status: "addressed" });
    expect((await getClaim(scope.workspace_id, first.gapVersion.claim_id))?.metadata).not.toHaveProperty("computed_status");
  });

  it.each(["empty coverage", "empty tactics", "partial coverage", "partial tactics"])("guards direct status module against %s evidence", async (scenario) => {
    registerAccuracyStack();
    const original = activeAccuracyModuleId("status_derive")!;
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope, gap(scope), tactic(scope), "full", { residual: true });
    await approve(scope, assembly);
    const id = newId("direct-status");
    const supplied = scenario.endsWith("coverage")
      ? { coverages: scenario.startsWith("empty") ? [] : [{ gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id, overall: "full", validated: true }] }
      : { tactics: scenario.startsWith("empty") ? [] : [{ id: tacticVersion.claim_id, status: "planned" as const }] };
    const directModule: AccuracyModule<{ workspace_id: string }, StatusDeriveOutput> = {
      manifest: { ...statusDeriveModule.manifest, id },
      inputSchema: z.object({ workspace_id: z.string() }), outputSchema: statusDeriveModule.outputSchema,
      run: (input, ctx) => statusDeriveModule.run({ ...input, ...supplied }, ctx),
    };
    registerAccuracyModule(directModule);
    activateAccuracyModule({ call_kind: "status_derive", module_id: id, activated_by: "direct module boundary" });
    try {
      await expect(runAccuracyModule({ call_kind: "status_derive", input: { workspace_id: scope.workspace_id },
        workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });
      expect((await getClaim(scope.workspace_id, gapVersion.claim_id))?.metadata).not.toHaveProperty("computed_status");
    } finally {
      activateAccuracyModule({ call_kind: "status_derive", module_id: original, activated_by: "restore" });
    }
  });

  it.each(["coverage", "dependencies", "activity dependencies", "gap mapping", "parent gap", "validation", "tactic type"])("rejects altered Gantt %s before opening a run", async (field) => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    await approve(scope, assembly);
    const input: Record<string, unknown> = { workspace_id: scope.workspace_id,
      tactics: [{ id: tacticVersion.claim_id, validated: true, start: "2026-01-01", end: "2026-02-01" }] };
    const row = (input.tactics as Record<string, unknown>[])[0];
    if (field === "coverage") input.coverages = [];
    if (field === "dependencies") row.depends_on = ["forged-tactic"];
    if (field === "activity dependencies") input.activities = [{ tactic_id: tacticVersion.claim_id, depends_on: ["ACT-forged"] }];
    if (field === "gap mapping") row.gap_ids = [];
    if (field === "parent gap") input.gaps = [{ id: gapVersion.claim_id, parent_gap_id: "forged-parent" }];
    if (field === "validation") row.validated = false;
    if (field === "tactic type") row.tactic_type = "rwe_study";
    await expect(runAccuracyModule({ call_kind: "gantt_project", input, workspace_id: scope.workspace_id, org_id: scope.org_id, actor }))
      .rejects.toMatchObject({ code: "conflict" });
    const runs = await accuracyDb().select().from(t.accuracyModuleRuns)
      .where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.call_kind, "gantt_project")));
    expect(runs).toEqual([]);
  });

  it("preserves approved Gantt relationships with scheduling overrides and ideation workflow options", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    await approve(scope, assembly);
    await updateClaimMetadata({ workspace_id: scope.workspace_id, claim_id: gapVersion.claim_id, metadata: { priority_band: "high" } });
    const gantt = await runAccuracyModule<{ activities: Array<{ start: string; gap_ids: string[] }> }>({ call_kind: "gantt_project",
      input: { workspace_id: scope.workspace_id, tactics: [{ id: tacticVersion.claim_id, validated: true, start: "2026-01-01", end: "2026-02-01" }],
        activities: [{ tactic_id: tacticVersion.claim_id, start: "2026-01-10" }] },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor });
    expect(gantt.output.activities).toMatchObject([{ start: "2026-01-10", gap_ids: [gapVersion.claim_id] }]);
    const ideation = await runAccuracyModule<{ eligible_gap_ids: string[] }>({ call_kind: "ideate",
      input: { workspace_id: scope.workspace_id, gaps: [{ id: gapVersion.claim_id, statement: "Approved exact gap", status: "open", priority_band: "high", validated: true }],
        existing_tactic_names: ["Approved exact tactic"], hints: "Prefer low burden research", per_gap: 2 },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor });
    expect(ideation.output.eligible_gap_ids).toEqual([gapVersion.claim_id]);
  });

  it("persists only computed status fields for an approved assembly", async () => {
    registerAccuracyStack();
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    await approve(scope, assembly);

    const [storedGap] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, gapVersion.claim_id));
    const rawMetadata = { ...(storedGap.metadata as Record<string, unknown>), legacy_note: "Keep the raw ledger note" };
    await accuracyDb().update(t.accuracyClaims).set({ metadata: rawMetadata }).where(eq(t.accuracyClaims.id, gapVersion.claim_id));
    const approvedClaims = (await listDownstreamClaims(scope.workspace_id, { limit: null }))
      .map(row => ({ id: row.id, statement: row.statement, source_file_id: row.source_file_id,
        provenance: (row.metadata as Record<string, unknown>).provenance,
        gap_ids: (row.metadata as Record<string, unknown>).gap_ids,
        evidence_question: (row.metadata as Record<string, unknown>).evidence_question }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const approvedPairs = (await listCoveragePairs(scope.workspace_id))
      .map(pair => ({ id: pair.id, gap_id: pair.gap.id, tactic_id: pair.tactic.id,
        overall: pair.overall, rationale: pair.rationale, validated: pair.validated }));
    const [rawGapBefore] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, gapVersion.claim_id));
    const [rawTacticBefore] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, tacticVersion.claim_id));

    const result = await runAccuracyModule<StatusDeriveOutput>({ call_kind: "status_derive", agent_role: "none",
      input: { workspace_id: scope.workspace_id }, workspace_id: scope.workspace_id, org_id: scope.org_id, actor });

    expect(result.output.statuses).toHaveLength(1);
    const [rawGapAfter] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, gapVersion.claim_id));
    const [rawTacticAfter] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, tacticVersion.claim_id));
    expect(rawGapAfter.metadata).toEqual({ ...rawGapBefore.metadata as Record<string, unknown>,
      computed_status: result.output.statuses[0].computed, derived_at: expect.any(String) });
    expect(rawGapAfter.statement).toBe(rawGapBefore.statement);
    expect(rawGapAfter.source_file_id).toBe(rawGapBefore.source_file_id);
    expect(rawTacticAfter).toEqual(rawTacticBefore);
    expect((await listDownstreamClaims(scope.workspace_id, { limit: null }))
      .map(row => ({ id: row.id, statement: row.statement, source_file_id: row.source_file_id,
        provenance: (row.metadata as Record<string, unknown>).provenance,
        gap_ids: (row.metadata as Record<string, unknown>).gap_ids,
        evidence_question: (row.metadata as Record<string, unknown>).evidence_question }))
      .sort((a, b) => a.id.localeCompare(b.id))).toEqual(approvedClaims);
    expect((await listCoveragePairs(scope.workspace_id))
      .map(pair => ({ id: pair.id, gap_id: pair.gap.id, tactic_id: pair.tactic.id,
        overall: pair.overall, rationale: pair.rationale, validated: pair.validated }))).toEqual(approvedPairs);
  });

  it("blocks direct public and store claim insertion for managed heads before approval", async () => {
    const scope = await fixture();
    await publishAssembly(scope);
    const before = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id));

    await expect(insertClaim({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Direct bypass" }))
      .rejects.toMatchObject({ code: "approval_required" });
    await expect(insertClaim({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Trusted caller bypass", trusted: true } as never))
      .rejects.toMatchObject({ code: "approval_required" });
    const response = await claimsPost(new Request("http://localhost/api/accuracy/claims", { method: "POST",
      body: JSON.stringify({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Route bypass" }) }));
    expect(response.status).toBe(409);

    const after = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id));
    expect(after.map(row => row.id).sort()).toEqual(before.map(row => row.id).sort());
  });

  it("rejects unsupported metadata and status mutations on approved members", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    await approve(scope, assembly);

    await expect(updateClaimMetadata({ workspace_id: scope.workspace_id, claim_id: tacticVersion.claim_id,
      metadata: { gap_ids: ["forged-gap"], evidence_question: "Forged question" } }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(persistClaimPatch({ workspace_id: scope.workspace_id, claim_id: gapVersion.claim_id, status: "merged" }))
      .rejects.toMatchObject({ code: "conflict" });

    await expect(updateClaimMetadata({ workspace_id: scope.workspace_id, claim_id: gapVersion.claim_id,
      metadata: { priority_band: "high", priority_rationale: "Workflow triage.", priority_origin: "workshop", priority_scoring: { score: 75, validated: false } } }))
      .resolves.toMatchObject({ id: gapVersion.claim_id });
  });

  it.each(["priority route", "metadata", "patch", "validation"])("serializes direct %s gate and write against publication", async (method) => {
    // The normal test pool has one connection; use real independent requests for this race.
    const client = postgres(process.env.DATABASE_URL!, { max: 8, onnotice: () => {} });
    const shared = globalThis as unknown as { sharedDrizzle: ReturnType<typeof drizzle<typeof legacySchema>> };
    const previous = shared.sharedDrizzle;
    shared.sharedDrizzle = drizzle(client, { schema: legacySchema });
    let unlock!: () => void;
    let locked!: (pid: number) => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<number>(resolve => { locked = resolve; });
    let holder: Promise<unknown> | undefined;
    let mutation: Promise<unknown> | undefined;
    let publication: Promise<unknown> | undefined;
    try {
      const scope = await fixture();
      const { assembly, gapVersion } = await publishAssembly(scope, gap(scope), tactic(scope), method === "priority route" ? "not_relevant" : "partial", method === "priority route" ? { map: false } : undefined);
      await approve(scope, assembly);
      const { loadAccuracyPriorityConfig, readAccuracyPriorityInputs } = await import("@/accuracy/store/priority-store");
      await loadAccuracyPriorityConfig(scope.workspace_id);
      const priorityInputs = method === "priority route" ? await readAccuracyPriorityInputs({ workspace_id: scope.workspace_id, gap_id: gapVersion.claim_id }) : null;
      const nextRun = await extractionRun(scope, "gap", gap(scope, "Same canonical new version", gapVersion.claim_id));
      const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
      holder = client.begin(async tx => {
        const [row] = await tx`select pg_backend_pid() as pid from accuracy_claims where id = ${gapVersion.claim_id} for update`;
        locked(Number(row.pid));
        await held;
      });
      const holderPid = await acquired;
      const args = { workspace_id: scope.workspace_id, claim_id: gapVersion.claim_id };
      mutation = method === "priority route" ? priorityPost(new Request("http://localhost/api/accuracy/claims/priority", {
        method: "POST", body: JSON.stringify({ workspace_id: scope.workspace_id, gap_id: gapVersion.claim_id, action: "set", band: "high", rationale: "Atomic priority", expected_input_revision: priorityInputs!.input_revision, expected_config_revision: priorityInputs!.config_revision }),
      })) : method === "metadata" ? updateClaimMetadata({ ...args, metadata: { priority: "high" } })
        : method === "patch" ? persistClaimPatch({ ...args, metadata: { priority: "high" } })
          : applyClaimValidation({ workspace_id: scope.workspace_id, claim_ids: [gapVersion.claim_id], action: "reject", rationale: "Atomic rejection", actor });
      let writerPid = 0;
      await vi.waitFor(async () => {
        const rows = await client`select pid from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`;
        expect(rows.length).toBeGreaterThan(0);
        writerPid = Number(rows[0].pid);
      }, { timeout: 5000, interval: 10 });
      let published = false;
      publication = applyExtractionBatch(batch, [nextRun], [], async () => {}).then(() => { published = true; });
      // Wait until the competing request either publishes (the bug) or waits behind the writer.
      await vi.waitFor(async () => {
        const rows = await client`select pid from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid))`;
        expect(published || rows.length > 0).toBe(true);
      }, { timeout: 5000, interval: 10 });
      expect(published).toBe(false);
      unlock();
      await holder;
      const result = await mutation;
      if (result instanceof Response) expect(result.status).toBe(200);
      await publication;
      const stored = await getClaim(scope.workspace_id, gapVersion.claim_id);
      if (method === "validation") expect(stored?.status).toBe("rejected");
      else expect(stored?.metadata).toMatchObject({ priority: "high" });
      await expect(updateClaimMetadata({ ...args, metadata: { priority: "low" } })).rejects.toBeInstanceOf(AssemblyReviewError);
      expect((await getClaim(scope.workspace_id, gapVersion.claim_id))?.metadata).toEqual(stored?.metadata);
    } finally {
      unlock?.();
      await Promise.allSettled([holder, mutation, publication].filter(Boolean));
      shared.sharedDrizzle = previous;
      await client.end({ timeout: 5 });
    }
  });

  it("lists all approved inventory pairs with uncaptured cross-source coverage explicitly pending", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope, gap(scope), tactic(scope), "not_relevant", { map: false });
    await approve(scope, assembly);

    const source = await insertSourceFile({ workspace_id: scope.workspace_id, filename: "source-2.txt", mime: "text/plain", checksum: newId("sum") });
    const block_id = newId("block");
    await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id: scope.workspace_id, source_file_id: source.id,
      index: 0, kind: "paragraph", heading: null, text: "Second source text supports the selected item for its own tactic.", parser: "test", created_at: nowIso() });
    const secondScope = { ...scope, source_file_id: source.id, block_id, alternate_block_id: block_id };
    const { assembly: inventoryAssembly, tacticVersion: secondTactic } = await publishInventoryOnlyAssembly(secondScope, tactic(secondScope, "Unrelated approved tactic"));
    await approve(secondScope, inventoryAssembly);

    const pairs = await listCoveragePairs(scope.workspace_id);
    expect(pairs.map(pair => [pair.gap.id, pair.tactic.id, pair.overall])).toEqual([
      [gapVersion.claim_id, tacticVersion.claim_id, "not_relevant"],
      [gapVersion.claim_id, secondTactic.claim_id, "pending"],
    ]);
    expect(pairs.find(pair => pair.tactic.id === secondTactic.claim_id)?.validated).toBe(false);
  });

  it("rolls back module writes when approved heads change during execution", async () => {
    registerAccuracyStack();
    const original = activeAccuracyModuleId("status_derive");
    if (!original) throw new Error("missing status module");
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);
    await approve(scope, assembly);

    const id = newId("mod");
    const testModule: AccuracyModule<{ workspace_id: string }, { statuses: unknown[]; open: number; partial: number; addressed: number }> = {
      manifest: { id, call_kind: "status_derive", version: "test", title: "Race writer", summary: "test", contract: 1, agentic: false },
      inputSchema: z.object({ workspace_id: z.string() }),
      outputSchema: z.object({ statuses: z.array(z.unknown()), open: z.number(), partial: z.number(), addressed: z.number() }),
      run: async () => {
        const newer = gap(scope, "Newer mid-call head");
        const newerRun = await extractionRun(scope, "gap", newer);
        const newerBatch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
        await applyExtractionBatch(newerBatch, [newerRun], [], async () => {
          await publishGeneratedItemHistory({ ...scope, run_id: newerRun, claim_type: "gap",
            final_claims: [{ id: newer.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: newer.statement }] });
        });
        await accuracyDb().update(t.accuracyClaims).set({ metadata: { computed_status: "addressed" } })
          .where(eq(t.accuracyClaims.id, gapVersion.claim_id));
        return { output: { statuses: [], open: 0, partial: 0, addressed: 0 }, summary: "wrote after stale head" };
      },
    };
    registerAccuracyModule(testModule);
    activateAccuracyModule({ call_kind: "status_derive", module_id: id, activated_by: "kan38 race test" });
    try {
      await expect(runAccuracyModule({ call_kind: "status_derive", agent_role: "none", input: { workspace_id: scope.workspace_id },
        workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      activateAccuracyModule({ call_kind: "status_derive", module_id: original, activated_by: "kan38 race restore" });
    }
    const [claim] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, gapVersion.claim_id));
    expect(claim?.metadata).not.toMatchObject({ computed_status: "addressed" });
    const okRuns = await accuracyDb().select().from(t.accuracyModuleRuns)
      .where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.call_kind, "status_derive"), eq(t.accuracyModuleRuns.status, "ok")));
    expect(okRuns).toHaveLength(0);
  });

  it("does not save agentic success output when approved heads change during provider work", async () => {
    registerAccuracyStack();
    const original = activeAccuracyModuleId("coverage_decide");
    if (!original) throw new Error("missing coverage module");
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "1");
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    await approve(scope, assembly);

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const moduleId = newId("mod");
    const testModule: AccuracyModule<Record<string, unknown>, { gap_id: string; tactic_id: string; overall: "partial"; quote_block_ids: string[]; confidence: number; rationale: string }> = {
      manifest: { id: moduleId, call_kind: "coverage_decide", version: "test", title: "Provider wait", summary: "test", contract: 1, agentic: true },
      inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string(), tactic_id: z.string(), block_bundle_ids: z.array(z.string()), selected_versions: z.unknown().optional() }),
      outputSchema: z.object({ gap_id: z.string(), tactic_id: z.string(), overall: z.literal("partial"), quote_block_ids: z.array(z.string()), confidence: z.number(), rationale: z.string() }),
      run: async (input) => {
        entered();
        await releasePromise;
        return { output: { gap_id: String(input.gap_id), tactic_id: String(input.tactic_id), overall: "partial", quote_block_ids: [scope.block_id], confidence: 0.8, rationale: "Provider result." }, summary: "provider completed" };
      },
    };
    registerAccuracyModule(testModule);
    activateAccuracyModule({ call_kind: "coverage_decide", module_id: moduleId, activated_by: "kan38 agentic race test" });
    try {
      const running = runAccuracyModule({ call_kind: "coverage_decide", agent_role: "proposer",
        input: { workspace_id: scope.workspace_id, gap_id: gapVersion.claim_id, tactic_id: tacticVersion.claim_id, block_bundle_ids: [scope.block_id],
          selected_versions: { gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id,
            gap_payload: gapVersion.payload, tactic_payload: tacticVersion.payload } },
        workspace_id: scope.workspace_id, org_id: scope.org_id, actor });
      await enteredPromise;
      const newer = gap(scope, "Newer provider-race head");
      const newerRun = await extractionRun(scope, "gap", newer);
      const newerBatch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
      await applyExtractionBatch(newerBatch, [newerRun], [], async () => {
        await publishGeneratedItemHistory({ ...scope, run_id: newerRun, claim_type: "gap",
          final_claims: [{ id: newer.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: newer.statement }] });
      });
      release();
      await expect(running).rejects.toMatchObject({ code: "conflict" });
    } finally {
      activateAccuracyModule({ call_kind: "coverage_decide", module_id: original, activated_by: "kan38 agentic race restore" });
    }

    const runs = await accuracyDb().select().from(t.accuracyModuleRuns)
      .where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.module_id, moduleId)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "error", output: null });
    const businessRows = await accuracyDb().select().from(t.accuracyCoverageJoins)
      .where(eq(t.accuracyCoverageJoins.workspace_id, scope.workspace_id));
    expect(businessRows).toHaveLength(1);
    expect(businessRows[0].dimensions).toMatchObject({ assembly_fingerprint: assembly.fingerprint });
  });

  it.each(["pending", "approved", "rejected", "missing"])("refuses legacy provider output after the first managed batch becomes %s", async (state) => {
    registerAccuracyStack();
    const original = activeAccuracyModuleId("coverage_decide")!;
    const scope = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const id = newId("legacy-provider");
    registerAccuracyModule({
      manifest: { id, call_kind: "coverage_decide", version: "test", title: "Held provider", summary: "test", contract: 1, agentic: true },
      inputSchema: z.object({ workspace_id: z.string() }), outputSchema: z.object({ answer: z.string() }),
      run: async () => { entered(); await held; return { output: { answer: "legacy evidence" }, summary: "legacy" }; },
    });
    activateAccuracyModule({ call_kind: "coverage_decide", module_id: id, activated_by: "legacy race" });
    const running = runAccuracyModule({ call_kind: "coverage_decide", input: { workspace_id: scope.workspace_id },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor });
    try {
      await enteredPromise;
      const { assembly } = await publishAssembly(scope);
      if (state === "approved") await approve(scope, assembly);
      if (state === "rejected") await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id,
        expected_fingerprint: assembly.fingerprint, expected_review_id: null, decision: "reject", rationale: "Rejected new head", advisory_overrides: [], reviewer });
      if (state === "missing") {
        const run = await extractionRun(scope, "gap", gap(scope, "Unassembled head"));
        const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
        await applyExtractionBatch(batch, [run], [], async () => {});
      }
      release();
      await expect(running).rejects.toBeInstanceOf(AssemblyReviewError);
      const runs = await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.module_id, id));
      expect(runs).toMatchObject([{ status: "error", output: null }]);
    } finally {
      release();
      await running.catch(() => undefined);
      activateAccuracyModule({ call_kind: "coverage_decide", module_id: original, activated_by: "restore" });
    }
  });

  it("rolls back legacy mechanical writes when execution enters managed mode", async () => {
    registerAccuracyStack();
    const original = activeAccuracyModuleId("status_derive")!;
    const scope = await fixture();
    const claim = await insertClaim({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Legacy gap" });
    const id = newId("legacy-mechanical");
    registerAccuracyModule({
      manifest: { id, call_kind: "status_derive", version: "test", title: "Legacy writer", summary: "test", contract: 1, agentic: false },
      inputSchema: z.object({ workspace_id: z.string() }), outputSchema: z.object({ answer: z.string() }),
      run: async () => {
        await updateClaimMetadata({ workspace_id: scope.workspace_id, claim_id: claim.id, metadata: { computed_status: "addressed" } });
        await publishAssembly(scope);
        return { output: { answer: "written" }, summary: "legacy" };
      },
    });
    activateAccuracyModule({ call_kind: "status_derive", module_id: id, activated_by: "legacy race" });
    try {
      await expect(runAccuracyModule({ call_kind: "status_derive", input: { workspace_id: scope.workspace_id },
        workspace_id: scope.workspace_id, org_id: scope.org_id, actor })).rejects.toBeInstanceOf(AssemblyReviewError);
      const [stored] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, claim.id));
      expect(stored.metadata).not.toHaveProperty("computed_status");
      const batches = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.workspace_id, scope.workspace_id));
      expect(batches).toEqual([]);
      const runs = await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.module_id, id));
      expect(runs).toMatchObject([{ status: "error", output: null }]);
    } finally {
      activateAccuracyModule({ call_kind: "status_derive", module_id: original, activated_by: "restore" });
    }
  });

  it("allows automatic version-bound generation before human approval", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "1");
    const scope = await fixture();
    const { gapVersion, tacticVersion } = await publishAssembly(scope);

    await expect(withAssemblyPreparation(() => runAccuracyModule({ call_kind: "coverage_decide", agent_role: "proposer",
      input: { workspace_id: scope.workspace_id, gap_id: gapVersion.id, tactic_id: tacticVersion.id, block_bundle_ids: [scope.block_id],
        selected_versions: { gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id,
          gap_payload: gapVersion.payload, tactic_payload: tacticVersion.payload } },
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor }))).resolves.toMatchObject({ call_kind: "coverage_decide" });
  });

  it("rejects stale workshop snapshots when new approved bindings keep the same canonical IDs", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope, gap(scope), tactic(scope), "full");
    await approve(scope, assembly);
    const snapshot = await createWorkshopSnapshot({ workspace_id: scope.workspace_id, actor, note: "Ready room" });

    const gapV2 = gap(scope, "Updated exact gap", gapVersion.claim_id);
    const tacticV2 = tactic(scope, "Updated exact tactic", tacticVersion.claim_id);
    const gapRun2 = await extractionRun(scope, "gap", gapV2);
    const tacticRun2 = await extractionRun(scope, "tactic", tacticV2);
    const batch2 = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract", "inventory_extract"]);
    await applyExtractionBatch(batch2, [gapRun2, tacticRun2], [], async () => {
      await accuracyDb().insert(t.accuracyItemVersions).values({ id: newId("iver"), workspace_id: scope.workspace_id,
        claim_id: gapVersion.claim_id, run_id: gapRun2, snapshot_id: null, iteration: null, item_index: 0,
        origin_key: newId("origin"), claim_type: "gap", fingerprint: newId("fp"), payload: gapV2,
        source_file_id: scope.source_file_id, created_at: nowIso() });
      await accuracyDb().insert(t.accuracyItemVersions).values({ id: newId("iver"), workspace_id: scope.workspace_id,
        claim_id: tacticVersion.claim_id, run_id: tacticRun2, snapshot_id: null, iteration: null, item_index: 0,
        origin_key: newId("origin"), claim_type: "tactic", fingerprint: newId("fp"), payload: tacticV2,
        source_file_id: scope.source_file_id, created_at: nowIso() });
    });
    const newVersions = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.run_id, gapRun2)));
    const [newGapVersion] = newVersions;
    const [newTacticVersion] = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.run_id, tacticRun2)));
    const newCoverage = await coverageRun(scope, newGapVersion.id, newTacticVersion.id, newGapVersion.payload, newTacticVersion.payload, "full");
    const newAssembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [
        { item_version_id: newGapVersion.id, reason: "same canonical changed gap" },
        { item_version_id: newTacticVersion.id, reason: "same canonical changed tactic" },
      ],
      mappings: [{ gap_version_id: newGapVersion.id, tactic_version_id: newTacticVersion.id }], coverage_run_ids: [newCoverage],
      extraction_runs: [
        { call_kind: "need_extract", run_id: gapRun2, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
        { call_kind: "inventory_extract", run_id: tacticRun2, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: batch2.id });
    await approve(scope, newAssembly);

    await expect(addFacilitatorTag({ workspace_id: scope.workspace_id, snapshot_id: snapshot.id, label: "HEOR" }))
      .rejects.toMatchObject({ code: "conflict" });
  });
});

describe("assembly review API", () => {
  it("derives reviewer identity from the authenticated session and exposes state metadata", async () => {
    const scope = await fixture();
    const { assembly } = await publishAssembly(scope);
    session();
    const response = await reviewPost({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      decision: "approve", rationale: "Approved through API.", advisory_overrides: [], expected_review_id: null });
    expect(response.status).toBe(200);
    const json = await response.json() as { review: { reviewer_subject: string; reviewer_actor_name: string }; state: { status: string; expected_review_id: string; latest_decision: { id: string } } };
    expect(json.review).toMatchObject({ reviewer_subject: reviewer.subject, reviewer_actor_name: reviewer.actor.name });
    expect(json.state.status).toBe("approved");
    expect(json.state.expected_review_id).toBe(json.state.latest_decision.id);

    const detail = await assembliesGet(new Request(`http://localhost/api/accuracy/assemblies?workspace_id=${scope.workspace_id}&assembly_id=${assembly.id}`));
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      assembly: { id: assembly.id },
      review_state: { status: "approved", expected_review_id: json.state.latest_decision.id, latest_decision: { id: json.state.latest_decision.id } },
      can_review: true,
    });
  });

  it("enforces strict body, workspace grants, reviewer role, and expected review id", async () => {
    const scope = await fixture();
    const { assembly } = await publishAssembly(scope);

    session("viewer");
    expect((await reviewPost({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      decision: "approve", rationale: "Viewer cannot approve.", advisory_overrides: [], expected_review_id: null })).status).toBe(403);

    session(reviewer.role, "foreign-subject");
    expect((await reviewPost({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      decision: "approve", rationale: "Foreign tenant.", advisory_overrides: [], expected_review_id: null })).status).toBe(404);

    session();
    expect((await reviewPost({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      decision: "approve", rationale: "Extra field.", advisory_overrides: [], expected_review_id: null, client_reviewer_subject: "spoof" })).status).toBe(400);
    const first = await reviewPost({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      decision: "approve", rationale: "Approved once.", advisory_overrides: [], expected_review_id: null });
    expect(first.status).toBe(200);
    const stale = await reviewPost({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      decision: "reject", rationale: "Competing stale decision.", advisory_overrides: [], expected_review_id: null });
    expect(stale.status).toBe(409);
  });
});

describe("miss-flag review API claim promotion boundary", () => {
  const promoteBody = (scope: Fixture) => ({
    workspace_id: scope.workspace_id,
    block_id: scope.block_id,
    action: "promote",
    suggested: "gap",
    rationale: "Promote only through an authorized review workflow.",
  });

  it("requires authenticated granted access before reading or promoting miss flags", async () => {
    const scope = await fixture();
    const before = await claimIds(scope.workspace_id);
    sessionContext.mockResolvedValue({ signed_in: false, demo: false, role: "viewer", actor: reviewer.actor, session: null });

    const read = await missFlagGet(new Request(`http://localhost/api/accuracy/review?workspace_id=${scope.workspace_id}`));
    expect(read.status).toBe(403);
    expect((await promoteMissFlag(promoteBody(scope))).status).toBe(403);
    expect(await claimIds(scope.workspace_id)).toEqual(before);

    session("contributor", "foreign-subject");
    expect((await promoteMissFlag(promoteBody(scope))).status).toBe(404);
    expect(await claimIds(scope.workspace_id)).toEqual(before);

    session("viewer");
    expect((await promoteMissFlag(promoteBody(scope))).status).toBe(403);
    expect(await claimIds(scope.workspace_id)).toEqual(before);
  });

  it("preserves authorized unmanaged promotion and derives actor from the session", async () => {
    const scope = await fixture();
    session("contributor");

    const response = await promoteMissFlag({
      ...promoteBody(scope),
      actor_name: "spoofed-client",
      actor_function: "heor",
    });

    expect(response.status).toBe(400);
    const ok = await promoteMissFlag(promoteBody(scope));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { claim_id: string };
    expect(body.claim_id).toEqual(expect.any(String));
    const [action] = await accuracyDb().select().from(t.accuracyMissFlagActions)
      .where(eq(t.accuracyMissFlagActions.claim_id, body.claim_id));
    expect(action).toMatchObject({ actor_name: reviewer.actor.name, actor_function: reviewer.actor.function });
  });

  it.each([
    ["unapproved", async (scope: Fixture) => { await publishAssembly(scope); }],
    ["rejected", async (scope: Fixture) => {
      const { assembly } = await publishAssembly(scope);
      await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
        expected_review_id: null, decision: "reject", rationale: "Reject this proposal.", advisory_overrides: [], reviewer });
    }],
  ])("refuses %s managed promotion before insert and records no miss-flag action", async (_label, prepare) => {
    const scope = await fixture();
    await prepare(scope);
    session("contributor");
    const before = await claimIds(scope.workspace_id);

    const response = await promoteMissFlag(promoteBody(scope));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "approval_required" });
    expect(await claimIds(scope.workspace_id)).toEqual(before);
    const actions = await accuracyDb().select().from(t.accuracyMissFlagActions)
      .where(eq(t.accuracyMissFlagActions.workspace_id, scope.workspace_id));
    expect(actions).toEqual([]);
  });

  it("refuses approved managed new content as a revision-required conflict before insert", async () => {
    const scope = await fixture();
    const { assembly } = await publishAssembly(scope);
    await approve(scope, assembly);
    session("medical_affairs");
    const before = await claimIds(scope.workspace_id);

    const response = await promoteMissFlag(promoteBody(scope));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "approval_required",
      error: expect.stringMatching(/revised approved assembly/i),
    });
    expect(await claimIds(scope.workspace_id)).toEqual(before);
    const actions = await accuracyDb().select().from(t.accuracyMissFlagActions)
      .where(eq(t.accuracyMissFlagActions.workspace_id, scope.workspace_id));
    expect(actions).toEqual([]);
  });
});
