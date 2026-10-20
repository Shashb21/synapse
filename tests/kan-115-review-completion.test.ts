import { expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import { buildPlanWorkspace, reviewGapTasks, filterReviewGapCards } from "@/lib/iegp/engine";
import { persistState, loadState, confirmCoverageReview, clearNewSourceFlag, validateGap } from "@/lib/iegp/store";

it("completes mapping, source and status independently through real store mutations", async () => {
  const seed = buildSeed();
  const gap = seed.gaps.find(g => g.status === "validated_open" && seed.coverages.some(c => c.gap_id === g.id))!;
  expect(gap).toBeDefined();
  gap.human_validated = false;
  gap.new_source_at = "2026-10-15T10:00:00Z";
  for (const coverage of seed.coverages.filter(c => c.gap_id === gap.id)) {
    coverage.needs_review = true;
    coverage.overall = "not_relevant";
  }
  await persistState(seed);
  const actor = { actor_name: "KAN-115", actor_function: "medical_affairs" as const };
  const current = async () => buildPlanWorkspace(await loadState()).review.find(c => c.gap_id === gap.id)!;
  expect(reviewGapTasks(await current())).toEqual(["Review tactic mappings", "Review new source", "Confirm status"]);
  await validateGap({ gap_id: gap.id, ...actor });
  expect(reviewGapTasks(await current())).toEqual(["Review tactic mappings", "Review new source"]);
  expect(filterReviewGapCards([await current()], "needs_attention")).toHaveLength(1);
  // Exercise the primary-action order with the same independent flags still outstanding.
  await persistState(seed);
  for (const coverage of seed.coverages.filter(c => c.gap_id === gap.id)) {
    await confirmCoverageReview({ coverage_id: coverage.id, note: "Reviewed the tactic mapping against the gap", ...actor });
  }
  expect(reviewGapTasks(await current())).toEqual(["Review new source", "Confirm status"]);
  await clearNewSourceFlag({ gap_id: gap.id, rationale: "Checked the new source", ...actor });
  expect(reviewGapTasks(await current())).toEqual(["Confirm status"]);
  expect(filterReviewGapCards([await current()], "needs_attention")).toHaveLength(1);
  await validateGap({ gap_id: gap.id, ...actor });
  expect(reviewGapTasks(await current())).toEqual([]);
  expect(filterReviewGapCards([await current()], "needs_attention")).toHaveLength(0);
});
