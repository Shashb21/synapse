import { describe, expect, it } from "vitest";
import {
  resetSeed,
  loadState,
  createGap,
  createProposedTactic,
  lockTactic,
  splitPartialGap,
  rewritePartialGap,
  overrideGapStatus,
  validateGap,
  createAddressedGap,
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
});
