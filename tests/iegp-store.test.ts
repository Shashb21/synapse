import { describe, expect, it } from "vitest";
import { persistState, resetSeed, resetWorkedExample, loadState, lockGapStatus, lockPriority, ingestNeedFromText, ingestDemoSource, modifyGap, assignTacticToGap, lockTacticReview, completeWizard, createProposedTactic, createGap, acceptMapping, rejectMapping, suggestMappings, lockCoverageOverall, acceptResidualGap, rejectResidualGap, suggestResidualGaps } from "@/lib/iegp/store";
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

  it("ingests a source into candidate gaps, tactics, and residual drafts in Review", async () => {
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
    expect(state.tactics.some((t) => /chart review/i.test(t.name + t.evidence_question))).toBe(true);
    expect(state.tactics.filter((t) => /chart review/i.test(t.name + t.evidence_question)).every((t) => t.review_status === "candidate")).toBe(true);
    const workspace = buildPlanWorkspace(state);
    for (const card of workspace.review) {
      expect("residual" in card).toBe(false);
      if (card.gap_name != card.statement) {
        const body = `${card.gap_name}\n${card.statement}`;
        expect(body.split(card.statement).length - 1).toBe(1);
      }
    }
    expect(workspace.reviewResiduals.length).toBeGreaterThan(0);
    expect(workspace.residualGapSuggestions.length).toBeGreaterThan(0);
    expect(state.residuals.some((r) => r.review_status === "candidate")).toBe(true);
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
    expect(state.gaps.every((g) => !/^(Burden|Elderly|CNS):/i.test(g.name))).toBe(true);
    expect(state.gaps.every((g) => !/^(We need|It has no)\b/i.test(g.name))).toBe(true);
    expect(state.gaps.every((g) => !/[.?!]$/.test(g.name))).toBe(true);
    expect(state.gaps.some((g) => /economic burden|comparative/i.test(g.name))).toBe(true);
    expect(buildPlanWorkspace(state).reviewResiduals.length).toBeGreaterThan(0);
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
    expect(mapped.availableTactics.some((t) => t.id === tactic!.id)).toBe(true);
  });

  it("puts accepted and created tactics in the library so one tactic tags many gaps", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const ingested = await loadState();
    const tactic = ingested.tactics.find((t) => t.review_status === "candidate")!;
    const [firstGap, secondGap] = ingested.gaps.filter((g) => g.status === "candidate");
    expect(firstGap && secondGap).toBeTruthy();
    await lockTacticReview({
      tactic_id: tactic.id,
      review_status: "accepted",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await assignTacticToGap({
      gap_id: firstGap!.id,
      tactic_id: tactic.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await assignTacticToGap({
      gap_id: secondGap!.id,
      tactic_id: tactic.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const createdId = await createProposedTactic({
      name: "Library-only CEA",
      type: "cea",
      description: "Created into the library",
      evidence_question: "What is the cost-effectiveness of Velmara vs SoC?",
      population: "2L",
      intervention: "Velmara",
      comparator: "SoC",
      outcomes: "QALY",
      geography: "US + EU5",
      owner: "A. Rao",
      function: "heor",
      residual_ids: [],
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const workspace = buildPlanWorkspace(await loadState());
    const libraryRow = workspace.availableTactics.find((t) => t.id === tactic.id);
    expect(libraryRow?.gaps.map((g) => g.id).sort()).toEqual([firstGap!.id, secondGap!.id].sort());
    expect(workspace.availableTactics.some((t) => t.id === createdId && t.gaps.length === 0)).toBe(true);
  });

  it("creates a human gap as validated_open without a residual", async () => {
    await resetSeed();
    const id = await createGap({
      statement: "Need ILD characterisation in community oncology clinics after month six.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const state = await loadState();
    const gap = state.gaps.find((g) => g.id === id);
    expect(gap?.status).toBe("validated_open");
    expect(gap?.domain).toBe("unmet_need");
    expect(gap?.status_lock.locked).toBe(true);
    expect(state.residuals.some((r) => r.gap_id === id)).toBe(false);
    const workspace = buildPlanWorkspace(state);
    expect(workspace.unprioritized.some((c) => c.gap_id === id)).toBe(false);
    expect(workspace.openGaps.some((c) => c.gap_id === id)).toBe(true);
    expect(workspace.review.some((c) => c.gap_id === id)).toBe(false);
  });

  it("suggests mappings only after accept, writes coverage on accept, and suppresses rejects", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const ingested = await loadState();
    const gap = ingested.gaps.find(
      (g) =>
        g.status === "candidate" &&
        /elderly|comparative effectiveness/i.test(`${g.name} ${g.statement}`),
    )!;
    const tactic = ingested.tactics.find((t) => t.review_status === "candidate")!;
    expect(gap).toBeTruthy();
    expect(tactic).toBeTruthy();
    expect((await suggestMappings()).length).toBe(0);

    await lockGapStatus({
      gap_id: gap.id,
      status: "validated_open",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect((await suggestMappings()).length).toBe(0);

    await lockTacticReview({
      tactic_id: tactic.id,
      review_status: "accepted",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const suggested = await suggestMappings();
    expect(suggested.some((s) => s.gap_id === gap.id && s.tactic_id === tactic.id)).toBe(true);

    const other = suggested.find((s) => s.tactic_id === tactic.id && s.gap_id === gap.id)!;
    await rejectMapping({
      gap_id: other.gap_id,
      tactic_id: other.tactic_id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect(
      (await suggestMappings()).some((s) => s.gap_id === other.gap_id && s.tactic_id === other.tactic_id),
    ).toBe(false);

    const createdId = await createGap({
      name: "Elderly SoC evidence",
      statement: "Need comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
      domain: "comparative_effectiveness",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const afterCreate = await suggestMappings();
    const pair = afterCreate.find((s) => s.gap_id === createdId && s.tactic_id === tactic.id);
    expect(pair).toBeTruthy();
    expect(pair!.reasons.length).toBeGreaterThanOrEqual(2);
    expect(pair!.reasons.join(" ")).toMatch(/elderly|chart review|comparative|65/i);
    await acceptMapping({
      gap_id: createdId,
      tactic_id: tactic.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const mapped = await loadState();
    expect(mapped.coverages.some((c) => c.gap_id === createdId && c.tactic_id === tactic.id)).toBe(true);
    expect(mapped.coverages.find((c) => c.gap_id === createdId && c.tactic_id === tactic.id)?.stale).toBe(
      true,
    );
    expect(
      (await suggestMappings()).some((s) => s.gap_id === createdId && s.tactic_id === tactic.id),
    ).toBe(false);
  });

  it("locking partial coverage suggests leftover as a new gap; accept creates a child", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const ingested = await loadState();
    expect(buildPlanWorkspace(ingested).residualGapSuggestions.length).toBeGreaterThan(0);
    const gap = ingested.gaps.find(
      (g) =>
        g.status === "candidate" &&
        /elderly|comparative effectiveness/i.test(`${g.name} ${g.statement}`),
    )!;
    const tactic = ingested.tactics.find((t) => t.review_status === "candidate")!;
    expect(gap).toBeTruthy();
    expect(tactic).toBeTruthy();

    await lockGapStatus({
      gap_id: gap.id,
      status: "validated_open",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await lockTacticReview({
      tactic_id: tactic.id,
      review_status: "accepted",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await assignTacticToGap({
      gap_id: gap.id,
      tactic_id: tactic.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect((await suggestResidualGaps()).some((s) => s.parent_gap_id === gap.id)).toBe(false);

    const coverage = (await loadState()).coverages.find(
      (c) => c.gap_id === gap.id && c.tactic_id === tactic.id,
    )!;
    await lockCoverageOverall({
      coverage_id: coverage.id,
      overall: "full",
      rationale: "This tactic answers the question.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect((await suggestResidualGaps()).some((s) => s.parent_gap_id === gap.id)).toBe(false);

    await lockCoverageOverall({
      coverage_id: coverage.id,
      overall: "partial",
      rationale: "Comparator and timing remain thin.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const leftover = (await suggestResidualGaps()).find((s) => s.parent_gap_id === gap.id);
    expect(leftover).toBeTruthy();
    expect(leftover!.statement).not.toBe(gap.statement);
    expect(leftover!.statement).not.toMatch(/^(We need|We still need|It has no)\b/i);
    expect(leftover!.statement).not.toMatch(/[.?!]$/);
    expect((await loadState()).residuals.some((r) => r.gap_id === gap.id)).toBe(true);
    const workspace = buildPlanWorkspace(await loadState());
    expect(workspace.residualGapSuggestions.some((s) => s.parent_gap_id === gap.id)).toBe(true);
    expect(workspace.review.some((c) => c.gap_id === gap.id)).toBe(false);

    const childId = await acceptResidualGap({
      parent_gap_id: gap.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const accepted = await loadState();
    expect(accepted.gaps.find((g) => g.id === childId)?.parent_gap_id).toBe(gap.id);
    expect(accepted.gaps.find((g) => g.id === childId)?.status).toBe("validated_open");
    expect(accepted.gaps.find((g) => g.id === gap.id)?.status).toBe("validated_partial");
    expect((await suggestResidualGaps()).some((s) => s.parent_gap_id === gap.id)).toBe(false);

    const otherGap = ingested.gaps.find((g) => g.status === "candidate" && g.id !== gap.id)!;
    await lockGapStatus({
      gap_id: otherGap.id,
      status: "validated_open",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await assignTacticToGap({
      gap_id: otherGap.id,
      tactic_id: tactic.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const otherCoverage = (await loadState()).coverages.find(
      (c) => c.gap_id === otherGap.id && c.tactic_id === tactic.id,
    )!;
    await lockCoverageOverall({
      coverage_id: otherCoverage.id,
      overall: "limited",
      rationale: "Only a slice of the population is in the chart review.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect((await suggestResidualGaps()).some((s) => s.parent_gap_id === otherGap.id)).toBe(true);
    await rejectResidualGap({
      parent_gap_id: otherGap.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect((await suggestResidualGaps()).some((s) => s.parent_gap_id === otherGap.id)).toBe(false);
    expect((await loadState()).gaps.some((g) => g.parent_gap_id === otherGap.id)).toBe(false);
  });
});
