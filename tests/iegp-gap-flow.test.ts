import { describe, expect, it } from "vitest";
import {
  resetSeed,
  loadState,
  persistState,
  createGap,
  createProposedTactic,
  lockTactic,
  splitPartialGap,
  rewritePartialGap,
  overrideGapStatus,
  validateGap,
  createAddressedGap,
  assignTacticToGap,
  lockCoverageDimension,
  confirmCoverageReview,
  recordMissedTactic,
  createTacticFromGaps,
} from "@/lib/iegp/store";
import {
  buildPlanWorkspace,
  displayedGapStatus,
  gapsReadyForPrioritize,
} from "@/lib/iegp/engine";

async function makePartialGap() {
  await resetSeed();
  const gapId = await createGap({
    name: "Comparative effectiveness versus regional SoC in elderly patients",
    statement: "Need comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
    domain: "comparative_effectiveness",
    actor_name: "A. Rao",
    actor_function: "heor",
  });
  const tacticId = await createProposedTactic({
    name: "Elderly chart review",
    type: "chart_review",
    description: "Chart review in patients aged 65 and over.",
    evidence_question: "What are outcomes of Velmara in elderly patients?",
    population: "Elderly 2L",
    intervention: "Velmara",
    comparator: "To be specified",
    outcomes: "PFS / OS",
    geography: "US + EU5",
    owner: "A. Rao",
    function: "heor",
    residual_ids: [],
    gap_id: gapId,
    actor_name: "A. Rao",
    actor_function: "heor",
  });
  await lockTactic({
    tactic_id: tacticId,
    status: "planned",
    actor_name: "A. Rao",
    actor_function: "heor",
  });
  const gap = (await loadState()).gaps.find((g) => g.id === gapId)!;
  expect(displayedGapStatus(gap)).toBe("validated_partial");
  return { gapId, tacticId };
}

