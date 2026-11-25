import { describe, expect, it } from "vitest";
import { inEvaluationIsolation, withEvaluationIsolation } from "@/modules/kernel/evaluation-isolation";
import { recordDecisionExample, similarExamples, type DecisionExample } from "@/modules/kernel/decision-examples";
import { lineageGroups, targetMetrics, subjectFingerprint } from "@/modules/kernel/revision-policy";
import { promotionEligibility, type RevisionEvaluation } from "@/modules/kernel/prompt-revision-evals";

const example: DecisionExample = {
  created_at: "2026-01-01",
  provider_id: null,
  model: null,
  lesson_status: "pending",
  lesson: null,
  rationale: null,
  id: "one",
  workspace_id: "fiction",
  stage: "S8",
  kind: "s8_band",
  subject_id: "g1",
  run_id: "r1",
  actor_principal: "reviewer",
  ai_input: { gap: { statement: "Survival evidence for fictional population." } },
  ai_output: { band: "high" },
  outcome: "edited",
  final: { band: "low" },
};
describe("KAN-265 independent evaluation", () => {
  it("isolates concurrent requests, retrieval and capture before touching storage", async () => {
    expect(inEvaluationIsolation()).toBe(false);
    await withEvaluationIsolation(async () => {
      await Promise.resolve();
      expect(inEvaluationIsolation()).toBe(true);
      expect(await similarExamples({ stage: "S8", text: "fiction", workspace_id: "fiction" })).toEqual([]);
      expect(await recordDecisionExample(example)).toBeNull();
    });
    expect(inEvaluationIsolation()).toBe(false);
  });
  it("connects a restaged subject to its original run through normalized content", () => {
    const restaged = {
      ...example,
      id: "two",
      run_id: "r2",
      subject_id: "g2",
      ai_input: { gap: { statement: " Survival  EVIDENCE for fictional population! " } },
    };
    expect(subjectFingerprint(restaged)).toBe(subjectFingerprint(example));
    expect(lineageGroups([example, restaged])).toHaveLength(1);
  });
  it("withholds a historical correction without frozen review evidence", () => {
    expect(targetMetrics(example)).toEqual([]);
  });
  it("refuses previously passing legacy aggregates without independent paired observations", () => {
    const arm = {
      gold: [{ name: "format", value: 1, denominator: 1 }],
      replay: [{ name: "agreement", value: 1, denominator: 1 }],
      gold_count: 1,
      replay_count: 1,
      combined: 0.5,
    };
    expect(
      promotionEligibility({
        baseline: arm,
        candidate: { ...arm, combined: 1 },
        failures: [],
        comparable: true,
      } as unknown as RevisionEvaluation).eligible,
    ).toBe(false);
  });
  it("refuses unsupported revisions before a model or workspace lookup", async () => {
    const { proposePromptRevision } = await import("@/modules/kernel/prompt-revisions");
    for (const stage of ["S2", "S3", "S4", "S6", "S9"] as const)
      await expect(
        proposePromptRevision({
          stage,
          workspace_id: "fiction",
          exclude_ids: [],
          actor: { name: "fiction", function: "heor" },
        }),
      ).rejects.toThrow(/human target/i);
  });
});
