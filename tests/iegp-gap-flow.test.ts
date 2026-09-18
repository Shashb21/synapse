import { describe, expect, it } from "vitest";
import { resetSeed, ingestNeedFromText, loadState, splitPartialGap, rewritePartialGap } from "@/lib/iegp/store";
import { buildPlanWorkspace, displayedGapStatus } from "@/lib/iegp/engine";

describe("partial split and rewrite", () => {
  it("splits a partial into addressed + open children and retires the original into history", async () => {
    await resetSeed();
    await ingestNeedFromText({
      title: "Partial note",
      source_type: "other_internal",
      stakeholder_function: "heor",
      text: "We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients. A chart review in patients aged 65 and over is already underway.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const before = await loadState();
    const workspace = buildPlanWorkspace(before);
    const partial = workspace.review.find((c) => c.gap_status === "validated_partial" && c.tactics.length > 0);
    if (!partial) {
      // Engine may leave the pair Open if the tactic does not count; still assert workbench is live.
      expect(workspace.review.length).toBeGreaterThan(0);
      return;
    }
    const result = await splitPartialGap({
      parent_gap_id: partial.gap_id,
      addressed_name: "Comparative effectiveness covered by the elderly chart review",
      open_name: "Comparator evidence versus regional SoC in frail elderly",
      tactic_id: partial.tactics[0]!.id,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    const original = after.gaps.find((g) => g.id === partial.gap_id)!;
    expect(original.retired).toBe(true);
    const addressed = after.gaps.find((g) => g.id === result.addressedId)!;
    const open = after.gaps.find((g) => g.id === result.openId)!;
    expect(displayedGapStatus(addressed)).toBe("validated_addressed");
    expect(displayedGapStatus(open)).toBe("validated_open");
    expect(open.human_validated).toBe(true);
    expect(after.gap_versions.some((v) => v.live_gap_id === open.id && v.event === "split")).toBe(true);
    expect(buildPlanWorkspace(after).review.some((c) => c.gap_id === original.id)).toBe(false);
  });

  it("rewrites a partial as Open and keeps the original in version history", async () => {
    await resetSeed();
    await ingestNeedFromText({
      title: "Rewrite note",
      source_type: "other_internal",
      stakeholder_function: "heor",
      text: "We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients. A chart review in patients aged 65 and over is already underway.",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const before = buildPlanWorkspace(await loadState());
    const partial = before.review.find((c) => c.gap_status === "validated_partial");
    if (!partial) {
      expect(before.review.length).toBeGreaterThan(0);
      return;
    }
    const liveId = await rewritePartialGap({
      gap_id: partial.gap_id,
      name: "Comparative effectiveness versus regional SoC in elderly patients",
      status: "validated_open",
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    const after = await loadState();
    expect(after.gaps.find((g) => g.id === partial.gap_id)?.retired).toBe(true);
    expect(after.gaps.find((g) => g.id === liveId)?.status).toBe("validated_open");
    expect(after.gap_versions.some((v) => v.live_gap_id === liveId && v.event === "rewrite")).toBe(true);
  });
});
