import { describe, expect, it } from "vitest";
import {
  parsePlanningContext,
  prioritizationContextFromState,
} from "@/lib/iegp/planning-context";
import { buildBlankWorkspace } from "@/lib/iegp/blank";

describe("planning context", () => {
  it("parses questionnaire fields for S8", () => {
    const ctx = parsePlanningContext({
      asset_name: "Nova",
      inn: "novamab",
      indication: "RA",
      geography: "US",
      launch_timeline: "2028",
      competitor_positioning: "vs JAK class",
      key_decision: "HTA",
      decision_date: "2028-06-01",
      company_situation: "Phase III readout pending",
      strategic_importance: 4,
    });
    const state = buildBlankWorkspace();
    state.asset.planning_context = ctx;
    const forS8 = prioritizationContextFromState(state);
    expect(forS8.launch_timeline).toBe("2028");
    expect(forS8.competitor_pressure).toMatch(/JAK/);
    expect(forS8.strategic_importance).toBe(4);
  });
});
