import { describe, expect, it } from "vitest";
import {
  auditCompleteness,
  blockOverlapsStatement,
  excerptFromBlock,
  suggestClaimType,
} from "@/accuracy/modules/completeness-audit/engine";

describe("completeness audit engine", () => {
  it("flags auditable blocks that are neither cited nor overlapping", () => {
    const flags = auditCompleteness({
      blocks: [
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
        {
          id: "b-empty",
          source_file_id: "src1",
          index: 2,
          kind: "caption",
          text: "Icon master slide decorative only",
        },
        {
          id: "b-short",
          source_file_id: "src1",
          index: 3,
          kind: "prose",
          text: "Too short",
        },
      ],
      claims: [
        {
          id: "tac1",
          claim_type: "tactic",
          statement: "Registry follow-up already covers pneumonitis rates in community hospitals.",
          provenance: [{ block_id: "b2" }],
        },
      ],
    });
    expect(flags.map((f) => f.block_id)).toEqual(["b1"]);
    expect(flags[0]?.suggested).toBe("gap");
    expect(flags[0]?.excerpt).toMatch(/comparative effectiveness/i);
  });

  it("treats lexical overlap as covered even without provenance", () => {
    const flags = auditCompleteness({
      blocks: [
        {
          id: "b1",
          source_file_id: "src1",
          index: 0,
          kind: "table_row",
          text: "NSCLC_12 Comparative effectiveness elderly EGFR TKI versus chemotherapy SoC",
        },
      ],
      claims: [
        {
          id: "gap1",
          claim_type: "gap",
          statement: "Comparative effectiveness elderly EGFR TKI versus chemotherapy SoC",
          provenance: null,
        },
      ],
    });
    expect(flags).toHaveLength(0);
  });

  it("excludes resolved block ids", () => {
    const flags = auditCompleteness({
      blocks: [
        {
          id: "b1",
          source_file_id: "src1",
          index: 0,
          kind: "list_item",
          text: "Planned advisory board on sequencing after second-line failure in GC/GEJ.",
        },
      ],
      claims: [],
      resolved_block_ids: ["b1"],
    });
    expect(flags).toHaveLength(0);
  });

  it("suggests tactic for inventory-flavored table rows", () => {
    expect(
      suggestClaimType({
        id: "b",
        source_file_id: "s",
        index: 0,
        kind: "table_row",
        text: "Ongoing phase 3 trial of tislelizumab plus chemotherapy",
      }),
    ).toBe("tactic");
  });

  it("excerpt truncates long text", () => {
    const long = "word ".repeat(80);
    const ex = excerptFromBlock(long, 40);
    expect(ex.length).toBeLessThanOrEqual(40);
    expect(ex.endsWith("…")).toBe(true);
  });

  it("blockOverlapsStatement requires substantial token hit ratio", () => {
    expect(
      blockOverlapsStatement(
        "Comparative effectiveness elderly EGFR",
        "Comparative effectiveness elderly EGFR TKI",
      ),
    ).toBe(true);
    expect(blockOverlapsStatement("Totally unrelated prose about diet", "EGFR TKI elderly")).toBe(
      false,
    );
  });
});
