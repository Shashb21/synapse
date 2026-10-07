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
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { claimMetadata, getClaim, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { listCoverageJoins, upsertCoverageDecision } from "@/accuracy/store/coverage-store";
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
  const source_file_id = newId("source");
  const run_id = newId("run");
  if (importance) {
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, workspace_id, org_id, call_kind: "need_extract",
      agent_role: "proposer", module_id: "test", module_version: "1", status: "ok", started_at: nowIso(), finished_at: nowIso(),
      actor_name: "test", actor_function: "medical_affairs", input: { workspace_id, source_file_id }, steps: [] });
    await appendAgentEvent({ workspace_id, run_id, event: { event_type: "critique", iteration: 3, score: null, issues: [],
      completeness: { risk_level: importance, checked_block_ids: ["block"], unchecked_block_ids: [], prior_issue_resolutions: [],
        suspected_omissions: [{ issue_id: "missing-evidence", item_kind: "gap", summary: "Comparator evidence gap",
          source_ref: { source_file_id, block_id: "block" }, evidence_quote: "Comparator evidence missing", basis: "explicit",
          importance, reason: "Absent from snapshot", suggested_action: "Add gap" }] },
      latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 } });
    await accuracyDb().insert(t.accuracyExtractionBatches).values({ id: newId("batch"), workspace_id, source_file_id,
      requested_kinds: ["need_extract"], run_ids: [run_id], created_claim_ids: [], drafts_persisted: true, created_at: nowIso() });
  }
  const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need comparator evidence", validated: true,
    status: "open", metadata: { priority: "high" } });
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
function run(scope: { workspace_id: string; org_id: string }, call_kind: CallKind, input = { workspace_id: scope.workspace_id }) {
  return runAccuracyModule({ ...scope, call_kind, input, actor: { name: "test", function: "medical_affairs" } });
}

describe("downstream omission pause", () => {
  it.each(CALL_KINDS)("applies the complete call-kind policy to %s before starting a run", async (kind) => {
    const scope = await fixture();
    installMutationModule(kind);
    const before = await runs(scope.workspace_id);
    if (allowed.has(kind)) {
      await expect(run(scope, kind)).resolves.toMatchObject({ call_kind: kind });
      expect(await listClaims(scope.workspace_id)).toHaveLength(3);
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
    await expect(run(scope, "status_derive")).resolves.toMatchObject({ call_kind: "status_derive" });
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
    const response = await coverageRead(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${scope.workspace_id}`));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.blockers).toEqual([expect.objectContaining({ workspace_id: scope.workspace_id, run_id: scope.run_id })]);
    expect(JSON.stringify(body)).not.toContain(other.run_id);
    expect(body.pairs).toBeUndefined();
    expect(await listCoverageJoins(scope.workspace_id)).toEqual([]);
  });
  it("renders paused coverage without generating or rendering a new pair queue", async () => {
    const scope = await fixture();
    const page = await AccuracyCoveragePage({ searchParams: Promise.resolve({ workspace_id: scope.workspace_id }) });
    const html = renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
    expect(html).toContain("Coverage is paused until important source omissions are resolved.");
    expect(html).not.toContain("Need comparator evidence");
    expect(html).not.toContain("Comparator study");
    expect(html).not.toContain("Pair 1 of");
    expect(await listCoverageJoins(scope.workspace_id)).toEqual([]);
  });
  it.each(["advisory", null] as const)("continues coverage candidate generation with %s findings", async (importance) => {
    const scope = await fixture(importance);
    const response = await coverageRead(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${scope.workspace_id}`));
    expect(response.status).toBe(200);
    expect((await response.json()).pairs).toEqual([expect.objectContaining({ id: `pair_${scope.gap.id}_${scope.tactic.id}`, gap_id: scope.gap.id, tactic_id: scope.tactic.id })]);
    const page = await AccuracyCoveragePage({ searchParams: Promise.resolve({ workspace_id: scope.workspace_id }) });
    const html = renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
    expect(html).toContain("Need comparator evidence");
    expect(html).toContain("Comparator study");
    expect(html).not.toContain("Coverage is paused");
  });
  it("keeps saved coverage decisions readable through audit while paused", async () => {
    const scope = await fixture();
    await upsertCoverageDecision({ workspace_id: scope.workspace_id, gap_id: scope.gap.id, tactic_id: scope.tactic.id, overall: "covers", rationale: "Historical source review" });
    const page = await AccuracyAuditPage({ searchParams: Promise.resolve({ workspace_id: scope.workspace_id }) });
    const html = renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
    expect(html).toContain("Historical source review");
    expect(html).toContain("coverage · covers");
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
    expect(await listCoverageJoins(scope.workspace_id)).toEqual([]);
    expect(claimMetadata((await getClaim(scope.workspace_id, scope.gap.id))!).priority).toBe("high");
    // Pausing writes must leave the existing snapshot visible for review.
    const read = await workshopRead(new Request(`http://localhost/api/accuracy/workshop?workspace_id=${scope.workspace_id}`));
    expect(read.status).toBe(200);
    expect((await read.json()).snapshot).toEqual(before);
  });
  it.each(["coverage", "assist", "validate", "manual ideate", "live ideate", "priority", "claim insert validated", "claim insert draft", "gantt", "save-final"])("returns scoped 409 without direct changes for %s", async (path) => {
    const scope = await fixture();
    const before = await runs(scope.workspace_id);
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
    expect(await listCoverageJoins(scope.workspace_id)).toEqual([]);
    expect(await latestAccuracyPlan(scope.workspace_id)).toBeNull();
    const gap = await getClaim(scope.workspace_id, scope.gap.id);
    expect(gap?.validated).toBe(true);
    expect(claimMetadata(gap!).priority).toBe("high");
  });
});
