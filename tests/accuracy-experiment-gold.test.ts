import { describe, expect, it } from "vitest";
import { evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";

describe("evaluateExperimentVersion", () => {
  it("matches a gap by stable external ID and exact statement", () => {
    const result = evaluateExperimentVersion({
      pack_id: "beone-bgb-58067-prmt5i", call_kind: "need_extract",
      output: { gaps: [{ external_id: "NSCLC_CE_01", statement: "BGB-58067's long-term data on efficacy, quality-adjusted survival outcomes, safety and tolerability profile patterns" }] },
    });
    expect(result.outcomes).toContainEqual(expect.objectContaining({ outcome: "found", gold_item_key: "NSCLC_CE_01", model_item_index: 0 }));
    expect(result.score).toMatchObject({ found: 1, missed: 42, wrong: 0, precision: 1 });
  });

  it("matches narrative gaps without a stable ID", () => {
    const statement = "Need for RWE on long term tislelizumab efficacy in Caucasian patients to support access and comparison";
    const result = evaluateExperimentVersion({
      pack_id: "beone-tislelizumab-iegp", call_kind: "need_extract", output: { gaps: [{ statement }] },
    });
    expect(result.outcomes).toContainEqual(expect.objectContaining({ outcome: "found", model_item_index: 0 }));
  });

  it("records partial text matches without adding exact-match score credit", () => {
    const result = evaluateExperimentVersion({
      pack_id: "beone-bgb-58067-prmt5i", call_kind: "need_extract",
      output: { gaps: [{ external_id: "NSCLC_CE_01", statement: "BGB-58067 long-term efficacy safety tolerability data" }] },
    });
    expect(result.outcomes).toContainEqual(expect.objectContaining({ outcome: "partial", gold_item_key: "NSCLC_CE_01" }));
    expect(result.score?.found).toBe(0);
  });

  it("scores inventory tactics using the module's id and name contract", () => {
    const exactName = "Extended follow-up and planned long-term, post-hoc analyses within pivotal trials on key subgroups and long-term responder profiles";
    const exact = evaluateExperimentVersion({
      pack_id: "beone-bgb-58067-prmt5i", call_kind: "inventory_extract",
      output: { tactics: [{ id: "generated-tactic-id", name: exactName }] },
    });
    const narrative = evaluateExperimentVersion({
      pack_id: "beone-bgb-58067-prmt5i", call_kind: "inventory_extract",
      output: { tactics: [{ id: "generated-tactic-id", name: exactName }] },
    });
    const partial = evaluateExperimentVersion({
      pack_id: "beone-bgb-58067-prmt5i", call_kind: "inventory_extract",
      output: { tactics: [{ id: "generated-tactic-id", name: `${exactName} reviewed` }] },
    });
    expect(exact.outcomes).toContainEqual(expect.objectContaining({ outcome: "found", model_item_index: 0 }));
    expect(narrative.outcomes).toContainEqual(expect.objectContaining({ outcome: "found", model_item_index: 0 }));
    expect(partial.outcomes).toContainEqual(expect.objectContaining({ outcome: "partial", model_item_index: 0 }));
  });

  it("records extra model items as wrong and absent gold items as missed", () => {
    const result = evaluateExperimentVersion({
      pack_id: "beone-bgb-58067-prmt5i", call_kind: "need_extract",
      output: { gaps: [{ external_id: "unknown", statement: "Made up need" }] },
    });
    expect(result.outcomes).toContainEqual(expect.objectContaining({ outcome: "wrong", model_item_index: 0 }));
    expect(result.outcomes.filter((item) => item.outcome === "missed")).toHaveLength(43);
  });

  it("retains malformed output and model errors without pretending to score them", () => {
    const malformed = evaluateExperimentVersion({ pack_id: "beone-bgb-58067-prmt5i", call_kind: "need_extract", output: { gaps: "wrong" } });
    const errored = evaluateExperimentVersion({ pack_id: "beone-bgb-58067-prmt5i", call_kind: "need_extract", output: null, output_error: "provider timeout" });
    expect(malformed.errors).toContain("Expected output.gaps to be an array.");
    expect(malformed.score).toBeUndefined();
    expect(errored.errors).toContain("provider timeout");
    expect(errored.score).toBeUndefined();
  });

  it("rejects malformed array items and malformed non-applicable outputs", () => {
    const malformedItem = evaluateExperimentVersion({ pack_id: "beone-bgb-58067-prmt5i", call_kind: "need_extract", output: { gaps: [null] } });
    const malformedOther = evaluateExperimentVersion({ pack_id: "beone-bgb-58067-prmt5i", call_kind: "merge_dedupe", output: null });
    expect(malformedItem.status).toBe("invalid_output");
    expect(malformedItem.errors[0]).toContain("gaps[0]");
    expect(malformedOther.status).toBe("invalid_output");
    expect(malformedOther.output_shape.valid).toBe(false);
  });

  it("records shape but omits scores when gold does not apply to the call kind", () => {
    const result = evaluateExperimentVersion({ pack_id: "beone-bgb-58067-prmt5i", call_kind: "merge_dedupe", output: { merged: 1 } });
    expect(result.status).toBe("gold_not_applicable");
    expect(result.score).toBeUndefined();
  });
});
