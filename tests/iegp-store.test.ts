import { describe, expect, it } from "vitest";
import {
  ingestNeedFromText,
  loadState,
  lockGapStatus,
  lockPriority,
  modifyGap,
  resetSeed,
} from "@/lib/iegp/store";

describe("IEGP postgres store", () => {
  it("seeds Velmara and refuses to auto-close a gap as addressed", async () => {
    const state = await resetSeed();
    expect(state.asset.id).toBe("ASSET-VELMARA");
    expect(state.gaps.length).toBeGreaterThan(8);
    await expect(
      lockGapStatus({
        gap_id: "GAP-ELDERLY-CE",
        status: "validated_addressed",
        actor_name: "Test",
        actor_function: "evidence_lead",
      }),
    ).rejects.toThrow(/never auto-closes|Cannot lock Addressed/i);
  });

  it("allows addressed with an override note", async () => {
    await resetSeed();
    await lockGapStatus({
      gap_id: "GAP-ELDERLY-CE",
      status: "validated_addressed",
      actor_name: "S. Iyer",
      actor_function: "evidence_lead",
      note: "Governance accepted remaining residual as out of cycle.",
    });
    const state = await loadState();
    const gap = state.gaps.find((g) => g.id === "GAP-ELDERLY-CE");
    expect(gap?.status).toBe("validated_addressed");
    expect(gap?.status_lock.locked).toBe(true);
  });

  it("lets a human lock priority without an engine suggestion or residual lock", async () => {
    await resetSeed();
    await lockPriority({
      residual_id: "RES-OS",
      band: "medium",
      actor_name: "S. Iyer",
      actor_function: "evidence_lead",
    });
    const state = await loadState();
    const pri = state.priorities.find((p) => p.residual_id === "RES-OS");
    expect(pri?.band).toBe("medium");
    expect(pri?.suggested_score).toBe(0);
    expect(pri?.reasons.join(" ")).toMatch(/does not assign priority/i);
  });

  it("ingests a source into candidate gaps, residual drafts, and extracted tactics", async () => {
    await resetSeed();
    await ingestNeedFromText({
      title: "Affiliate safety note",
      source_type: "other_internal",
      stakeholder_function: "regulatory",
      text: "We need to understand pneumonitis rates in community hospitals after month six of Velmara. Limited evidence characterises monitoring protocols outside academic centres. A chart review in three EU5 hospitals is already underway.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const state = await loadState();
    const source = state.sources.find((s) => s.title === "Affiliate safety note");
    expect(source).toBeTruthy();
    const newNeeds = state.needs.filter((n) => n.source_id === source!.id);
    expect(newNeeds.length).toBeGreaterThan(0);
    const newGaps = state.gaps.filter(
      (g) => g.status === "candidate" && /pneumonitis|community hospitals/i.test(g.statement + g.name),
    );
    expect(newGaps.length).toBeGreaterThan(0);
    const residual = state.residuals.find((r) => newGaps.some((g) => g.id === r.gap_id));
    expect(residual).toBeTruthy();
    expect(state.tactics.some((t) => /chart review/i.test(t.name + t.evidence_question))).toBe(true);
  });

  it("modifies a candidate gap without accepting it", async () => {
    await resetSeed();
    await modifyGap({
      gap_id: "GAP-ILD",
      name: "Routine-care ILD / QT",
      statement: "Need ILD and QT characterisation in routine US care, not only the label.",
      actor_name: "S. Iyer",
      actor_function: "evidence_lead",
    });
    const state = await loadState();
    const gap = state.gaps.find((g) => g.id === "GAP-ILD");
    expect(gap?.name).toBe("Routine-care ILD / QT");
    expect(gap?.status).toBe("candidate");
  });
});
