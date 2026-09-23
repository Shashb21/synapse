import { describe, expect, it } from "vitest";
import {
  filterInventoryForSourceRecall,
  gapsEligibleForIdeation,
  ideatedTacticExpectsNoSourceQuote,
  includeTacticInSourceRecall,
  looksLikeInventoryIdentifier,
  resolvePriorityBand,
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

  it("excludes unvalidated high open gaps from ideation", () => {
    expect(
      gapsEligibleForIdeation([
        { id: "G1", status: "open", priority_band: "high", validated: false },
        { id: "G2", status: "open", priority_band: "high", validated: true },
      ]).map((g) => g.id),
    ).toEqual(["G2"]);
  });

  it("treats critical as the high band", () => {
    expect(resolvePriorityBand("critical")).toBe("high");
    expect(resolvePriorityBand("HIGH")).toBe("high");
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

  it("keeps source-recall on inventory origin only", () => {
    expect(ideatedTacticExpectsNoSourceQuote("ideated")).toBe(true);
    expect(ideatedTacticExpectsNoSourceQuote("inventory")).toBe(false);
    expect(includeTacticInSourceRecall("inventory")).toBe(true);
    expect(includeTacticInSourceRecall("ideated")).toBe(false);
    expect(
      filterInventoryForSourceRecall([
        { id: "T1", origin: "inventory" as const },
        { id: "T2", origin: "ideated" as const },
      ]).map((t) => t.id),
    ).toEqual(["T1"]);
    expect(looksLikeInventoryIdentifier("G:21")).toBe(true);
    expect(looksLikeInventoryIdentifier("NSCLC_CE_01")).toBe(true);
    expect(looksLikeInventoryIdentifier("Prospective OS follow-up")).toBe(false);
  });
});
