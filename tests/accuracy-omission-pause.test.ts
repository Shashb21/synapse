/** Integration checks for omission pauses at the runner and direct HTTP boundaries. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import AccuracyCoveragePage from "@/app/admin/accuracy/coverage/page";
import AccuracyAuditPage from "@/app/admin/accuracy/audit/page";
import AccuracyTimelinePage from "@/app/admin/accuracy/timeline/page";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { CALL_KINDS, type CallKind } from "@/accuracy/kernel/contracts";
import { activateAccuracyModule, activeAccuracyModuleId, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import { appendAgentEvent } from "@/accuracy/kernel/agent-events";
import { withAssemblyPreparation } from "@/accuracy/kernel/assembly-context";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { reviewAssembly } from "@/accuracy/store/assembly-review-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { applyExtractionBatch, createExtractionBatch } from "@/accuracy/store/extraction-batch-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { claimMetadata, getClaim, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { listCoverageJoins } from "@/accuracy/store/coverage-store";
import { projectWorkspaceGantt, saveFinalGanttPlan } from "@/accuracy/modules/gantt-project/save-final";
import { latestAccuracyPlan } from "@/accuracy/store/plan-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import { POST as coverage, GET as coverageRead } from "@/app/api/accuracy/coverage/route";
import { POST as assist } from "@/app/api/accuracy/coverage/assist/route";
import { POST as validate } from "@/app/api/accuracy/claims/validate/route";
import { POST as ideate } from "@/app/api/accuracy/ideate/route";
import { POST as insert } from "@/app/api/accuracy/claims/route";
import { POST as priority } from "@/app/api/accuracy/claims/priority/route";
import { GET as gantt } from "@/app/api/accuracy/gantt/route";
import { POST as workshop, PATCH as workshopScene, GET as workshopRead } from "@/app/api/accuracy/workshop/route";
import { POST as workshopTags } from "@/app/api/accuracy/workshop/tags/route";
import { POST as workshopActions } from "@/app/api/accuracy/workshop/actions/route";
import { addFacilitatorTag, createWorkshopSnapshot, getWorkshopSnapshot, latestWorkshopSnapshot } from "@/accuracy/store/workshop-store";
import { POST as saveFinal } from "@/app/api/accuracy/gantt/save-final/route";
import { coverageProvenance } from "./support/coverage-provenance";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const allowed = new Set<CallKind>(["upload", "parse", "need_extract", "inventory_extract", "completeness_audit"]);
const originals = new Map<CallKind, string>();
beforeAll(() => { registerAccuracyStack(); });
afterEach(() => {
  for (const [call_kind, module_id] of originals) activateAccuracyModule({ call_kind, module_id, activated_by: "test restore" });
  originals.clear();
});

async function fixture(importance: "important" | "advisory" | null = "important") {
  await ensureAccuracySchema();
  const org_id = await createOrganization(newId("org-label"));
  const workspace_id = await createWorkspace({ org_id, name: "Pause checks", slug: newId("slug") });
  const source_file_id = importance ? (await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("sum") })).id : newId("source");
  const run_id = newId("run");
  if (importance) {
    const block_id = newId("block");
    await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id,
      index: 0, kind: "paragraph", heading: null, text: "Comparator evidence missing", parser: "test", created_at: nowIso() });
    const gapPayload = { id: newId("gap"), statement: "Need comparator evidence", external_id: null,
      provenance: [{ source_file_id, block_id, quote: "Comparator evidence missing" }] };
    const tacticPayload = { id: newId("tac"), name: "Comparator study", type: "publication", status: "planned",
      evidence_question: "Will this address the gap?", origin: "inventory",
      provenance: [{ source_file_id, block_id, quote: "Comparator evidence missing" }] };
    const inventoryRunId = newId("run");
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, workspace_id, org_id, call_kind: "need_extract",
      agent_role: "proposer", module_id: "test", module_version: "1", status: "ok", started_at: nowIso(), finished_at: nowIso(),
      actor_name: "test", actor_function: "medical_affairs", input: { workspace_id, source_file_id },
      output: { workspace_id, source_file_id, gaps: [gapPayload] }, steps: [] });
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: inventoryRunId, workspace_id, org_id, call_kind: "inventory_extract",
      agent_role: "proposer", module_id: "test", module_version: "1", status: "ok", started_at: nowIso(), finished_at: nowIso(),
      actor_name: "test", actor_function: "medical_affairs", input: { workspace_id, source_file_id },
      output: { workspace_id, source_file_id, tactics: [tacticPayload] }, steps: [] });
    await appendAgentEvent({ workspace_id, run_id, event: { event_type: "critique", iteration: 3, score: null, issues: [],
      completeness: { risk_level: importance, checked_block_ids: [block_id], unchecked_block_ids: [], prior_issue_resolutions: [],
        suspected_omissions: [{ issue_id: "missing-evidence", item_kind: "gap", summary: "Comparator evidence gap",
          source_ref: { source_file_id, block_id }, evidence_quote: "Comparator evidence missing", basis: "explicit",
          importance, reason: "Absent from snapshot", suggested_action: "Add gap" }] },
      latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 } });
    const batch = await createExtractionBatch(workspace_id, source_file_id, ["need_extract", "inventory_extract"]);
    const claimIds: string[] = [];
    await applyExtractionBatch(batch, [run_id, inventoryRunId], claimIds, async () => {
      claimIds.push(...(await publishGeneratedItemHistory({ workspace_id, source_file_id, run_id, claim_type: "gap",
        final_claims: [{ id: gapPayload.id, workspace_id, source_file_id, claim_type: "gap", statement: gapPayload.statement }] })).claim_ids);
      claimIds.push(...(await publishGeneratedItemHistory({ workspace_id, source_file_id, run_id: inventoryRunId, claim_type: "tactic",
        final_claims: [{ id: tacticPayload.id, workspace_id, source_file_id, claim_type: "tactic", statement: tacticPayload.name }] })).claim_ids);
    });
    const versions = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, workspace_id));
    const gapVersion = versions.find(version => version.run_id === run_id)!;
    const tacticVersion = versions.find(version => version.run_id === inventoryRunId)!;
    const coverageRunId = newId("run");
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: coverageRunId, workspace_id, org_id, call_kind: "coverage_decide",
      agent_role: "judge", module_id: "test", module_version: "1", status: "ok", started_at: nowIso(), finished_at: nowIso(),
      actor_name: "test", actor_function: "medical_affairs",
      input: { workspace_id, gap_id: gapVersion.id, tactic_id: tacticVersion.id, block_bundle_ids: [block_id],
        selected_versions: { gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id,
          gap_payload: gapVersion.payload, tactic_payload: tacticVersion.payload } },
      output: { gap_id: gapVersion.id, tactic_id: tacticVersion.id, overall: "full", quote_block_ids: [block_id],
        confidence: 0.8, rationale: "Source-backed pair." }, steps: [] });
    const assembly = await createAssembly({ workspace_id, actor: { name: "test", function: "medical_affairs" }, source_file_ids: [source_file_id],
      selections: [{ item_version_id: gapVersion.id, reason: "Current gap" }, { item_version_id: tacticVersion.id, reason: "Current tactic" }],
      mappings: [{ gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id }], coverage_run_ids: [coverageRunId],
      extraction_runs: [
        { call_kind: "need_extract", run_id, source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
        { call_kind: "inventory_extract", run_id: inventoryRunId, source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" },
      ], linking_complete: true, generation_key: batch.id });
    await reviewAssembly({ workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
      expected_review_id: null, decision: "approve", rationale: "Approve current source-backed pair.", advisory_overrides: [],
      reviewer: { subject: "pause-test", provider: "test", actor: { name: "Reviewer", function: "medical_affairs" }, role: "medical_affairs" } });
    const [storedGap] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, gapPayload.id));
    await accuracyDb().update(t.accuracyClaims).set({ validated: true, status: "validated",
      metadata: { ...(storedGap.metadata as Record<string, unknown>), priority: "high" } })
      .where(eq(t.accuracyClaims.id, gapPayload.id));
    const gap = (await getClaim(workspace_id, gapPayload.id))!;
    const tactic = (await getClaim(workspace_id, tacticPayload.id))!;
    return { org_id, workspace_id, source_file_id, run_id, gap, tactic };
  }
  const provenance = await coverageProvenance(workspace_id, "Need comparator evidence; comparator study collects this evidence.");
  const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need comparator evidence", validated: true,
    status: "open", metadata: { priority: "high", provenance } });
  const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Comparator study", validated: true,
    status: "validated", metadata: { start: "2026-01-01", end: "2026-06-01" } });
  return { org_id, workspace_id, source_file_id, run_id, gap, tactic };
}

async function runs(workspace_id: string) {
  return accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, workspace_id));
}
function request(body: object) {
  return new Request("http://localhost/api/accuracy/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function installMutationModule(call_kind: CallKind) {
  const original = activeAccuracyModuleId(call_kind);
  if (original) originals.set(call_kind, original);
  const id = newId("pause-test-module");
  registerAccuracyModule(mechanicalModule({ id, call_kind, title: "Pause test", summary: "Observable mutation",
    inputSchema: z.object({ workspace_id: z.string() }), outputSchema: z.object({ claim_id: z.string() }),
    run: async (input) => {
      const claim = await insertClaim({ workspace_id: input.workspace_id, claim_type: "gap", statement: "Executed module" });
      return { output: { claim_id: claim.id }, summary: "Executed" };
    } }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "test" });
}
function run(scope: { workspace_id: string; org_id: string }, call_kind: CallKind, input: Record<string, unknown> = { workspace_id: scope.workspace_id }) {
  return runAccuracyModule({ ...scope, call_kind, input, actor: { name: "test", function: "medical_affairs" } });
}

describe("downstream omission pause", () => {
  it.each(CALL_KINDS)("applies the complete call-kind policy to %s before starting a run", async (kind) => {
    const scope = await fixture();
    installMutationModule(kind);
    const before = await runs(scope.workspace_id);
    if (allowed.has(kind)) {
      await expect(withAssemblyPreparation(() => run(scope, kind))).resolves.toMatchObject({ call_kind: kind });
      expect(await withAssemblyPreparation(() => listClaims(scope.workspace_id))).toHaveLength(3);
    } else {
      await expect(run(scope, kind)).rejects.toMatchObject({ name: "AccuracyPausedError", blockers: [expect.objectContaining({ workspace_id: scope.workspace_id, run_id: scope.run_id })] });
      expect(await runs(scope.workspace_id)).toEqual(before);
      expect(await listClaims(scope.workspace_id)).toHaveLength(2);
    }
  });
  it.each(["workspace", "organization", "missing workspace"])("rejects conflicting %s before any run or mutation", async (conflict) => {
    const scope = await fixture(null);
    const other = await fixture();
    installMutationModule("status_derive");
    const before = await runs(scope.workspace_id);
    const outer = conflict === "organization" ? { ...scope, org_id: other.org_id }
      : conflict === "missing workspace" ? { ...scope, workspace_id: newId("unknown") } : scope;
    const input = { workspace_id: conflict === "workspace" ? other.workspace_id : outer.workspace_id };
    await expect(run(outer, "status_derive", input)).rejects.toThrow(/workspace|organization/i);
    expect(await runs(scope.workspace_id)).toEqual(before);
    expect(await listClaims(scope.workspace_id)).toHaveLength(2);
    expect(await listClaims(other.workspace_id)).toHaveLength(2);
  });
  it.each(["advisory", null] as const)("allows downstream progress with %s findings", async (importance) => {
    const scope = await fixture(importance);
    await expect(run(scope, "status_derive", { workspace_id: scope.workspace_id }))
      .resolves.toMatchObject({ call_kind: "status_derive" });
  });
  it("does not leak another workspace's blockers", async () => {
    const paused = await fixture();
    const clear = await fixture(null);
    const response = await gantt(new Request(`http://localhost/api/accuracy/gantt?workspace_id=${clear.workspace_id}`));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(paused.run_id);
  });
  it("returns scoped 409 before coverage GET generates candidate pairs", async () => {
    const scope = await fixture();
    const other = await fixture();
    const approvedCoverage = await listCoverageJoins(scope.workspace_id);
    const response = await coverageRead(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${scope.workspace_id}`));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.blockers).toEqual([expect.objectContaining({ workspace_id: scope.workspace_id, run_id: scope.run_id })]);
    expect(JSON.stringify(body)).not.toContain(other.run_id);
    expect(body.pairs).toBeUndefined();
    expect(await listCoverageJoins(scope.workspace_id)).toEqual(approvedCoverage);
  });
  it("renders paused coverage without generating or rendering a new pair queue", async () => {
    const scope = await fixture();
    const approvedCoverage = await listCoverageJoins(scope.workspace_id);
    const page = await AccuracyCoveragePage({ searchParams: Promise.resolve({ workspace_id: scope.workspace_id }) });
    const html = renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
    expect(html).toContain("Coverage is paused until important source omissions are resolved.");
    expect(html).not.toContain("Need comparator evidence");
    expect(html).not.toContain("Comparator study");
    expect(html).not.toContain("Pair 1 of");
    expect(await listCoverageJoins(scope.workspace_id)).toEqual(approvedCoverage);
  });
  it.each(["advisory", null] as const)("continues coverage candidate generation with %s findings", async (importance) => {
    const scope = await fixture(importance);
    const response = await coverageRead(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${scope.workspace_id}`));
    expect(response.status).toBe(200);
    expect((await response.json()).pairs).toEqual([expect.objectContaining({ gap_id: scope.gap.id, tactic_id: scope.tactic.id,
      overall: importance === "advisory" ? "full" : "pending" })]);
    const page = await AccuracyCoveragePage({ searchParams: Promise.resolve({ workspace_id: scope.workspace_id }) });
    const html = renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
    if (importance === "advisory") {
      expect(html).toContain("All 1 pair(s) decided");
      expect(html).toContain("0 pending");
    } else {
      expect(html).toContain("Need comparator evidence");
      expect(html).toContain("Comparator study");
    }
    expect(html).not.toContain("Coverage is paused");
  });
  it("keeps approved coverage decisions readable through audit while paused", async () => {
    const scope = await fixture();
    // Read the real exact approval made by the fixture; a pause must not require a new coverage mutation.
    const page = await AccuracyAuditPage({ searchParams: Promise.resolve({ workspace_id: scope.workspace_id }) });
    const html = renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
    expect(html).toContain("Source-backed pair.");
    expect(html).toContain("coverage · full");
    expect(html).not.toContain("Accuracy work is paused");
  });
  it("renders a visible pause message when the timeline page calls projection directly", async () => {
    const scope = await fixture();
    const page = await AccuracyTimelinePage({ searchParams: Promise.resolve({ workspace_id: scope.workspace_id }) });
    const html = renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
    expect(html).toContain("Timeline is paused until important source omissions are resolved.");
    expect(html).not.toContain("Comparator study");
  });
  it.each(["project", "save"])("pauses the direct Gantt %s helper used by server pages", async (path) => {
    const scope = await fixture();
    const operation = path === "project" ? projectWorkspaceGantt(scope.workspace_id)
      : saveFinalGanttPlan({ workspace_id: scope.workspace_id, note: "Direct final save", actor: { name: "test", function: "medical_affairs" } });
    await expect(operation).rejects.toMatchObject({ name: "AccuracyPausedError", blockers: [expect.objectContaining({ workspace_id: scope.workspace_id, run_id: scope.run_id })] });
    expect(await latestAccuracyPlan(scope.workspace_id)).toBeNull();
  });
  it.each(["snapshot", "scene", "add tag", "assign tag", "mark_addressed", "remap", "set_priority", "park"])("pauses workshop %s before changing frozen inventory or ledger", async (path) => {
    const scope = await fixture();
    const approvedCoverage = await listCoverageJoins(scope.workspace_id);
    let snapshot = path === "snapshot" ? null : await createWorkshopSnapshot({ workspace_id: scope.workspace_id,
      actor: { name: "test", function: "medical_affairs" } });
    if (path === "assign tag") snapshot = await addFacilitatorTag({ workspace_id: scope.workspace_id, snapshot_id: snapshot!.id, label: "Evidence team" });
    const before = snapshot ? await getWorkshopSnapshot(scope.workspace_id, snapshot.id) : null;
    const base = { workspace_id: scope.workspace_id, snapshot_id: snapshot?.id ?? "unused" };
    const response = path === "snapshot" ? await workshop(request({ workspace_id: scope.workspace_id, note: "Freeze paused inventory" }))
      : path === "scene" ? await workshopScene(request({ ...base, scene: "prioritize" }))
      : path === "add tag" ? await workshopTags(request({ ...base, action: "add_tag", label: "Evidence team" }))
      : path === "assign tag" ? await workshopTags(request({ ...base, action: "assign", gap_id: scope.gap.id, tag_id: snapshot!.payload.facilitator_tags.tags[0].id }))
      : await workshopActions(request({ ...base, kind: path, gap_id: scope.gap.id, tactic_id: scope.tactic.id, overall: "covers", priority: "low", rationale: "Review required" }));
    expect(response.status).toBe(409);
    expect((await response.json()).blockers).toEqual([expect.objectContaining({ workspace_id: scope.workspace_id, run_id: scope.run_id })]);
    expect(await latestWorkshopSnapshot(scope.workspace_id)).toEqual(before);
    expect(await listCoverageJoins(scope.workspace_id)).toEqual(approvedCoverage);
    expect(claimMetadata((await getClaim(scope.workspace_id, scope.gap.id))!).priority).toBe("high");
    // Pausing writes must leave the existing snapshot visible for review.
    const read = await workshopRead(new Request(`http://localhost/api/accuracy/workshop?workspace_id=${scope.workspace_id}`));
    expect(read.status).toBe(200);
    expect((await read.json()).snapshot).toEqual(before);
  });
  it.each(["coverage", "assist", "validate", "manual ideate", "live ideate", "priority", "claim insert validated", "claim insert draft", "gantt", "save-final"])("returns scoped 409 without direct changes for %s", async (path) => {
    const scope = await fixture();
    const before = await runs(scope.workspace_id);
    const approvedCoverage = await listCoverageJoins(scope.workspace_id);
    const handlers: Record<string, () => Promise<Response>> = {
      coverage: () => coverage(request({ workspace_id: scope.workspace_id, gap_id: scope.gap.id, tactic_id: scope.tactic.id, overall: "covers", rationale: "Source reviewed" })),
      assist: () => assist(request({ workspace_id: scope.workspace_id, gap_id: scope.gap.id, tactic_id: scope.tactic.id })),
      validate: () => validate(request({ workspace_id: scope.workspace_id, claim_ids: [scope.gap.id], action: "reject", rationale: "Review required" })),
      "manual ideate": () => ideate(request({ workspace_id: scope.workspace_id, gap_id: scope.gap.id, title: "New comparator registry study", rationale: "Fills the residual gap" })),
      "live ideate": () => ideate(request({ workspace_id: scope.workspace_id, gap_id: scope.gap.id })),
      priority: () => priority(request({ workspace_id: scope.workspace_id, claim_id: scope.gap.id, priority: "low", rationale: "Reprioritized" })),
      "claim insert validated": () => insert(request({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Direct inserted validated gap", validated: true, status: "validated" })),
      "claim insert draft": () => insert(request({ workspace_id: scope.workspace_id, claim_type: "gap", statement: "Direct inserted draft gap", validated: false, status: "draft" })),
      gantt: () => gantt(new Request(`http://localhost/api/accuracy/gantt?workspace_id=${scope.workspace_id}`)),
      "save-final": () => saveFinal(request({ workspace_id: scope.workspace_id, note: "Signed off" })),
    };
    const response = await handlers[path]();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.blockers).toEqual([expect.objectContaining({ workspace_id: scope.workspace_id, run_id: scope.run_id })]);
    expect(await runs(scope.workspace_id)).toEqual(before);
    expect(await listClaims(scope.workspace_id)).toHaveLength(2);
    expect(await listCoverageJoins(scope.workspace_id)).toEqual(approvedCoverage);
    expect(await latestAccuracyPlan(scope.workspace_id)).toBeNull();
    const gap = await getClaim(scope.workspace_id, scope.gap.id);
    expect(gap?.validated).toBe(true);
    expect(claimMetadata(gap!).priority).toBe("high");
  });
});