describe("partial split and rewrite", () => {
  it("splits a partial into addressed + open children and retires the original into history", async () => {
    const { gapId, tacticId } = await makePartialGap();
    const result = await splitPartialGap({
      parent_gap_id: gapId,
      addressed_name: "Elderly outcomes covered by the chart review",
      open_name: "Comparator evidence versus regional SoC in frail elderly",
      tactic_id: tacticId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    const original = after.gaps.find((g) => g.id === gapId)!;
    expect(original.retired).toBe(true);
    const addressed = after.gaps.find((g) => g.id === result.addressedId)!;
    const open = after.gaps.find((g) => g.id === result.openId)!;
    expect(displayedGapStatus(addressed)).toBe("validated_addressed");
    expect(displayedGapStatus(open)).toBe("validated_open");
    expect(open.human_validated).toBe(true);
    expect(addressed.human_validated).toBe(true);
    expect(after.gap_versions.some((v) => v.live_gap_id === open.id && v.retired_gap_id === gapId && v.event === "split")).toBe(true);
    expect(after.gap_versions.some((v) => v.live_gap_id === addressed.id && v.retired_gap_id === gapId && v.event === "split")).toBe(true);
    expect(buildPlanWorkspace(after).review.some((c) => c.gap_id === original.id)).toBe(false);
    expect(gapsReadyForPrioritize(after)).toBe(true);
  });

  it("rewrites a partial as Open and keeps the original in version history", async () => {
    const { gapId } = await makePartialGap();
    const liveId = await rewritePartialGap({
      gap_id: gapId,
      name: "Comparative effectiveness versus regional SoC in elderly patients",
      status: "validated_open",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    expect(after.gaps.find((g) => g.id === gapId)?.retired).toBe(true);
    expect(after.gaps.find((g) => g.id === liveId)?.status).toBe("validated_open");
    expect(after.gap_versions.some((v) => v.live_gap_id === liveId && v.retired_gap_id === gapId && v.event === "rewrite")).toBe(true);
  });

  it("rewrites a partial as Addressed only with an accompanying tactic", async () => {
    const { gapId } = await makePartialGap();
    await expect(
      rewritePartialGap({
        gap_id: gapId,
        name: "Fully covered elderly outcomes",
        status: "validated_addressed",
        actor_name: "A. Rao",
        actor_function: "heor",
      }),
    ).rejects.toThrow(/accompanying tactic/i);
  });

  it("refuses to lock Partial, override Partial, or proceed to Prioritize while Partial remains", async () => {
    const { gapId } = await makePartialGap();
    await expect(
      overrideGapStatus({
        gap_id: gapId,
        status: "validated_open",
        actor_name: "A. Rao",
        actor_function: "heor",
        reason: "Trying to lock Partial as Open.",
      }),
    ).rejects.toThrow(/cannot stay/i);
    await expect(
      validateGap({
        gap_id: gapId,
        actor_name: "A. Rao",
        actor_function: "heor",
      }),
    ).rejects.toThrow(/cannot stay/i);
    const state = await loadState();
    expect(gapsReadyForPrioritize(state)).toBe(false);
  });

  it("lets the user add an Addressed gap with a tactic, and requires validation before Prioritize", async () => {
    await resetSeed();
    const tacticId = await createProposedTactic({
      name: "Completed publication",
      type: "publication",
      description: "Manuscript",
      evidence_question: "Is the PFS question closed?",
      population: "2L",
      intervention: "Velmara",
      comparator: "osimertinib",
      outcomes: "PFS",
      geography: "US + EU5",
      owner: "A. Rao",
      function: "heor",
      residual_ids: [],
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await lockTactic({
      tactic_id: tacticId,
      status: "completed",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const addressedId = await createAddressedGap({
      name: "PFS versus osimertinib in the pivotal trial",
      statement: "PFS versus osimertinib in the pivotal trial",
      tactic_id: tacticId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const openId = await createGap({
      statement: "White-space leftover after mapping",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    let state = await loadState();
    expect(displayedGapStatus(state.gaps.find((g) => g.id === addressedId)!)).toBe("validated_addressed");
    expect(gapsReadyForPrioritize(state)).toBe(false);
    await validateGap({
      gap_id: openId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    state = await loadState();
    expect(gapsReadyForPrioritize(state)).toBe(true);
    expect(buildPlanWorkspace(state).review.every((c) => c.gap_status !== "candidate")).toBe(true);
  });

  it("splits with multiple tactics and copies constituent need links onto both children", async () => {
    const { gapId, tacticId } = await makePartialGap();
    const secondTacticId = await createProposedTactic({
      name: "Elderly claims study",
      type: "rwe_study",
      description: "Claims study in patients aged 65 and over.",
      evidence_question: "What are Velmara outcomes in elderly claims?",
      population: "Elderly 2L",
      intervention: "Velmara",
      comparator: "To be specified",
      outcomes: "PFS / OS",
      geography: "US + EU5",
      owner: "A. Rao",
      function: "heor",
      residual_ids: [],
      gap_id: gapId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await lockTactic({
      tactic_id: secondTacticId,
      status: "planned",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const before = await loadState();
    const objectiveId = before.objectives[0]!.id;
    await persistState({
      ...before,
      needs: [
        ...before.needs,
        {
          id: "NEED-SPLIT-001",
          statement: "Need comparative effectiveness versus regional SoC in elderly patients.",
          domain: "comparative_effectiveness",
          stakeholder: "heor",
          objective_id: objectiveId,
          decision_supported: "HTA elderly subgroup",
          geography: "US + EU5",
          population: "Elderly 2L",
          intervention: "Velmara",
          comparator: "Regional SoC",
          outcome: "PFS / OS",
          timing: "2027",
          source_id: "SRC-NONE",
          source_quote: "Need comparative effectiveness versus regional SoC.",
          confidence: 0.8,
          status: "accepted",
          status_lock: {
            locked: true,
            actor_name: "A. Rao",
            actor_function: "heor",
            locked_at: "2026-09-18T00:00:00Z",
            note: null,
          },
        },
      ],
      need_gap_links: [
        ...before.need_gap_links,
        { need_id: "NEED-SPLIT-001", gap_id: gapId, role: "primary" },
      ],
    });
    const result = await splitPartialGap({
      parent_gap_id: gapId,
      addressed_name: "Elderly outcomes covered by existing studies",
      addressed_statement: "Chart review and claims cover elderly outcomes already in hand.",
      open_name: "Comparator evidence versus regional SoC in frail elderly",
      open_statement: "Comparator evidence versus regional SoC in frail elderly remains open.",
      tactic_ids: [tacticId, secondTacticId],
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    const addressedCoverages = after.coverages.filter((c) => c.gap_id === result.addressedId);
    expect(addressedCoverages.map((c) => c.tactic_id).sort()).toEqual([tacticId, secondTacticId].sort());
    expect(addressedCoverages.every((c) => c.overall === "full")).toBe(true);
    expect(
      after.need_gap_links.filter((l) => l.gap_id === result.addressedId && l.need_id === "NEED-SPLIT-001"),
    ).toHaveLength(1);
    expect(
      after.need_gap_links.filter((l) => l.gap_id === result.openId && l.need_id === "NEED-SPLIT-001"),
    ).toHaveLength(1);
    expect(after.gaps.find((g) => g.id === result.addressedId)?.statement).toMatch(/Chart review and claims/);
    expect(after.gaps.find((g) => g.id === result.openId)?.statement).toMatch(/remains open/);
    expect(after.coverages.filter((c) => c.gap_id === result.openId)).toHaveLength(0);
  });

  it("flags sibling coverage needs_review without copying dimension values", async () => {
    await resetSeed();
    const gapA = await createGap({
      name: "Sequencing after osimertinib",
      statement: "Where Velmara sits after osimertinib failure.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const gapB = await createGap({
      name: "HCRU in 2L EGFR-mutant NSCLC",
      statement: "Hospitalisation and ED use in 2L.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const tacticId = await createProposedTactic({
      name: "Prospective registry",
      type: "registry",
      description: "Registry collecting sequencing and HCRU.",
      evidence_question: "What are sequencing and HCRU outcomes?",
      population: "2L",
      intervention: "Velmara",
      comparator: "To be specified",
      outcomes: "Sequencing / HCRU",
      geography: "US + EU5",
      owner: "A. Rao",
      function: "heor",
      residual_ids: [],
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await assignTacticToGap({
      gap_id: gapA,
      tactic_id: tacticId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    await assignTacticToGap({
      gap_id: gapB,
      tactic_id: tacticId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const mapped = await loadState();
    const covA = mapped.coverages.find((c) => c.gap_id === gapA && c.tactic_id === tacticId)!;
    const covB = mapped.coverages.find((c) => c.gap_id === gapB && c.tactic_id === tacticId)!;
    expect(covA.dimensions.relevance.value).toBe("unknown");
    expect(covB.dimensions.relevance.value).toBe("unknown");
    const statusB = displayedGapStatus(mapped.gaps.find((g) => g.id === gapB)!);
    await lockCoverageDimension({
      coverage_id: covA.id,
      dimension: "relevance",
      value: "yes",
      rationale: "Registry addresses the sequencing question.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    const a = after.coverages.find((c) => c.id === covA.id)!;
    const b = after.coverages.find((c) => c.id === covB.id)!;
    expect(a.needs_review).toBe(false);
    expect(a.dimensions.relevance.value).toBe("yes");
    expect(b.needs_review).toBe(true);
    expect(b.dimensions.relevance.value).toBe("unknown");
    expect(b.overall).toBe(covB.overall);
    expect(displayedGapStatus(after.gaps.find((g) => g.id === gapB)!)).toBe(statusB);
    expect(buildPlanWorkspace(after).review.find((c) => c.gap_id === gapB)?.needs_review).toBe(true);
    expect(buildPlanWorkspace(after).review.find((c) => c.gap_id === gapA)?.needs_review).toBe(false);

    await confirmCoverageReview({
      coverage_id: covB.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const confirmed = await loadState();
    expect(confirmed.coverages.find((c) => c.id === covB.id)?.needs_review).toBe(false);
    expect(confirmed.coverages.find((c) => c.id === covB.id)?.dimensions.relevance.value).toBe("unknown");
    expect(displayedGapStatus(confirmed.gaps.find((g) => g.id === gapB)!)).toBe(statusB);
  });
});

describe("Gaps map existing vs record missed vs proposed", () => {
  function missedDraft(name: string, status: "completed" | "ongoing" | "planned") {
    return {
      name,
      type: "rwe_study" as const,
      evidence_question: `${name} question`,
      status,
      actor_name: "A. Rao" as const,
      actor_function: "heor" as const,
    };
  }

  it("maps an existing library tactic onto a gap from the Gaps path", async () => {
    await resetSeed();
    const gapId = await createGap({
      statement: "Need comparative effectiveness versus regional SoC in elderly patients.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const tacticId = await recordMissedTactic(missedDraft("Library claims study", "ongoing"));
    const before = await loadState();
    expect(before.coverages.some((c) => c.gap_id === gapId && c.tactic_id === tacticId)).toBe(false);
    await assignTacticToGap({
      gap_id: gapId,
      tactic_id: tacticId,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    expect(after.coverages.some((c) => c.gap_id === gapId && c.tactic_id === tacticId)).toBe(true);
    expect(after.tactics.find((t) => t.id === tacticId)?.status).toBe("ongoing");
  });

  it("records missed ongoing, completed, and planned tactics and auto-maps them onto the gap", async () => {
    await resetSeed();
    const gapId = await createGap({
      statement: "Need ILD characterisation in community oncology clinics.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const reasons = ["missed_at_ingest", "source_not_uploaded", "remembered_while_reviewing"] as const;
    const statuses = ["ongoing", "completed", "planned"] as const;
    const ids: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const tacticId = await recordMissedTactic({
        ...missedDraft(`Catch-up ${status} study`, status),
        gap_id: gapId,
        catch_up_reason: reasons[index],
      });
      ids.push(tacticId);
    }
    const after = await loadState();
    for (const [index, status] of statuses.entries()) {
      expect(after.tactics.find((t) => t.id === ids[index])?.status).toBe(status);
      expect(after.coverages.some((c) => c.gap_id === gapId && c.tactic_id === ids[index])).toBe(true);
    }
    expect(after.tactics.filter((t) => ids.includes(t.id)).every((t) => t.status !== "proposed")).toBe(true);
  });

  it("rejects proposed from the Gaps create-tactic path", async () => {
    await resetSeed();
    const gapId = await createGap({
      statement: "White-space leftover after mapping",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const draft = {
      name: "Invented chart review",
      type: "chart_review" as const,
      evidence_question: "Would a new chart review close this?",
      gap_id: gapId,
      actor_name: "A. Rao" as const,
      actor_function: "heor" as const,
    };
    await expect(recordMissedTactic({ ...draft, status: "proposed" })).rejects.toThrow(/proposed/i);
    await expect(createTacticFromGaps({ ...draft, status: "proposed" })).rejects.toThrow(
      /Tactics after you prioritize/i,
    );
    await expect(
      createAddressedGap({
        statement: "White-space leftover after mapping",
        missed_name: "Invented chart review",
        missed_type: "chart_review",
        missed_status: "proposed",
        missed_evidence_question: "Would a new chart review close this?",
        actor_name: "A. Rao",
        actor_function: "heor",
      }),
    ).rejects.toThrow(/proposed/i);
    const after = await loadState();
    expect(after.tactics.some((t) => t.name === "Invented chart review")).toBe(false);
    expect(after.coverages.filter((c) => c.gap_id === gapId)).toHaveLength(0);
  });

  it("still requires a tactic when adding an Addressed gap", async () => {
    await resetSeed();
    await expect(
      createAddressedGap({
        statement: "PFS versus osimertinib in the pivotal trial",
        actor_name: "A. Rao",
        actor_function: "heor",
      }),
    ).rejects.toThrow(/accompanying tactic/i);
    const viaMissed = await createAddressedGap({
      statement: "PFS versus osimertinib in the pivotal trial",
      missed_name: "VEL-301 PFS manuscript",
      missed_type: "publication",
      missed_status: "completed",
      missed_evidence_question: "Is PFS versus osimertinib closed?",
      catch_up_reason: "source_not_uploaded",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    expect(displayedGapStatus(after.gaps.find((g) => g.id === viaMissed)!)).toBe("validated_addressed");
    expect(after.coverages.some((c) => c.gap_id === viaMissed)).toBe(true);
    expect(after.tactics.find((t) => t.name === "VEL-301 PFS manuscript")?.status).toBe("completed");
  });
});
