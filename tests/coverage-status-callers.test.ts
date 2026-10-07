import { describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { insertClaim, claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { insertCoverageJoin, coveragePairRevisions, upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { coverageProvenance } from "./support/coverage-provenance";
import type { StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";
import { buildWorkshopInventory } from "@/accuracy/store/workshop-store";
import { createGap, createProposedTactic, lockTactic, lockCoverageOverall, loadState, resetDemoSetup, modifyTactic, modifyGap, validateGap, persistState, createAddressedGap } from "@/lib/iegp/store";
import { computeGapStatus, gapsReadyForPrioritize } from "@/lib/iegp/engine";
const actor = { name: "Coverage reviewer", function: "heor" as const };
async function accuracyPair() {
  registerAccuracyStack();
  const org_id = await createOrganization(`task5-${crypto.randomUUID()}`);
  const workspace_id = await createWorkspace({ org_id, name: "Task5", slug: crypto.randomUUID() });
  const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Comparator need" });
  const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Planned comparison", status: "planned", metadata: { tactic_status: "planned" } });
  const derive = () => runAccuracyModule<StatusDeriveOutput>({ call_kind: "status_derive", agent_role: "none", input: { workspace_id }, actor, org_id, workspace_id });
  return { org_id, workspace_id, gap, tactic, derive };
}
async function planPair() {
  await resetDemoSetup();
  const gap_id = await createGap({ name: "Comparator need", statement: "Comparator need", domain: "efficacy", actor_name: actor.name, actor_function: actor.function });
  const tactic_id = await createProposedTactic({ name: "Planned comparison", type: "rwe_study", description: "Compare outcomes", evidence_question: "Comparator outcomes?", population: "Adults", intervention: "Drug", comparator: "SoC", outcomes: "Survival", geography: "EU", owner: actor.name, function: actor.function, residual_ids: [], gap_id, actor_name: actor.name, actor_function: actor.function });
  await lockTactic({ tactic_id, status: "planned", actor_name: actor.name, actor_function: actor.function });
  const row = (await loadState()).coverages.find((c) => c.gap_id === gap_id)!;
  await lockCoverageOverall({ coverage_id: row.id, overall: "full", rationale: "Addresses comparison", actor_name: actor.name, actor_function: actor.function });
  const status = async () => { const state = await loadState(); return computeGapStatus(state.coverages.filter((c) => c.gap_id === gap_id), state.tactics); };
  return { gap_id, tactic_id, coverage_id: row.id, status };
}
describe("actual authoritative status callers", () => {
  it("keeps raw legacy human Full pending/open in status persistence and workshop", async () => {
    const p = await accuracyPair();
    await insertCoverageJoin({ workspace_id: p.workspace_id, gap_id: p.gap.id, tactic_id: p.tactic.id, overall: "full", validated: true });
    expect((await p.derive()).output.statuses[0].computed).toBe("open");
    expect(claimMetadata((await listClaims(p.workspace_id)).find((c) => c.id === p.gap.id)!).computed_status).toBe("open");
    expect((await buildWorkshopInventory(p.workspace_id)).gaps[0].coverage_status).toBe("open");
  });
  it("reads supported current human Full as addressed through both actual Accuracy consumers", async () => {
    const p = await accuracyPair();
    const provenance = await coverageProvenance(p.workspace_id, "Comparator need");
    // Use the factual claim owner, then confirm exactly the resulting current tokens.
    const { persistClaimPatch } = await import("@/accuracy/store/claim-store");
    await persistClaimPatch({ workspace_id: p.workspace_id, claim_id: p.gap.id, metadata: { provenance } });
    const pair = { workspace_id: p.workspace_id, gap_id: p.gap.id, tactic_id: p.tactic.id };
    await upsertCoverageDecision({ ...pair, ...await coveragePairRevisions(pair), overall: "full", rationale: "Addresses the comparison", actor });
    expect((await p.derive()).output.statuses[0].computed).toBe("addressed");
    expect((await buildWorkshopInventory(p.workspace_id)).gaps[0].coverage_status).toBe("addressed");
  });
  it("uses current human plan coverage and invalidates factual tactic edits until revalidation", async () => {
    const p = await planPair();
    expect(await p.status()).toBe("validated_addressed");
    await modifyTactic({ tactic_id: p.tactic_id, fields: { comparator: "Different comparator" }, rationale: "Correct comparator", actor_name: actor.name, actor_function: actor.function });
    expect(await p.status()).toBe("validated_open");
    const historical = (await loadState()).coverages.find((c) => c.id === p.coverage_id)!;
    expect(historical.overall_lock.actor_name).toBe(actor.name);
    expect(historical.overall_lock.note).toBe("Addresses comparison");
    await lockCoverageOverall({ coverage_id: p.coverage_id, overall: "full", rationale: "Revalidated comparator", actor_name: actor.name, actor_function: actor.function });
    expect(await p.status()).toBe("validated_addressed");
  });
  it("invalidates plan coverage after a factual gap edit without erasing the human verdict", async () => {
    const p = await planPair();
    expect(await p.status()).toBe("validated_addressed");
    await modifyGap({ gap_id: p.gap_id, statement: "Different population need", rationale: "Correct population", actor_name: actor.name, actor_function: actor.function });
    expect(await p.status()).toBe("validated_open");
    expect((await loadState()).coverages.find((c) => c.id === p.coverage_id)!.overall).toBe("full");
  });
  it("does not use cached Addressed as priority readiness when legacy coverage lacks factual tokens", async () => {
    const p = await planPair();
    await validateGap({ gap_id: p.gap_id, actor_name: actor.name, actor_function: actor.function, note: "Checked the coverage" });
    const state = await loadState();
    const row = state.coverages.find((c) => c.id === p.coverage_id)!;
    delete row.overall_lock.gap_revision;
    delete row.overall_lock.tactic_revision;
    await persistState(state);
    const legacy = await loadState();
    expect(await p.status()).toBe("validated_open");
    expect(gapsReadyForPrioritize(legacy)).toBe(false);
  });

  it("refuses to persist a manual Addressed gap from a proposed tactic", async () => {
    const p = await planPair();
    await lockTactic({ tactic_id: p.tactic_id, status: "proposed", actor_name: actor.name, actor_function: actor.function });
    const before = (await loadState()).gaps.length;
    await expect(createAddressedGap({ name: "New addressed need", tactic_id: p.tactic_id, actor_name: actor.name, actor_function: actor.function, note: "Proposed work cannot close this need" })).rejects.toThrow(/committed/i);
    expect((await loadState()).gaps).toHaveLength(before);
  });

});
