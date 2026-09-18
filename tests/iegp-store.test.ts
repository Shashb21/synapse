import { describe, expect, it } from "vitest";
import { persistState, resetSeed, resetWorkedExample, loadState, lockGapStatus, lockPriority, ingestNeedFromText, ingestDemoSource, modifyGap, assignTacticToGap, lockTactic, lockTacticReview, completeWizard, createProposedTactic, createGap, acceptMapping, rejectMapping, suggestMappings, lockCoverageOverall, acceptResidualGap, rejectResidualGap, suggestResidualGaps, classifyMappedGap, overrideGapStatus } from "@/lib/iegp/store";
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

  it("seeds the worked example and refuses Addressed without a reason when coverage is not full", async () => {
    const state = await resetWorkedExample();
    expect(state.gaps.length).toBeGreaterThan(8);
    await expect(
      lockGapStatus({
        gap_id: "GAP-ELDERLY-CE",
        status: "validated_addressed",
        actor_name: "Test",
        actor_function: "evidence_lead",
      }),
    ).rejects.toThrow(/reason is required|Cannot lock Addressed/i);
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

  it("ingests a source into mapped gaps with computed status, not a candidate inbox", async () => {
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
    const newGaps = state.gaps.filter(
      (g) => !g.retired && /pneumonitis|community hospitals/i.test(g.statement + g.name),
    );
    expect(newGaps.length).toBeGreaterThan(0);
    expect(newGaps.every((g) => g.status !== "candidate")).toBe(true);
    expect(state.tactics.some((t) => /chart review/i.test(t.name + t.evidence_question))).toBe(true);
    expect(
      state.tactics
        .filter((t) => /chart review/i.test(t.name + t.evidence_question))
        .every((t) => t.review_status === "accepted"),
    ).toBe(true);
    const workspace = buildPlanWorkspace(state);
    expect(workspace.review.length).toBeGreaterThan(0);
    expect(workspace.review.every((c) => c.gap_status !== "candidate")).toBe(true);
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
    expect(state.gaps.some((g) => g.status === "candidate")).toBe(false);
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
    expect(updated?.status).not.toBe("candidate");
  });

  it("reviews extracted tactics and only assigns accepted ones", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const before = await loadState();
    const tactic = before.tactics.find((t) => t.review_status === "accepted");
    expect(tactic).toBeTruthy();
    const already = before.coverages.some(
      (c) => c.gap_id === before.gaps[0]!.id && c.tactic_id === tactic!.id,
    );
    if (!already) {
      await assignTacticToGap({
        gap_id: before.gaps[0]!.id,
        tactic_id: tactic!.id,
        actor_name: "A. Rao",
        actor_function: "heor",
      });
    }
    await expect(
      completeWizard({
        actor_name: "S. Iyer",
        actor_function: "evidence_lead",
      }),
    ).rejects.toThrow(/Validate every live gap/i);
  });

  it("shows mapped tactics on the gaps workbench after ingest", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const ingested = await loadState();
    const workspace = buildPlanWorkspace(ingested);
    expect(workspace.review.length).toBeGreaterThan(0);
    expect(ingested.tactics.every((t) => t.review_status === "accepted")).toBe(true);
    expect(workspace.availableTactics.length).toBeGreaterThan(0);
  });

  it("puts accepted and created tactics in the library so one tactic tags many gaps", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const ingested = await loadState();
    const tactic = ingested.tactics.find((t) => t.review_status === "accepted")!;
    const live = ingested.gaps.filter((g) => !g.retired);
    const [firstGap, secondGap] = live;
    expect(firstGap && secondGap).toBeTruthy();
    if (!ingested.coverages.some((c) => c.gap_id === firstGap!.id && c.tactic_id === tactic.id)) {
      await assignTacticToGap({
        gap_id: firstGap!.id,
        tactic_id: tactic.id,
        actor_name: "A. Rao",
        actor_function: "heor",
      });
    }
    if (!ingested.coverages.some((c) => c.gap_id === secondGap!.id && c.tactic_id === tactic.id)) {
      await assignTacticToGap({
        gap_id: secondGap!.id,
        tactic_id: tactic.id,
        actor_name: "A. Rao",
        actor_function: "heor",
      });
    }
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
    expect(libraryRow?.gaps.map((g) => g.id)).toEqual(expect.arrayContaining([firstGap!.id, secondGap!.id]));
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
    expect(workspace.review.some((c) => c.gap_id === id)).toBe(true);
  });

  it("maps a newly created open gap onto an extracted tactic", async () => {
    await resetSeed();
    await ingestDemoSource({
      demo_id: "heor-interview",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const ingested = await loadState();
    const tactic = ingested.tactics.find((t) => t.review_status === "accepted")!;
    expect(tactic).toBeTruthy();
    const createdId = await createGap({
      name: "Elderly SoC evidence",
      statement: "Need comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
      domain: "comparative_effectiveness",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const afterCreate = await suggestMappings();
    const pair = afterCreate.find((s) => s.gap_id === createdId && s.tactic_id === tactic.id);
    if (pair) {
      await acceptMapping({
        gap_id: createdId,
        tactic_id: tactic.id,
        actor_name: "A. Rao",
        actor_function: "heor",
      });
    }
    const mapped = await loadState();
    expect(mapped.gaps.find((g) => g.id === createdId)?.status).not.toBe("candidate");
  });

  it("refuses to lock Partially Addressed as a lasting status", async () => {
    await persistState(buildSeed());
    await expect(
      classifyMappedGap({
        gap_id: "GAP-ELDERLY-CE",
        status: "validated_partial",
        actor_name: "A. Rao",
        actor_function: "heor",
        note: "Chart review is only a slice; leftover remains.",
      }),
    ).rejects.toThrow(/cannot stay/i);
  });

  it("computes Open for proposed-only joins and Partial for planned evidence; override requires a reason; cancel does not save", async () => {
    await resetSeed();
    const gapId = await createGap({
      statement: "White-space leftover after mapping",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect((await loadState()).gaps.find((g) => g.id === gapId)?.status).toBe("validated_open");

    const tacticId = await createProposedTactic({
      name: "Proposed chart review",
      type: "chart_review",
      description: "Proposed only",
      evidence_question: "Does community care capture the leftover?",
      population: "2L",
      intervention: "Velmara",
      comparator: "SoC",
      outcomes: "ILD",
      geography: "US + EU5",
      owner: "A. Rao",
      function: "heor",
      residual_ids: [],
      gap_id: gapId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect((await loadState()).gaps.find((g) => g.id === gapId)?.status).toBe("validated_open");

    await lockTactic({
      tactic_id: tacticId,
      status: "planned",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const partial = (await loadState()).gaps.find((g) => g.id === gapId)!;
    expect(partial.status).toBe("validated_partial");
    expect(partial.computed_status).toBe("validated_partial");

    await expect(
      overrideGapStatus({
        gap_id: gapId,
        status: "validated_open",
        actor_name: "A. Rao",
        actor_function: "heor",
        reason: "",
      }),
    ).rejects.toThrow(/reason is required/i);
    const cancelled = (await loadState()).gaps.find((g) => g.id === gapId)!;
    expect(cancelled.status).toBe("validated_partial");
    expect(cancelled.status_override).toBeNull();

    await overrideGapStatus({
      gap_id: gapId,
      status: "validated_open",
      actor_name: "A. Rao",
      actor_function: "heor",
      reason: "Joined tactic is off-question; keep as white space.",
    });
    const overridden = (await loadState()).gaps.find((g) => g.id === gapId)!;
    expect(overridden.status).toBe("validated_open");
    expect(overridden.status_override?.reason).toMatch(/off-question/i);
    expect(overridden.status_override?.from).toBe("validated_partial");
    expect(overridden.status_override?.to).toBe("validated_open");
    expect(overridden.status_override?.actor_name).toBe("A. Rao");
  });
});
