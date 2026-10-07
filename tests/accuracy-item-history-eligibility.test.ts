/** History alternatives stay visible while mutation and downstream boundaries exclude them. */
import { afterEach, expect, it } from "vitest";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertClaim, applyClaimValidation, updateClaimMetadata, persistClaimPatch, listClaims, tacticsForGantt, gapsForGantt } from "@/accuracy/store/claim-store";
import { listCoveragePairs, upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { claimMetadata } from "@/accuracy/store/claim-store";
import { POST as coverageAssist } from "@/app/api/accuracy/coverage/assist/route";
import { buildWorkshopInventory } from "@/accuracy/store/workshop-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { listActiveSourceClaims } from "@/accuracy/store/claim-store";
import { newId } from "@/modules/kernel/ids";
const workspaces: string[] = [];
afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });
it("keeps history-only drafts reviewable but blocks promotion, metadata removal and coverage", async () => {
  const org_id = await createOrganization("eligibility");
  const workspace_id = await createWorkspace({ org_id, name: "eligibility", slug: newId("slug") }); workspaces.push(workspace_id);
  const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Alternative", metadata: { history_only: true }, validated: true });
  const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Alternative tactic", metadata: { history_only: true }, validated: true });
  const legacy = await insertClaim({ workspace_id, claim_type: "gap", statement: "Legacy" });
  expect((await listClaims(workspace_id)).map(row => row.id)).toContain(gap.id);
  expect(gap.validated).toBe(false);
  await expect(applyClaimValidation({ workspace_id, claim_ids: [gap.id], action: "validate", rationale: "Confirmed", actor: { name: "Reviewer", function: "medical_affairs" } })).rejects.toThrow(/history/i);
  expect(claimMetadata(await updateClaimMetadata({ workspace_id, claim_id: gap.id, metadata: {} })).history_only).toBe(true);
  expect(claimMetadata(await persistClaimPatch({ workspace_id, claim_id: tactic.id, metadata: {}, status: "validated" })).history_only).toBe(true);
  expect(tacticsForGantt([tactic])).toEqual([]); expect(gapsForGantt([gap])).toEqual([]);
  expect(await listCoveragePairs(workspace_id)).toEqual([]);
  await expect(upsertCoverageDecision({ workspace_id, gap_id: gap.id, tactic_id: tactic.id, overall: "covers", rationale: "Confirmed" })).rejects.toThrow(/eligible/i);
  registerAccuracyStack();
  const actor = { name: "Reviewer", function: "medical_affairs" as const };
  const merge = await runAccuracyModule<{ survivors: number }>({ workspace_id, org_id, actor, call_kind: "merge_dedupe", input: { workspace_id }, agent_role: "none" });
  expect(merge.output.survivors).toBe(1);
  const status = await runAccuracyModule<{ statuses: unknown[] }>({ workspace_id, org_id, actor, call_kind: "status_derive", input: { workspace_id, gap_ids: [gap.id], tactics: [{ id: tactic.id, status: "completed" }], coverages: [{ gap_id: gap.id, tactic_id: tactic.id, overall: "covers", validated: true }] }, agent_role: "none" });
  expect(status.output.statuses).toEqual([]);
  const response = await coverageAssist(new Request("http://localhost/api/accuracy/coverage/assist", { method: "POST", body: JSON.stringify({ workspace_id, gap_id: gap.id, tactic_id: tactic.id }) }));
  expect(response.status).toBe(400);
  const inventory = await buildWorkshopInventory(workspace_id);
  expect(JSON.stringify(inventory)).not.toContain(gap.id);
  expect((await applyClaimValidation({ workspace_id, claim_ids: [legacy.id], action: "validate", rationale: "Confirmed", actor: { name: "Reviewer", function: "medical_affairs" } })).updated).toBe(1);
});

it("counts eligible claims, but not matching history-only drafts, toward completeness inventory", async () => {
  const org_id = await createOrganization("completeness history");
  const workspace_id = await createWorkspace({ org_id, name: "completeness history", slug: newId("slug") }); workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "evidence.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  const statement = "Unmet evidence need for comparative effectiveness in elderly NSCLC patients after progression.";
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: statement }] });
  const metadata = { provenance: [{ block_id, source_file_id: source.id, quote: statement }] };
  await insertClaim({ workspace_id, source_file_id: source.id, claim_type: "gap", statement, metadata: { ...metadata, history_only: true } });
  registerAccuracyStack();
  const args = { workspace_id, org_id, actor: { name: "Reviewer", function: "medical_affairs" as const }, call_kind: "completeness_audit" as const, input: { workspace_id }, agent_role: "none" as const };
  const missing = await runAccuracyModule<{ flags: Array<{ block_id: string }> }>(args);
  expect(missing.output.flags.map(flag => flag.block_id)).toEqual([block_id]);
  expect(await listActiveSourceClaims(workspace_id, source.id)).toEqual([]);
  const judged = await insertClaim({ workspace_id, source_file_id: source.id, claim_type: "gap", statement, metadata });
  expect((await listActiveSourceClaims(workspace_id, source.id)).map(claim => claim.id)).toEqual([judged.id]);
  const covered = await runAccuracyModule<{ flags: unknown[] }>(args);
  expect(covered.output.flags).toEqual([]);
});


