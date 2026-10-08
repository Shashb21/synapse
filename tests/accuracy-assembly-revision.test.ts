import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createAssembly, readAssembly } from "@/accuracy/store/assembly-store";
import { approvedLiveInventory, assemblyReviewState, reviewAssembly } from "@/accuracy/store/assembly-review-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { applyExtractionBatch, createExtractionBatch } from "@/accuracy/store/extraction-batch-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import * as t from "@/accuracy/store/schema";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace, deleteWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Role } from "@/modules/auth/roles";
import { GET as coverageGet, POST as coveragePost } from "@/app/api/accuracy/coverage/route";
import { POST as assembliesPost } from "@/app/api/accuracy/assemblies/route";
import { runAccuracyModule, registerAccuracyStack } from "@/accuracy";
import { activateAccuracyModule, activeAccuracyModuleId, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { agenticModule, mechanicalModule } from "@/accuracy/modules/_factory";
import { accuracyTransactionActive } from "@/accuracy/store/db";
import { revalidateApprovedLiveBindings } from "@/accuracy/store/assembly-review-store";
import { assemblyRevisionState } from "@/accuracy/store/assembly-revision-store";
import { listDownstreamClaims } from "@/accuracy/store/claim-store";
import { z } from "zod";
import { createAssemblyRevision, retryAssemblyRevision } from "@/accuracy/kernel/assembly-revision";
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
const originals = new Map<string, string>();
beforeAll(() => registerAccuracyStack());

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

async function publishNeedOnlyAssembly(scope: Fixture, gapPayload = gap(scope)) {
  const gapRun = await extractionRun(scope, "gap", gapPayload);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
  const created: string[] = [];
  await applyExtractionBatch(batch, [gapRun], created, async () => {
    created.push(...(await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: gapPayload.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id,
        claim_type: "gap", statement: gapPayload.statement }] })).claim_ids);
  });
  const [gapVersion] = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.run_id, gapRun)));
  const assembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
    selections: [{ item_version_id: gapVersion!.id, reason: "need head" }], mappings: [], coverage_run_ids: [],
    extraction_runs: [{ call_kind: "need_extract", run_id: gapRun, source_file_id: scope.source_file_id,
      item_count: 1, outcome: "items", evaluation_context: "production" }],
    linking_complete: true, generation_key: batch.id });
  return { assembly, gapVersion: gapVersion! };
}

async function approve(scope: Fixture, assembly: Awaited<ReturnType<typeof createAssembly>>) {
  return reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
    expected_review_id: null, decision: "approve", rationale: "Approved for exact live consumption.", advisory_overrides: [], reviewer });
}

function session(role: Role = reviewer.role, subject = reviewer.subject) {
  sessionContext.mockResolvedValue({ signed_in: true, demo: false, role, actor: reviewer.actor,
    session: { subject, provider_id: reviewer.provider, actor: reviewer.actor, role } });
}

async function reviewPost(body: Record<string, unknown>) {
  return assembliesPost(new Request("http://localhost/api/accuracy/assemblies", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [call_kind, module_id] of originals) activateAccuracyModule({ call_kind: call_kind as never, module_id, activated_by: "restore" });
  originals.clear();
  for (const id of workspaces.splice(0)) await deleteWorkspace(id);
});


function installCoverage(overall: "partial" | "not_relevant" = "partial", options?: { agentic?: boolean; failFirst?: boolean; failAttempt?: number; before?: () => Promise<void> }) {
  const call_kind = "coverage_decide";
  const original = activeAccuracyModuleId(call_kind);
  if (original) originals.set(call_kind, original);
  const id = newId("coverage-module");
  let attempts = 0;
  registerAccuracyModule((options?.agentic ? agenticModule : mechanicalModule)({ id, call_kind, title: "Generated coverage", summary: "Generated coverage",
    inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string(), tactic_id: z.string(), block_bundle_ids: z.array(z.string()),
      selected_versions: z.object({ gap_version_id: z.string(), tactic_version_id: z.string(),
        gap_payload: z.record(z.string(), z.unknown()), tactic_payload: z.record(z.string(), z.unknown()) }).optional() }),
    outputSchema: z.object({ gap_id: z.string(), tactic_id: z.string(), overall: z.enum(["full", "partial", "limited", "not_relevant"]),
      quote_block_ids: z.array(z.string()), confidence: z.number(), rationale: z.string() }),
    run: async input => {
      attempts += 1;
      expect(accuracyTransactionActive()).toBe(false);
      await options?.before?.();
      if ((options?.failFirst && attempts === 1) || options?.failAttempt === attempts) throw new Error("transient coverage failure");
      return { output: { gap_id: input.gap_id, tactic_id: input.tactic_id, overall,
        quote_block_ids: overall === "not_relevant" ? [] : input.block_bundle_ids, confidence: 0.8, rationale: "Generated pairwise decision" },
        summary: "Generated coverage" };
    } }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "assembly generation test" });
  return () => attempts;
}

