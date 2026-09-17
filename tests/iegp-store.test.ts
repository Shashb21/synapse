import { describe, expect, it } from "vitest";
import { persistState, resetSeed, resetWorkedExample, loadState, lockGapStatus, lockPriority, ingestNeedFromText, ingestDemoSource, modifyGap, assignTacticToGap, lockTacticReview, completeWizard } from "@/lib/iegp/store";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { buildSeed } from "@/lib/iegp/seed";

describe("IEGP postgres store", () => {
  it("starts from a blank Velmara workspace", async () => {
    const state = await resetSeed();
    expect(state.asset.id).toBe("ASSET-VELMARA");
    expect(state.objectives.length).toBeGreaterThan(0);
    expect(state.asset.wizard_complete).toBe(false);
    expect(state.sources).toHaveLength(0);
    expect(state.needs).toHaveLength(0);
    expect(state.gaps).toHaveLength(0);
    expect(state.tactics).toHaveLength(0);
    expect(state.residuals).toHaveLength(0);
  });

  it("seeds the worked example and refuses to auto-close a gap as addressed", async () => {
    const state = await resetWorkedExample();
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
    await persistState(buildSeed());
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
    await persistState(buildSeed());
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
    expect(state.tactics.filter((t) => /chart review/i.test(t.name + t.evidence_question)).every((t) => t.review_status === "candidate")).toBe(true);
  });

  it("ingests a demo pack file from a blank workspace", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const state = await loadState();
    expect(state.sources.some((s) => s.filename === "01-heor-stakeholder-interview.txt")).toBe(true);
    expect(state.gaps.some((g) => g.status === "candidate")).toBe(true);
    expect(state.gaps.some((g) => /heor stakeholder interviews/i.test(g.name))).toBe(false);
    expect(state.gaps.some((g) => /economic burden|elderly|comparative/i.test(g.name))).toBe(true);
    expect(state.residuals.length).toBeGreaterThan(0);
    expect(state.tactics.some((t) => /chart review/i.test(t.name + t.evidence_question))).toBe(true);
  });

  it("modifies a candidate gap without accepting it", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "medical-plan",
      actor_name: "S. Iyer",
      actor_function: "evidence_lead",
    });
    const before = await loadState();
    const gap = before.gaps.find((g) => /ILD|QT/i.test(g.name + g.statement));
    expect(gap).toBeTruthy();
    await modifyGap({
      gap_id: gap!.id,
      name: "Routine-care ILD / QT",
      statement: "Need ILD and QT characterisation in routine US care, not only the label.",
      actor_name: "S. Iyer",
      actor_function: "evidence_lead",
    });
    const state = await loadState();
    const updated = state.gaps.find((g) => g.id === gap!.id);
    expect(updated?.name).toBe("Routine-care ILD / QT");
    expect(updated?.status).toBe("candidate");
  });

  it("reviews extracted tactics and only assigns accepted ones", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const before = await loadState();
    const tactic = before.tactics.find((t) => t.review_status === "candidate");
    expect(tactic).toBeTruthy();
    await expect(
      assignTacticToGap({
        gap_id: before.gaps[0]!.id,
        tactic_id: tactic!.id,
        actor_name: "A. Rao",
        actor_function: "heor",
      }),
    ).rejects.toThrow(/accepted tactics/i);
    await lockTacticReview({
      tactic_id: tactic!.id,
      review_status: "accepted",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const accepted = await loadState();
    expect(accepted.tactics.find((t) => t.id === tactic!.id)?.review_status).toBe("accepted");
    await completeWizard({
      actor_name: "S. Iyer",
      actor_function: "evidence_lead",
    });
    const after = await loadState();
    expect(after.asset.wizard_complete).toBe(true);
  });

  it("shows an assigned accepted tactic on a candidate review card", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const ingested = await loadState();
    const emptyWorkspace = buildPlanWorkspace(ingested);
    expect(emptyWorkspace.review.length).toBeGreaterThan(0);
    expect(emptyWorkspace.review.every((c) => c.tactics.length === 0)).toBe(true);
    expect(emptyWorkspace.availableTactics).toHaveLength(0);

    const tactic = ingested.tactics.find((t) => t.review_status === "candidate");
    const gap = ingested.gaps.find((g) => g.status === "candidate");
    expect(tactic).toBeTruthy();
    expect(gap).toBeTruthy();
    await lockTacticReview({
      tactic_id: tactic!.id,
      review_status: "accepted",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await assignTacticToGap({
      gap_id: gap!.id,
      tactic_id: tactic!.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const mapped = buildPlanWorkspace(await loadState());
    const card = mapped.review.find((c) => c.gap_id === gap!.id);
    expect(card?.tactics.some((t) => t.id === tactic!.id)).toBe(true);
    expect(mapped.review.filter((c) => c.gap_id !== gap!.id).every((c) => c.tactics.length === 0)).toBe(true);
  });
});