it("reads eligible downstream inventory before row caps even with more than 1000 newer review drafts", async () => {
  const { accuracyDb } = await import("@/accuracy/store/db");
  const t = await import("@/accuracy/store/schema");
  const { projectWorkspaceGantt, saveFinalGanttPlan } = await import("@/accuracy/modules/gantt-project/save-final");
  const { POST: ideate } = await import("@/app/api/accuracy/ideate/route");
  const org_id = await createOrganization("capped inventory");
  const workspace_id = await createWorkspace({ org_id, name: "capped", slug: newId("slug") }); workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "evidence.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  const statement = "Unmet evidence need for comparative effectiveness in elderly NSCLC patients after progression.";
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: statement }] });
  const gap = await insertClaim({ workspace_id, source_file_id: source.id, claim_type: "gap", statement, validated: true,
    metadata: { priority: "high", provenance: [{ source_file_id: source.id, block_id, quote: statement }] } });
  const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Eligible dated study", validated: true,
    metadata: { gap_ids: [gap.id], start: "2026-01-01", end: "2026-06-01", tactic_status: "planned" } });
  await accuracyDb().insert(t.accuracyClaims).values(Array.from({ length: 1001 }, (_, i) => ({
    id: newId("draft"), workspace_id, claim_type: i % 2 ? "gap" : "tactic", statement: `Review draft ${i}`,
    status: "draft", validated: false, metadata: { history_only: true }, created_at: "2099-01-01", updated_at: "2099-01-01",
  })));
  expect((await listClaims(workspace_id)).every(row => claimMetadata(row).history_only === true)).toBe(true);
  expect((await listCoveragePairs(workspace_id)).map(row => [row.gap.id, row.tactic.id])).toEqual([[gap.id, tactic.id]]);
  expect((await projectWorkspaceGantt(workspace_id)).activities.map(row => row.tactic_id)).toEqual([tactic.id]);
  expect((await saveFinalGanttPlan({ workspace_id, note: "Approved plan", actor: { name: "Reviewer", function: "medical_affairs" } })).plan.snapshot.tactic_ids).toEqual([tactic.id]);
  const inventory = await buildWorkshopInventory(workspace_id);
  expect(inventory.gaps.map(row => row.id)).toEqual([gap.id]); expect(inventory.tactics.map(row => row.id)).toEqual([tactic.id]);
  registerAccuracyStack();
  const args = { workspace_id, org_id, actor: { name: "Reviewer", function: "medical_affairs" as const }, input: { workspace_id }, agent_role: "none" as const };
  expect((await runAccuracyModule<{ survivors: number }>({ ...args, call_kind: "merge_dedupe" })).output.survivors).toBe(2);
  expect((await runAccuracyModule<{ statuses: Array<{ gap_id: string }> }>({ ...args, call_kind: "status_derive" })).output.statuses.map(row => row.gap_id)).toEqual([gap.id]);
  expect((await runAccuracyModule<{ flags: unknown[] }>({ ...args, call_kind: "completeness_audit" })).output.flags).toEqual([]);
  expect((await listActiveSourceClaims(workspace_id, source.id)).map(row => row.id)).toEqual([gap.id]);
  const response = await ideate(new Request("http://localhost/api/accuracy/ideate", { method: "POST", body: JSON.stringify({ workspace_id, gap_id: gap.id, title: "A proposed eligible study", rationale: "Needed evidence" }) }));
  expect(response.status).toBe(200);
});


it("filters requested item type before the SQL cap and keeps stored excluded references out of Gantt", async () => {
  const { listDownstreamClaims } = await import("@/accuracy/store/claim-store");
  const { projectWorkspaceGantt } = await import("@/accuracy/modules/gantt-project/save-final");
  const org_id = await createOrganization("typed inventory");
  const workspace_id = await createWorkspace({ org_id, name: "typed", slug: newId("slug") }); workspaces.push(workspace_id);
  const draft = await insertClaim({ workspace_id, claim_type: "gap", statement: "Review ancestor", metadata: { history_only: true } });
  const rejected = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Rejected dependency", status: "rejected" });
  const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Eligible study", validated: true,
    metadata: { gap_ids: [draft.id], depends_on: [rejected.id], start: "2026-01-01", end: "2026-06-01" } });
  await insertClaim({ workspace_id, claim_type: "gap", statement: "More recent gap" });
  expect((await listDownstreamClaims(workspace_id, { claim_type: "tactic", limit: 1 })).map(row => row.id)).toEqual([tactic.id]);
  const projected = await projectWorkspaceGantt(workspace_id);
  expect(projected.activities).toHaveLength(1);
  expect(projected.activities[0]).toMatchObject({ gap_ids: [], depends_on: [] });
});
