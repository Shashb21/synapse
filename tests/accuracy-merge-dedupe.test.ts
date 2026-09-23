import { describe, expect, it } from "vitest";
import {
  claimToMergeCandidate,
  extractStudyIds,
  mergeDedupeCandidates,
} from "@/accuracy/modules/merge-dedupe/engine";

describe("merge/dedupe engine", () => {
  it("extracts NCT and NSCLC study ids", () => {
    expect(extractStudyIds("See NSCLC_CE_04 and NCT01234567 in the plan")).toEqual(
      expect.arrayContaining(["NSCLC_CE_04", "NCT01234567"]),
    );
  });

  it("inserts unmatched candidates", () => {
    const result = mergeDedupeCandidates({
      existing: [],
      incoming: [
        {
          id: "gap_1",
          claim_type: "gap",
          statement: "Need OS evidence in EGFR NSCLC",
          external_id: "NSCLC_CE_01",
        },
      ],
    });
    expect(result.inserted).toBe(1);
    expect(result.decisions[0]?.action).toBe("insert");
  });

  it("merges on external_id instead of re-inserting", () => {
    const result = mergeDedupeCandidates({
      existing: [
        claimToMergeCandidate({
          id: "gap_existing",
          claim_type: "gap",
          statement: "Older wording for CE_01",
          metadata: { external_id: "NSCLC_CE_01" },
        }),
      ],
      incoming: [
        {
          id: "gap_new",
          claim_type: "gap",
          statement: "Need clinical evidence NSCLC_CE_01",
          external_id: "NSCLC_CE_01",
          provenance: [{ block_id: "B2", quote: "NSCLC_CE_01 clinical evidence" }],
        },
      ],
    });
    expect(result.merged).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.decisions[0]).toMatchObject({
      action: "merge",
      matched_id: "gap_existing",
    });
  });

  it("merges tactics sharing an NCT id in the statement", () => {
    const result = mergeDedupeCandidates({
      existing: [
        {
          id: "tac_1",
          claim_type: "tactic",
          statement: "Registry NCT99887766 ongoing",
          status: "ongoing",
        },
      ],
      incoming: [
        {
          id: "tac_2",
          claim_type: "tactic",
          statement: "Follow-up for NCT99887766",
          status: "ongoing",
        },
      ],
    });
    expect(result.merged).toBe(1);
    expect(result.decisions[0]?.matched_id).toBe("tac_1");
  });

  it("flags conflicting committed tactic statuses as contradict", () => {
    const result = mergeDedupeCandidates({
      existing: [
        {
          id: "tac_1",
          claim_type: "tactic",
          statement: "VEL-301 PFS analysis",
          status: "completed",
          external_id: "VEL-301",
        },
      ],
      incoming: [
        {
          id: "tac_2",
          claim_type: "tactic",
          statement: "VEL-301 PFS analysis duplicate",
          status: "ongoing",
          external_id: "VEL-301",
        },
      ],
    });
    expect(result.contradictions).toBe(1);
    expect(result.decisions[0]?.action).toBe("contradict");
  });

  it("dedupes within the incoming batch", () => {
    const result = mergeDedupeCandidates({
      existing: [],
      incoming: [
        {
          id: "g1",
          claim_type: "gap",
          statement: "Need biomarker evidence in 1L",
          external_id: "NSCLC_HI_02",
        },
        {
          id: "g2",
          claim_type: "gap",
          statement: "Need biomarker evidence in first line",
          external_id: "NSCLC_HI_02",
        },
      ],
    });
    expect(result.inserted).toBe(1);
    expect(result.merged).toBe(1);
  });
});
