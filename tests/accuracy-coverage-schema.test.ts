import { describe, expect, it } from "vitest";
import { coverageDecisionSchema } from "@/accuracy/modules/coverage-decide/module";

describe("coverage decision schema", () => {
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
