import { describe, expect, it } from "vitest";
import { coverageDecisionSchema, coverageDecideInputSchema } from "@/accuracy/modules/coverage-decide/module";

describe("coverage decision schema", () => {
  it("keeps pending explicit", () => {
    expect(coverageDecisionSchema.parse({ gap_id: "G1", tactic_id: "T1", overall: "pending",
      quote_block_ids: [], confidence: 0, rationale: "Missing facts" }).overall).toBe("pending");
  });
  it("retains factual tokens through the module input boundary", () => {
    const facts = { gap: { statement: "Need OS", structured: {}, factual_revision: "gap-token", fields: { category: "safety" } },
      tactic: { statement: "Registry", structured: {}, lifecycle: "ongoing", factual_revision: "tactic-token", fields: { evidence_question: "OS?" } } };
    expect(coverageDecideInputSchema.parse({ workspace_id: "ws", gap_id: "gap", tactic_id: "tac", block_bundle_ids: [], facts }).facts).toEqual(facts);
  });
  it("parses a locked decision object", () => {
    const row = coverageDecisionSchema.parse({
      gap_id: "G1",
      tactic_id: "T1",
      overall: "partial",
      quote_block_ids: ["B1"],
      confidence: 0.72,
      rationale: "Registry covers population only",
    });
    expect(row.overall).toBe("partial");
  });
});
