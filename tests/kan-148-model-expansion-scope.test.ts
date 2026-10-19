import { describe, expect, it } from "vitest";
import { expansionScopeSchema, modelExpansionScope } from "@/lib/iegp/tactic-expansions";

/** KAN-148: a model's loose expansion scope no longer throws away a whole tactic design. */

const scope = (extra: Record<string, unknown>) => ({
  name: "Frail PRO stratum",
  evidence_question: "What is QoL in frail patients?",
  population: "Frail patients aged 70 and over",
  outcomes: "",
  geography: "",
  data_cut: "",
  analysis: "",
  instrument: "EORTC QLQ-C30",
  study_design: "Registry stratum",
  gap_coverage: "Closes the frail PRO gap",
  cost_effort: "Moderate",
  timing: "From registry start",
  feasibility_risks: "Frail enrolment",
  post_hoc: false,
  prospective_enrolment: true,
  protocol_amendment: true,
  start_date: null,
  evidence_available: null,
  ...extra,
});

describe("a model's expansion scope", () => {
  it("reads a clear leading yes or no as a boolean", () => {
    const tidy = modelExpansionScope(scope({ post_hoc: "No. Prospective addition.", prospective_enrolment: "Yes: about 150 patients", protocol_amendment: "true" }));
    expect(expansionScopeSchema.parse(tidy)).toMatchObject({ post_hoc: false, prospective_enrolment: true, protocol_amendment: true });
  });

  it("completes a month and blanks a date it cannot read", () => {
    const tidy = modelExpansionScope(scope({ start_date: "2027-06", evidence_available: "Q2 2028" }));
    expect(expansionScopeSchema.parse(tidy)).toMatchObject({ start_date: "2027-06-01", evidence_available: null });
  });

  it("leaves prose or a blank yes/no invalid, so the model is asked again", () => {
    expect(expansionScopeSchema.safeParse(modelExpansionScope(scope({ protocol_amendment: "Required to extend follow-up" }))).success).toBe(false);
    expect(expansionScopeSchema.safeParse(modelExpansionScope(scope({ post_hoc: "" }))).success).toBe(false);
  });

  it("passes anything that is not an object through untouched", () => {
    expect(modelExpansionScope(null)).toBeNull();
    expect(modelExpansionScope("x")).toBe("x");
  });
});
