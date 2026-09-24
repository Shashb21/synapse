import { describe, expect, it } from "vitest";
import {
  completenessVerdictSchema,
  excerptFromBlock,
  flagsFromVerdicts,
  selectBlocksToJudge,
  type AuditBlockLite,
  type CompletenessVerdict,
} from "@/accuracy/modules/completeness-audit/engine";

const blocks: AuditBlockLite[] = [
  {
    id: "b1",
    source_file_id: "src1",
    index: 0,
    kind: "prose",
    text: "Unmet evidence need for comparative effectiveness in elderly NSCLC patients after progression.",
  },
  {
    id: "b2",
    source_file_id: "src1",
    index: 1,
    kind: "prose",
    text: "Registry follow-up already covers pneumonitis rates in community hospitals.",
  },
  { id: "b-empty", source_file_id: "src1", index: 2, kind: "caption", text: "   " },
  { id: "b-title", source_file_id: "src1", index: 3, kind: "heading", text: "Evidence gaps: ESCC" },
];

describe("completeness audit bookkeeping (facts only)", () => {
  it("settles cited, resolved and empty blocks and sends everything else to the critic", () => {
    const selection = selectBlocksToJudge({
      blocks,
      claims: [
        {
          id: "tac1",
          claim_type: "tactic",
          statement: "Registry follow-up",
          provenance: [{ block_id: "b2" }],
        },
      ],
      resolved_block_ids: [],
    });
    expect(selection.cited).toBe(1);
    expect(selection.empty).toBe(1);
    // Headings are not skipped by rule: the critic decides whether they are chrome.
    expect(selection.to_judge.map((b) => b.id)).toEqual(["b1", "b-title"]);
  });

  it("excludes resolved block ids", () => {
    const selection = selectBlocksToJudge({ blocks, claims: [], resolved_block_ids: ["b1"] });
    expect(selection.resolved).toBe(1);
    expect(selection.to_judge.map((b) => b.id)).not.toContain("b1");
  });

  it("does not treat lexical overlap as coverage", () => {
    const selection = selectBlocksToJudge({
      blocks: [blocks[0]!],
      claims: [{ id: "g", claim_type: "gap", statement: blocks[0]!.text, provenance: null }],
    });
    expect(selection.to_judge.map((b) => b.id)).toEqual(["b1"]);
  });

  it("flags only what the critic called a miss, with its claim type and rationale", () => {
    const verdicts = new Map<string, CompletenessVerdict>([
      ["b1", { block_id: "b1", missed: true, claim_type: "gap", rationale: "Uncaptured elderly comparative need." }],
      ["b-title", { block_id: "b-title", missed: false, claim_type: null, rationale: "Chapter divider." }],
    ]);
    const flags = flagsFromVerdicts(blocks, verdicts);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      block_id: "b1",
      suggested: "gap",
      reason: "Uncaptured elderly comparative need.",
    });
  });

  it("rejects a miss verdict without a claim type or rationale", () => {
    expect(
      completenessVerdictSchema.safeParse({ block_id: "b", missed: true, claim_type: null, rationale: "x" })
        .success,
    ).toBe(false);
    expect(
      completenessVerdictSchema.safeParse({ block_id: "b", missed: false, claim_type: null, rationale: " " })
        .success,
    ).toBe(false);
    expect(
      completenessVerdictSchema.safeParse({ block_id: "b", missed: true, claim_type: "tactic", rationale: "ok" })
        .success,
    ).toBe(true);
  });

  it("excerpt truncates long text", () => {
    const long = "word ".repeat(80);
    const ex = excerptFromBlock(long, 40);
    expect(ex.length).toBeLessThanOrEqual(40);
    expect(ex.endsWith("…")).toBe(true);
  });
});
