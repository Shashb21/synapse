import { describe, expect, it } from "vitest";
import { scoresPassed, aggregateCaseMetrics } from "@/modules/kernel/evals";
import { comparisonKey, compositeScore } from "@/modules/kernel/baselines";
import { needEvalMetrics } from "@/lib/iegp/engine";
import { matchedCriticGain } from "@/modules/kernel/agentic";
import { scoreRecallAgainstTargets } from "@/modules/development/evaluation/pack-recall";
import { promptVersionsFor } from "@/modules/kernel/prompt-versions";

describe("KAN-265 diagnostic comparisons", () => {
  it("leaves empty, invalid and descriptive observations unscored", () => {
    for (const scores of [[], [{ name: "count", value: 1 }], [{ name: "x", value: NaN, target: 1 }]]) {
      expect(scoresPassed(scores)).toBe(false);
      expect(compositeScore(scores)).toBeNull();
    }
    expect(aggregateCaseMetrics([[{ name: "x", value: 1, target: 1 }], []])[0].target).toBeUndefined();
    expect(promptVersionsFor("S8")).toEqual(["v1.0-baseline"]);
  });
  it("binds history to workspace, route, effective prompt, module and case set", () => {
    const lineage = {
      workspace_id: "fiction",
      stage: "S2" as const,
      module_id: "extract",
      module_version: "1",
      route_hash: "route",
      prompt_hash: "prompt",
      case_hash: "cases",
    };
    for (const key of Object.keys(lineage))
      expect(comparisonKey({ ...lineage, [key]: "changed" })).not.toBe(comparisonKey(lineage));
  });
  it("gives a partial must-find match half credit in both precision and recall", () => {
    const metrics = needEvalMetrics(
      [{ kind: "partial", gold_id: "g", extract_id: "e", similarity: 0.4 }],
      [{ id: "g", must_find: true }],
      1,
    );
    expect([metrics.precision, metrics.recall, metrics.composite]).toEqual([0.5, 0.5, 0.5]);
    expect(
      scoreRecallAgainstTargets({ gap_ids: [], tactic_numbers: [], tactic_identifiers: [] }).overall_recall,
    ).toBeNull();
  });
  it("pairs critic observations by subject and omits gain without matched items", () => {
    const first = [
      { subject: "lost", score: 0 },
      { subject: "same", score: 40 },
    ];
    expect(
      matchedCriticGain(first, [
        { subject: "new", score: 90 },
        { subject: "same", score: 50 },
      ])?.value,
    ).toBe(0.1);
    expect(matchedCriticGain(first, [{ subject: "new", score: 90 }])).toBeNull();
  });
});
