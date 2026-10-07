import { describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { insertClaim, claimMetadata, getClaim } from "@/accuracy/store/claim-store";
import { buildWorkshopInventory, createWorkshopSnapshot, applyWorkshopAction } from "@/accuracy/store/workshop-store";
import { coverageProvenance } from "./support/coverage-provenance";
import type { StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";
const actor = { name: "Coverage reviewer", function: "heor" as const };
async function workspace() {
  registerAccuracyStack();
  const org_id = await createOrganization(`task5-workflow-${crypto.randomUUID()}`);
  const workspace_id = await createWorkspace({ org_id, name: "Task5 workflow", slug: crypto.randomUUID() });
  const provenance = await coverageProvenance(workspace_id, "Comparator need");
  const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Comparator need", validated: true, status: "validated", metadata: { provenance } });
  return { org_id, workspace_id, gap };
}
describe("authoritative workflow coverage seams", () => {
  it("keeps a workshop proposed-publication Full Open after confirmation", async () => {
    const p = await workspace();
    const tactic = await insertClaim({ workspace_id: p.workspace_id, claim_type: "tactic", statement: "Proposed publication", status: "proposed", metadata: { tactic_status: "proposed", tactic_type: "publication", evidence_available: "2026-01-01" } });
    const snapshot = await createWorkshopSnapshot({ workspace_id: p.workspace_id, scene: "gaps", note: "Freeze current decisions", actor });
    const changed = await applyWorkshopAction({ workspace_id: p.workspace_id, snapshot_id: snapshot.id, actor,
      action: { kind: "mark_addressed", gap_id: p.gap.id, tactic_id: tactic.id, rationale: "Confirm proposed publication assessment" } });
    expect(changed.payload.overlays[p.gap.id].coverage_status).toBe("open");
    expect((await buildWorkshopInventory(p.workspace_id)).gaps[0].coverage_status).toBe("open");
  });
  it("recomputes the entire gap after workshop remap: Full still dominates Partial", async () => {
    const p = await workspace();
    const tactics = await Promise.all(["A", "B"].map((statement) => insertClaim({ workspace_id: p.workspace_id, claim_type: "tactic", statement, status: "planned", metadata: { tactic_status: "planned" } })));
    const snapshot = await createWorkshopSnapshot({ workspace_id: p.workspace_id, scene: "gaps", note: "Freeze current decisions", actor });
    await applyWorkshopAction({ workspace_id: p.workspace_id, snapshot_id: snapshot.id, actor, action: { kind: "mark_addressed", gap_id: p.gap.id, tactic_id: tactics[0].id, rationale: "First tactic fully covers the need" } });
    const changed = await applyWorkshopAction({ workspace_id: p.workspace_id, snapshot_id: snapshot.id, actor, action: { kind: "remap", gap_id: p.gap.id, tactic_id: tactics[1].id, overall: "partial", rationale: "Second tactic covers only part" } });
    expect(changed.payload.overlays[p.gap.id].coverage_status).toBe("addressed");
  });
  it("never persists supplied preview joins as current status", async () => {
    const p = await workspace();
    const input = { workspace_id: p.workspace_id, tactics: [{ id: "T", status: "planned" }], coverages: [{ gap_id: p.gap.id, tactic_id: "T", overall: "full", validated: true, freshness: "current" }] };
    await expect(runAccuracyModule({ call_kind: "status_derive", agent_role: "none", input, actor, org_id: p.org_id, workspace_id: p.workspace_id })).rejects.toThrow(/preview/i);
    const preview = await runAccuracyModule<StatusDeriveOutput>({ call_kind: "status_derive", agent_role: "none", input: { ...input, persist: false }, actor, org_id: p.org_id, workspace_id: p.workspace_id });
    expect(preview.output.statuses[0].computed).toBe("open");
    expect(claimMetadata((await getClaim(p.workspace_id, p.gap.id))!).computed_status).toBeUndefined();
  });
});

import { resetDemoSetup, createGap, createProposedTactic, lockTactic, lockCoverageOverall, loadState, persistState, splitPartialGap } from "@/lib/iegp/store";
import { displayedGapStatus, gapsReadyForPrioritize } from "@/lib/iegp/engine";
import { setPlacement, validatePlacement, prioritizationProgress } from "@/modules/stages/s8-prioritization/module";
import { consolidationModule } from "@/modules/stages/s7-consolidation/module";
import { partialSplitModule } from "@/modules/stages/s6-partial-split/module";
import type { ModuleContext } from "@/modules/kernel/contracts";
async function stalePlanOverride() {
  await resetDemoSetup();
  const who = { actor_name: actor.name, actor_function: actor.function };
  const gap_id = await createGap({ name: "Comparator need", statement: "Comparator need", domain: "efficacy", ...who });
  await setPlacement({ gap_id, band: "high", rationale: "Place the open need", actor });
  const tactic_id = await createProposedTactic({ name: "Planned comparison", type: "rwe_study", description: "Comparison", evidence_question: "Compare outcomes?", population: "Adults", intervention: "Drug", comparator: "SoC", outcomes: "Survival", geography: "EU", owner: actor.name, function: actor.function, residual_ids: [], gap_id, ...who });
  await lockTactic({ tactic_id, status: "planned", ...who });
  const coverage = (await loadState()).coverages.find((c) => c.gap_id === gap_id)!;
  await lockCoverageOverall({ coverage_id: coverage.id, overall: "partial", rationale: "Only outcomes are covered", ...who });
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === gap_id)!;
  // Import a historical held decision. Its stale flag is never upgraded by a read.
  gap.human_validated = true;
  gap.status_override = { status: "validated_open", from: "validated_open", to: "validated_open", reason: "Prior human decision", actor_name: actor.name, actor_function: actor.function, at: "2026-01-01", stale: true };
  await persistState(state);
  return { gap_id, tactic_id, state: await loadState(), who };
}
describe("stale human overrides at split and priority seams", () => {
  it("preserves override display/history but excludes a stale Open from priority progress and writes, including an existing placement", async () => {
    const p = await stalePlanOverride();
    const gap = p.state.gaps.find((g) => g.id === p.gap_id)!;
    expect(displayedGapStatus(gap)).toBe("validated_open");
    expect(gap.status_override).toMatchObject({ actor_name: actor.name, reason: "Prior human decision", stale: true });
    expect(gapsReadyForPrioritize(p.state)).toBe(false);
    expect((await prioritizationProgress(p.state)).open).toBe(0);
    await expect(validatePlacement({ gap_id: p.gap_id, band: "low", rationale: "Cannot reuse stale decision", actor })).rejects.toThrow(/only Open/i);
    await expect(setPlacement({ gap_id: p.gap_id, band: "low", rationale: "Cannot reuse stale decision", actor })).rejects.toThrow(/only Open/i);
  });
  it("does not announce priority readiness through S7 using a stale held Open", async () => {
    await stalePlanOverride();
    const output = await consolidationModule.run(consolidationModule.inputSchema.parse({}), { run: { note: () => {} } } as unknown as ModuleContext);
    expect(output.output.ready_for_prioritization).toBe(false);
  });
  it("refuses a stale Partial override at both S6 proposal and store application", async () => {
    const p = await stalePlanOverride();
    p.state.gaps.find((g) => g.id === p.gap_id)!.status_override!.status = "validated_partial";
    await persistState(p.state);
    const ctx = { ai: true, route: { connected: true }, run: { note: () => {} } } as unknown as ModuleContext;
    await expect(partialSplitModule.run(partialSplitModule.inputSchema.parse({ gap_id: p.gap_id }), ctx)).rejects.toThrow(/current human-validated/i);
    await expect(splitPartialGap({ parent_gap_id: p.gap_id, addressed_name: "Covered slice", open_name: "Residual need", tactic_ids: [p.tactic_id], ...p.who })).rejects.toThrow(/Only Partially/i);
  });
});