function humanGap(scope: Fixture, statement: string, external_id?: string) {
  const generated = gap(scope, statement, external_id);
  return { statement: generated.statement, external_id: generated.external_id, provenance: generated.provenance };
}
const author = { ...reviewer, role: "contributor" as const };
function revisionArgs(scope: Fixture, assembly: Awaited<ReturnType<typeof createAssembly>>) {
  return { workspace_id: scope.workspace_id, org_id: scope.org_id, parent_assembly_id: assembly.id,
    expected_fingerprint: assembly.fingerprint, expected_head_id: assembly.id, author };
}
describe("KAN-39 immutable human revisions", () => {
  it("removes with reason and lineage, preserves baseline, and requires fresh approval", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    await approve(scope, assembly);
    const result = await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: {
      action: "remove", item_version_id: gapVersion.id, reason: "Unsupported need removed after source review." } });
    expect(result.assembly.items.map(item => item.id)).toEqual([tacticVersion.id]);
    expect(result.revision).toMatchObject({ action: "remove", predecessor_version_id: gapVersion.id, parent_assembly_id: assembly.id });
    expect(await readAssembly(scope.workspace_id, assembly.id)).toEqual(assembly);
    await expect(approve(scope, assembly)).rejects.toMatchObject({ code: "conflict" });
    await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
    await approve(scope, result.assembly);
    expect((await approvedLiveInventory(scope.workspace_id))?.claims.map(item => item.claim_type)).toEqual(["tactic"]);
  });
  it("rejects blank reasons, missing selected IDs, and stale competing parents atomically", async () => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);
    for (const change of [ { action: "remove" as const, item_version_id: gapVersion.id, reason: " " },
      { action: "remove" as const, item_version_id: "other-workspace-version", reason: "Remove wrong selection" } ]) {
      await expect(createAssemblyRevision({ ...revisionArgs(scope, assembly), change })).rejects.toMatchObject({ code: change.reason.trim() ? "not_found" : "invalid_input" });
    }
    await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "remove", item_version_id: gapVersion.id, reason: "Reviewed deletion" } });
    await expect(createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "remove", item_version_id: gapVersion.id, reason: "Competing deletion" } })).rejects.toMatchObject({ code: "conflict" });
    expect((await assemblyReviewState(scope.workspace_id, assembly.id)).status).toBe("stale");
  });
  it("adds explicit human history and edits cumulatively with exact unaffected coverage", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    const attempts = installCoverage();
    const newGap = humanGap(scope, "Missing human need", "human-external");
    const added = await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: {
      action: "add", reason: "This source-backed need was missed.", content: { claim_type: "gap", source_file_id: scope.source_file_id, payload: newGap } } });
    expect(attempts()).toBe(1);
    expect(added.assembly.coverage.find(pair => pair.gap_version_id === gapVersion.id)).toEqual(assembly.coverage[0]);
    const human = added.assembly.items.find(item => item.human_origin)!;
    expect(human).toMatchObject({ run_id: null, snapshot_id: null, human_origin: { kind: "human", action: "add", subject: author.subject, provider: author.provider } });
    expect(added.assembly.items.find(item => item.id === tacticVersion.id)).toEqual(assembly.items.find(item => item.id === tacticVersion.id));
    const edited = await createAssemblyRevision({ ...revisionArgs(scope, added.assembly), change: { action: "edit", item_version_id: human.id,
      reason: "Clarify the clinical wording", content: { claim_type: "gap", source_file_id: scope.source_file_id, payload: { ...newGap, statement: "Clarified human need" } } } });
    const replacement = edited.assembly.items.find(item => item.payload.statement === "Clarified human need")!;
    expect(replacement.canonical_claim_id).toBe(human.canonical_claim_id);
    expect(replacement.human_origin?.predecessor_version_id).toBe(human.id);
    expect(attempts()).toBe(2);
    expect(edited.assembly.coverage.some(pair => pair.gap_version_id === human.id)).toBe(false);
    await approve(scope, edited.assembly);
    const live = await approvedLiveInventory(scope.workspace_id);
    expect(live?.claims.map(item => item.statement)).toContain("Clarified human need");
    expect(live?.selected_items.filter(item => item.claim_id === human.canonical_claim_id)).toHaveLength(1);
    const removed = await createAssemblyRevision({ ...revisionArgs(scope, edited.assembly), change: { action: "remove", item_version_id: replacement.id, reason: "Removed after final review" } });
    await expect(revalidateApprovedLiveBindings(scope.workspace_id, live!.bindings)).rejects.toMatchObject({ code: "conflict" });
    await approve(scope, removed.assembly);
    expect((await approvedLiveInventory(scope.workspace_id))?.claims.map(item => item.statement)).not.toContain("Clarified human need");
    expect(await readAssembly(scope.workspace_id, assembly.id)).toEqual(assembly);
  });

  it("durably saves incomplete linking and retries only missing successful pairs", async () => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope, gap(scope), tactic(scope), "partial", { residual: true });
    const attempts = installCoverage("partial", { failAttempt: 2 });
    const payload = humanGap(scope, "Edited source-backed need");
    const saved = await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "edit", item_version_id: gapVersion.id,
      reason: "Update after source check", content: { claim_type: "gap", source_file_id: scope.source_file_id, payload } } });
    expect(saved.assembly.linking_complete).toBe(false);
    expect(saved.assembly.coverage).toHaveLength(1);
    expect(saved.review_state.checks.status).toBe("blocked");
    expect((await assemblyRevisionState(scope.workspace_id, saved.assembly.id)).can_retry).toBe(true);
    await expect(approve(scope, saved.assembly)).rejects.toMatchObject({ code: "approval_required" });
    const retried = await retryAssemblyRevision({ ...revisionArgs(scope, saved.assembly), assembly_id: saved.assembly.id });
    expect(attempts()).toBe(3);
    expect(retried.revision.id).toBe(saved.revision.id);
    expect(retried.assembly.linking_complete).toBe(true);
    expect(retried.assembly.coverage).toHaveLength(2);
    expect(retried.assembly.coverage[0]).toEqual(saved.assembly.coverage[0]);
    expect(await readAssembly(scope.workspace_id, saved.assembly.id)).toEqual(saved.assembly);
    await approve(scope, retried.assembly);
    expect((await approvedLiveInventory(scope.workspace_id))?.claims.map(item => item.statement)).toContain("Edited source-backed need");
  });

  it("projects opposite-kind additions on a one-kind source batch after fresh approval", async () => {
    const scope = await fixture();
    const { assembly } = await publishInventoryOnlyAssembly(scope);
    installCoverage();
    const payload = humanGap(scope, "Human gap for tactic-only proposal");
    const result = await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "add", reason: "Missing need grounded in this source",
      content: { claim_type: "gap", source_file_id: scope.source_file_id, payload } } });
    await expect(listDownstreamClaims(scope.workspace_id, { limit: null })).rejects.toMatchObject({ code: "approval_required" });
    await approve(scope, result.assembly);
    expect((await listDownstreamClaims(scope.workspace_id, { limit: null })).map(item => item.statement)).toContain("Human gap for tactic-only proposal");
    expect((await approvedLiveInventory(scope.workspace_id))?.coverage).toHaveLength(1);
  });

  it.each(["update", "reject", "split"])("uses the approved inventory-only owner for a human gap: %s", async action => {
    const scope = await fixture();
    const { assembly } = await publishInventoryOnlyAssembly(scope);
    installCoverage();
    const added = await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "add", reason: "Missing source-backed need",
      content: { claim_type: "gap", source_file_id: scope.source_file_id, payload: humanGap(scope, "Human gap owned by inventory") } } });
    await approve(scope, added.assembly);
    const live = (await approvedLiveInventory(scope.workspace_id))!;
    expect(live.bindings.map(binding => binding.call_kind)).toEqual(["inventory_extract"]);
    const gap_id = live.claims.find(claim => claim.claim_type === "gap")!.id;
    const tactic_id = live.claims.find(claim => claim.claim_type === "tactic")!.id;
    const { coveragePairRevisions, upsertCoverageDecision, rejectCoveragePair } = await import("@/accuracy/store/coverage-store");
    const { getClaim } = await import("@/accuracy/store/claim-store");
    const before = await getClaim(scope.workspace_id, gap_id);
    let candidateId: string;
    if (action === "split") {
      const { readAccuracySplitInputs, applyAccuracySplit, listAccuracySplitOperations } = await import("@/accuracy/store/partial-split-store");
      const state = await readAccuracySplitInputs({ workspace_id: scope.workspace_id, gap_id });
      const request = { workspace_id: scope.workspace_id, operation_key: newId("split-key"), actor: author.actor, author,
        rationale: "Confirmed source-backed split", proposal: { workspace_id: scope.workspace_id, parent_gap_id: gap_id,
          ...state.revisions, confirmed: true, addressed_name: "Addressed portion", addressed_statement: "Supported source portion",
          open_name: "Residual need", open_statement: "Remaining source question", addressed_tactic_ids: [tactic_id],
          uncovered_dimensions: ["population" as const], addressed_evidence: state.evidence, open_evidence: [], confidence: 100,
          rationale: ["Human confirmed exact portions"] } };
      const candidate = await applyAccuracySplit(request);
      expect(candidate).toMatchObject({ state: "awaiting_approval" });
      expect(await applyAccuracySplit(request)).toEqual(candidate);
      expect(await listAccuracySplitOperations(scope.workspace_id)).toHaveLength(1);
      expect(await getClaim(scope.workspace_id, gap_id)).toEqual(before);
      await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
      candidateId = candidate.assembly_id!;
      const detail = await assemblyReviewState(scope.workspace_id, candidateId);
      await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: candidateId, expected_fingerprint: detail.fingerprint,
        decision: "approve", rationale: "Reviewed split and pending residual", reviewer,
        advisory_overrides: detail.advisories.map(f => ({ code: f.code, item_version_ids: f.item_version_ids, reason: "Residual remains pending" })) });
      const after = (await approvedLiveInventory(scope.workspace_id))!;
      expect(after.claims.map(claim => claim.id)).toEqual(expect.arrayContaining([candidate.addressed_gap_id, candidate.open_residual_gap_id]));
      expect(after.claims.map(claim => claim.id)).not.toContain(gap_id);
      expect(after.coverage.find(pair => pair.gap_id === candidate.open_residual_gap_id)).toMatchObject({ overall: "pending", validated: false });
      expect((await listAccuracySplitOperations(scope.workspace_id))[0].state).toBe("applied");
    } else {
      const args = { workspace_id: scope.workspace_id, gap_id, tactic_id, actor: author.actor, author,
        ...await coveragePairRevisions({ workspace_id: scope.workspace_id, gap_id, tactic_id }), rationale: "Human reviewed coverage" };
      const candidate = action === "reject" ? await rejectCoveragePair(args)
        : await upsertCoverageDecision({ ...args, overall: "limited", evidence: [scope.block_id] });
      expect(candidate).toMatchObject({ awaiting_approval: true, validated: false });
      candidateId = candidate.assembly_id!;
      expect(await getClaim(scope.workspace_id, gap_id)).toEqual(before);
      await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
      const detail = await assemblyReviewState(scope.workspace_id, candidateId);
      await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: candidateId, expected_fingerprint: detail.fingerprint,
        decision: "approve", rationale: "Reviewed exact coverage successor", reviewer,
        advisory_overrides: detail.advisories.map(f => ({ code: f.code, item_version_ids: f.item_version_ids, reason: "Pending remains pending" })) });
      expect((await approvedLiveInventory(scope.workspace_id))!.coverage[0]).toMatchObject({ overall: action === "reject" ? "pending" : "limited", validated: action !== "reject" });
    }
    expect((await readAssembly(scope.workspace_id, candidateId))!.items.length).toBe(action === "split" ? 3 : 2);
    expect(await readAssembly(scope.workspace_id, added.assembly.id)).toEqual(added.assembly);
  });

  it("retains managed cross-source assessments and failures without publishing and resumes pages", async () => {
    const scope = await fixture();
    const first = await publishAssembly(scope);
    await approve(scope, first.assembly);
    const source = await insertSourceFile({ workspace_id: scope.workspace_id, filename: "second.txt", mime: "text/plain", checksum: newId("sum") });
    const block_id = newId("block");
    await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id: scope.workspace_id, source_file_id: source.id,
      index: 0, kind: "paragraph", heading: null, text: "Second source supports the selected item.", parser: "test", created_at: nowIso() });
    const other = { ...scope, source_file_id: source.id, block_id };
    const second = await publishAssembly(other, gap(other, "Independent source need"), tactic(other, "Independent inventory tactic"));
    await approve(scope, second.assembly);
    const { assessCoveragePage, listCoveragePage, listCoverageJoins, upsertCoverageDecision } = await import("@/accuracy/store/coverage-store");
    const { coverageFactsForPair } = await import("@/accuracy/store/coverage-store");
    const { blockBundleIdsForPair } = await import("@/accuracy/store/coverage-queue");
    const before = await approvedLiveInventory(scope.workspace_id);
    const attempts = installCoverage("partial", { failFirst: true, agentic: true });
    const assess = async (pair: import("@/accuracy/store/coverage-store").CoveragePair) => {
      const result = await runAccuracyModule<import("@/accuracy/modules/coverage-decide/schema").CoverageDecision>({
        call_kind: "coverage_decide", agent_role: "judge", workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
        input: { workspace_id: scope.workspace_id, gap_id: pair.gap.id, tactic_id: pair.tactic.id,
          block_bundle_ids: blockBundleIdsForPair(pair.gap, pair.tactic), facts: coverageFactsForPair(pair) } });
      return { overall: result.output.overall, rationale: result.output.rationale, evidence: result.output.quote_block_ids, run_id: result.run_id };
    };
    vi.stubEnv("OWNER_EMAILS", "reviewer@example.test");
    sessionContext.mockResolvedValue({ signed_in: true, demo: false, role: "contributor", actor: author.actor,
      session: { subject: author.subject, provider_id: author.provider, email: "reviewer@example.test", actor: author.actor, role: "contributor" } });
    const response = await coveragePost(new Request("http://localhost/api/accuracy/coverage", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "assess", workspace_id: scope.workspace_id }) }));
    expect(response.status).toBe(200);
    const apiPage = await response.json();
    const page = { ...await listCoveragePage({ workspace_id: scope.workspace_id }), attempts: apiPage.attempts };
    const readResponse = await coverageGet(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${scope.workspace_id}`));
    expect(readResponse.status).toBe(200);
    expect((await readResponse.json()).pairs.find((pair: { suggestion?: unknown }) => pair.suggestion)).toMatchObject({ overall: "pending", validated: false, suggestion: { overall: "partial" } });
    expect(page.attempts).toHaveLength(2);
    expect(page.attempts[0].error).toContain("transient coverage failure");
    expect(page.attempts[1].error).toBeUndefined();
    expect(attempts()).toBe(2);
    expect(page.progress).toMatchObject({ eligible_total: 4, assessed: 3, validated: 2, failed: 1, pending: 1 });
    const suggested = page.pairs.find(pair => pair.assessment_state === "successful" && !pair.validated)!;
    expect(suggested).toMatchObject({ overall: "pending", validated: false,
      suggestion: { overall: "partial", rationale: "Generated pairwise decision", freshness: "current" } });
    expect(page.pairs.find(pair => pair.assessment_state === "failed")).toMatchObject({ overall: "pending", validated: false });
    expect(await approvedLiveInventory(scope.workspace_id)).toEqual(before);
    expect(await listCoverageJoins(scope.workspace_id)).toEqual(before!.coverage);
    let cursor: string | undefined;
    do {
      const resumed = await assessCoveragePage({ workspace_id: scope.workspace_id, page_size: 1, cursor, assess });
      cursor = resumed.next_cursor ?? undefined;
    } while (cursor);
    expect(attempts()).toBe(3);
    expect((await listCoveragePage({ workspace_id: scope.workspace_id })).progress).toMatchObject({ assessed: 4, validated: 2, failed: 0, assessment_complete: true, validation_complete: false });
    expect((await assessCoveragePage({ workspace_id: scope.workspace_id, assess })).attempts).toEqual([]);
    expect(attempts()).toBe(3);
    expect(await approvedLiveInventory(scope.workspace_id)).toEqual(before);
    const { copyExperimentWorkspace } = await import("@/accuracy/experiments/copy-workspace");
    const copy = await copyExperimentWorkspace({ source_workspace_id: scope.workspace_id, source_file_ids: [scope.source_file_id, other.source_file_id] });
    workspaces.unshift(copy.workspace_id);
    const archive = (copy.baseline_snapshot as unknown as { managed_history: import("@/accuracy/experiments/baseline-history").ManagedBaselineHistory }).managed_history;
    expect(archive.authority).toBe("audit_only");
    const suggestions = archive.coverage_audit.filter(row => (row.dimensions as Record<string, unknown>).managed_assessment === true);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every(row => !row.validated)).toBe(true);
    for (const row of suggestions) {
      expect(archive.runs.map(run => run.id)).toContain((row.dimensions as Record<string, unknown>).run_id);
      expect(row.workspace_id).toBe(copy.workspace_id);
    }
    expect(JSON.stringify(suggestions)).toContain("transient coverage failure");
    expect(await approvedLiveInventory(copy.workspace_id)).toBeNull();
    expect(await approvedLiveInventory(scope.workspace_id)).toEqual(before);
    // A reasoned human successor and its exact fresh approval are still required.
    const candidate = await upsertCoverageDecision({ workspace_id: scope.workspace_id, gap_id: suggested.gap.id, tactic_id: suggested.tactic.id,
      expected_gap_revision: suggested.gap_revision, expected_tactic_revision: suggested.tactic_revision,
      overall: "limited", rationale: "Human reviewed the suggestion conservatively", evidence: blockBundleIdsForPair(suggested.gap, suggested.tactic), actor: author.actor, author });
    expect(candidate).toMatchObject({ awaiting_approval: true, validated: false });
    await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
    const detail = await assemblyReviewState(scope.workspace_id, candidate.assembly_id!);
    await reviewAssembly({ workspace_id: scope.workspace_id, assembly_id: candidate.assembly_id!, expected_fingerprint: detail.fingerprint,
      decision: "approve", rationale: "Reviewed successor with pending cross-source work", reviewer,
      advisory_overrides: detail.advisories.map(f => ({ code: f.code, item_version_ids: f.item_version_ids, reason: "Unreviewed pair stays pending" })) });
    const after = (await approvedLiveInventory(scope.workspace_id))!;
    expect(after.coverage.find(pair => pair.gap_id === suggested.gap.id && pair.tactic_id === suggested.tactic.id)).toMatchObject({ overall: "limited", validated: true });
    expect(after.coverage.filter(pair => pair.overall === "pending")).toHaveLength(1);
    expect((await assessCoveragePage({ workspace_id: scope.workspace_id, assess })).attempts).toEqual([]);
  });

  it("invalidates in-flight linking when a newer extraction publishes", async () => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);
    let published = false;
    installCoverage("partial", { before: async () => { if (!published) { published = true; await publishAssembly(scope, gap(scope, "New extraction head")); } } });
    const payload = humanGap(scope, "Stale human correction");
    await expect(createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "edit", item_version_id: gapVersion.id,
      reason: "Edit while newer extraction runs", content: { claim_type: "gap", source_file_id: scope.source_file_id, payload } } })).rejects.toMatchObject({ code: "conflict" });
    expect((await assemblyReviewState(scope.workspace_id, assembly.id)).head_status).toBe("stale");
    await expect(approvedLiveInventory(scope.workspace_id)).rejects.toMatchObject({ code: "approval_required" });
  });

  it("rejects malformed payloads and source quotes without leaving versions or changes", async () => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);
    const payload = humanGap(scope, "A proposed revision");
    const before = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id));
    for (const content of [ { claim_type: "gap", source_file_id: scope.source_file_id, payload: { ...payload, statement: " " } },
      { claim_type: "gap", source_file_id: scope.source_file_id, payload: { ...payload, provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "Invented quote" }] } },
      { claim_type: "gap", source_file_id: "other-source", payload },
      { claim_type: "gap", source_file_id: scope.source_file_id, payload: { ...payload, actor: "spoofed" } } ]) {
      await expect(createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "edit", item_version_id: gapVersion.id, reason: "Source correction", content } as never })).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id))).toEqual(before);
    expect(await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(eq(t.accuracyAssemblyRevisions.workspace_id, scope.workspace_id))).toEqual([]);
  });

  it("allows only scoped contributors and rejects spoofed request identity", async () => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);
    const body = { action: "revise", workspace_id: scope.workspace_id, parent_assembly_id: assembly.id,
      expected_fingerprint: assembly.fingerprint, expected_head_id: assembly.id,
      change: { action: "remove", item_version_id: gapVersion.id, reason: "Source review" } };
    sessionContext.mockResolvedValue({ signed_in: false });
    expect((await reviewPost(body)).status).toBe(401);
    session("viewer"); expect((await reviewPost(body)).status).toBe(403);
    session("medical_affairs"); expect((await reviewPost(body)).status).toBe(403);
    session("contributor", "ungranted"); expect((await reviewPost(body)).status).toBe(404);
    session("contributor"); expect((await reviewPost({ ...body, author: reviewer })).status).toBe(400);
    const response = await reviewPost(body);
    expect(response.status).toBe(200);
    expect((await response.json()).revision.author.subject).toBe(reviewer.subject);
  });

  it("serializes competing contributors so exactly one current successor is published", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    const results = await Promise.allSettled([gapVersion.id, tacticVersion.id].map(item_version_id =>
      createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "remove", item_version_id, reason: "Concurrent source review" } })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: "conflict" });
    expect(await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(eq(t.accuracyAssemblyRevisions.workspace_id, scope.workspace_id))).toHaveLength(1);
  });

  it("rejects opposite-kind additions when a separate current production head owns that scope", async () => {
    const scope = await fixture();
    const { assembly } = await publishInventoryOnlyAssembly(scope);
    // Publish a need-only applied head separately, leaving the tactic baseline current.
    const payload = gap(scope, "Separately owned need");
    const run_id = await extractionRun(scope, "gap", payload);
    const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
    await applyExtractionBatch(batch, [run_id], [], async () => { await publishGeneratedItemHistory({ ...scope, run_id, claim_type: "gap",
      final_claims: [{ id: payload.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: payload.statement }] }); });
    await expect(createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "add", reason: "Add a conflicting human need",
      content: { claim_type: "gap", source_file_id: scope.source_file_id, payload: humanGap(scope, "Overlapping human need") } } })).rejects.toMatchObject({ code: "conflict" });
    expect(await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(eq(t.accuracyAssemblyRevisions.workspace_id, scope.workspace_id))).toEqual([]);
  });

  it.each(["gap", "tactic"] as const)("refuses an approved human %s addition after a new extraction owns its kind", async (humanKind) => {
    const scope = await fixture();
    const { assembly } = humanKind === "gap"
      ? await publishInventoryOnlyAssembly(scope)
      : await publishNeedOnlyAssembly(scope);
    installCoverage();
    const generatedTactic = tactic(scope, "Human tactic on need-only baseline");
    const humanTactic = { name: generatedTactic.name, type: "publication" as const, status: "planned" as const,
      evidence_question: generatedTactic.evidence_question, origin: "inventory" as const, provenance: generatedTactic.provenance };
    const content = humanKind === "gap"
      ? { claim_type: "gap" as const, source_file_id: scope.source_file_id,
        payload: humanGap(scope, "Human gap on inventory-only baseline", "human-gap-identity") }
      : { claim_type: "tactic" as const, source_file_id: scope.source_file_id, payload: humanTactic };
    const revised = await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: {
      action: "add", reason: "Source-backed missing opposite-kind item", content } });
    await approve(scope, revised.assembly);
    const human = revised.assembly.items.find(item => item.human_origin)!;
    const live = (await approvedLiveInventory(scope.workspace_id))!;
    expect(live.selected_items.map(item => item.item_version_id)).toContain(human.id);
    expect((await listDownstreamClaims(scope.workspace_id, { limit: null })).map(item => item.id)).toContain(human.canonical_claim_id);

    // A new independently approved extraction owns only the human-added kind.
    const replacement = humanKind === "gap"
      ? await publishNeedOnlyAssembly(scope, gap(scope, "Independent new need", "independent-gap-identity"))
      : await publishInventoryOnlyAssembly(scope, tactic(scope, "Independent new tactic", "independent-tactic-identity"));
    expect(replacement.assembly.items[0].canonical_claim_id).not.toBe(human.canonical_claim_id);
    await approve(scope, replacement.assembly);
    expect(await assemblyReviewState(scope.workspace_id, revised.assembly.id)).toMatchObject({ status: "stale", head_status: "stale" });
    const reads = await Promise.allSettled([approvedLiveInventory(scope.workspace_id), listDownstreamClaims(scope.workspace_id, { limit: null })]);
    expect.soft(reads.map(result => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of reads) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "approval_required" });
    await expect(revalidateApprovedLiveBindings(scope.workspace_id, live.bindings)).rejects.toMatchObject({ code: "conflict" });

    // Start downstream work after ownership changed: it must fail before any consumption/publication.
    const downstream = await Promise.allSettled([runAccuracyModule({ call_kind: "status_derive", agent_role: "none",
      workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      input: { workspace_id: scope.workspace_id } })]);
    expect.soft(downstream.map(result => result.status)).toEqual(["rejected"]);
    if (downstream[0].status === "rejected") expect(downstream[0].reason).toMatchObject({ code: "approval_required" });
    expect.soft(await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
      eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id), eq(t.accuracyModuleRuns.call_kind, "status_derive")))).toEqual([]);
    const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id));
    for (const claim of claims) expect.soft(claim.metadata).not.toHaveProperty("computed_status");
  });

  it("preserves original extraction and evaluator gold scores, and refuses experiment revision targets", async () => {
    const scope = await fixture();
    const { assembly, gapVersion } = await publishAssembly(scope);
    const runRows = await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id))
      .orderBy(t.accuracyModuleRuns.id);
    const evaluation = { gold: [{ statement: "Evaluator-only expected need" }], model_score: 0.42 };
    await accuracyDb().insert(t.accuracyExperimentEvaluations).values({ id: newId("eval"), experiment_id: newId("exp"), workspace_id: scope.workspace_id,
      call_id: gapVersion.run_id!, version_index: 0, evaluator_version: "test", evaluation, recorded_at: nowIso() });
    const scores = await accuracyDb().select().from(t.accuracyExperimentEvaluations).where(eq(t.accuracyExperimentEvaluations.workspace_id, scope.workspace_id));
    installCoverage();
    await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "edit", item_version_id: gapVersion.id, reason: "Source-backed correction",
      content: { claim_type: "gap", source_file_id: scope.source_file_id, payload: humanGap(scope, "Human correction does not rewrite model score") } } });
    expect(await accuracyDb().select().from(t.accuracyExperimentEvaluations).where(eq(t.accuracyExperimentEvaluations.workspace_id, scope.workspace_id))).toEqual(scores);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id),
      inArray(t.accuracyModuleRuns.id, runRows.map(run => run.id)))).orderBy(t.accuracyModuleRuns.id)).toEqual(runRows);
    const experiment = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: assembly.source_file_ids,
      selections: [], mappings: [], coverage_run_ids: [], linking_complete: true, extraction_runs: assembly.extraction_runs!.map(run => ({ ...run, evaluation_context: "experiment" })) });
    await expect(createAssemblyRevision({ ...revisionArgs(scope, experiment), change: { action: "add", reason: "Cannot change experiment model output",
      content: { claim_type: "gap", source_file_id: scope.source_file_id, payload: humanGap(scope, "Human benchmark pollution") } } })).rejects.toMatchObject({ code: "conflict" });
  });

  it("binds live provider inputs to exact edited content and refuses publication after a new revision", async () => {
    const scope = await fixture();
    const { assembly, gapVersion, tacticVersion } = await publishAssembly(scope);
    installCoverage();
    const revised = await createAssemblyRevision({ ...revisionArgs(scope, assembly), change: { action: "edit", item_version_id: gapVersion.id,
      reason: "Precise revised language", content: { claim_type: "gap", source_file_id: scope.source_file_id, payload: humanGap(scope, "Exact human wording for downstream") } } });
    await approve(scope, revised.assembly);
    const human = revised.assembly.items.find(item => item.human_origin)!;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const module_id = newId("race-coverage");
    const downstreamModule = mechanicalModule({ id: module_id, call_kind: "coverage_decide", title: "Provider revision race", summary: "test",
      inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string(), tactic_id: z.string(), block_bundle_ids: z.array(z.string()),
        selected_versions: z.object({ gap_version_id: z.string(), tactic_version_id: z.string(), gap_payload: z.record(z.string(), z.unknown()), tactic_payload: z.record(z.string(), z.unknown()) }) }),
      outputSchema: z.object({ gap_id: z.string(), tactic_id: z.string(), overall: z.literal("partial"), quote_block_ids: z.array(z.string()), confidence: z.number(), rationale: z.string() }),
      run: async input => {
        expect(accuracyTransactionActive()).toBe(false);
        expect(input.selected_versions.gap_payload.statement).toBe("Exact human wording for downstream");
        enter(); await released;
        return { output: { gap_id: input.gap_id, tactic_id: input.tactic_id, overall: "partial" as const, quote_block_ids: input.block_bundle_ids,
          confidence: 0.8, rationale: "Provider output" }, summary: "Provider output" };
      } });
    downstreamModule.manifest.agentic = true;
    registerAccuracyModule(downstreamModule);
    activateAccuracyModule({ call_kind: "coverage_decide", module_id, activated_by: "revision race" });
    const running = runAccuracyModule({ call_kind: "coverage_decide", agent_role: "proposer", workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      input: { workspace_id: scope.workspace_id, gap_id: human.canonical_claim_id, tactic_id: tacticVersion.claim_id, block_bundle_ids: [scope.block_id],
        selected_versions: { gap_version_id: human.id, tactic_version_id: tacticVersion.id, gap_payload: human.payload, tactic_payload: tacticVersion.payload } } });
    const outcome = expect(running).rejects.toMatchObject({ code: "conflict" });
    await entered;
    await createAssemblyRevision({ ...revisionArgs(scope, revised.assembly), change: { action: "remove", item_version_id: human.id, reason: "New revision while downstream provider works" } });
    release(); await outcome;
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(and(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id),
      eq(t.accuracyModuleRuns.module_id, module_id), eq(t.accuracyModuleRuns.status, "ok")))).toHaveLength(0);
  });

});
