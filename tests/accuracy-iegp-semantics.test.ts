import { describe, expect, it } from "vitest";
import {
  gapsEligibleForIdeation,
  tacticAllowedOnGapInFinalPlan,
} from "@/accuracy/domain/iegp-semantics";

describe("IEGP final-plan semantics (BeOne reference behavior)", () => {
  it("only high + open gaps are eligible for ideation", () => {
    const gaps = [
      { id: "G1", status: "open" as const, priority_band: "high" as const },
      { id: "G2", status: "open" as const, priority_band: "medium" as const },
      { id: "G3", status: "addressed" as const, priority_band: "high" as const },
    ];
    expect(gapsEligibleForIdeation(gaps).map((g) => g.id)).toEqual(["G1"]);
  });

  it("allows inventory tactics on covered gaps regardless of priority", () => {
    expect(
      tacticAllowedOnGapInFinalPlan({
        gap: { id: "G2", status: "open", priority_band: "medium" },
        tactic: { id: "T1", origin: "inventory", status: "planned" },
        assignment: { gap_id: "G2", tactic_id: "T1" },
      }),
    ).toBe(true);
  });

  it("allows ideated tactics only on high-priority open gaps", () => {
    expect(
      tacticAllowedOnGapInFinalPlan({
        gap: { id: "G1", status: "open", priority_band: "high" },
        tactic: { id: "T-new", origin: "ideated", status: "proposed" },
        assignment: { gap_id: "G1", tactic_id: "T-new" },
      }),
    ).toBe(true);
    expect(
      tacticAllowedOnGapInFinalPlan({
        gap: { id: "G2", status: "open", priority_band: "medium" },
        tactic: { id: "T-new", origin: "ideated", status: "proposed" },
        assignment: { gap_id: "G2", tactic_id: "T-new" },
      }),
    ).toBe(false);
  });
});
