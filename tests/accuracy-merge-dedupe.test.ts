import { describe, expect, it } from "vitest";
import {
  extractDeterministicIds,
  identityKeys,
  mergeDedupeCandidates,
  packsMayMerge,
  type MergeCandidate,
} from "@/accuracy/modules/merge-dedupe/engine";

const BGB = "beone-bgb-58067-prmt5i";
const TISLE = "beone-tislelizumab-iegp";

function candidate(partial: Partial<MergeCandidate> & Pick<MergeCandidate, "id" | "claim_type" | "statement">): MergeCandidate {
  return {
    validated: false,
    status: "draft",
    source_file_id: "src-1",
    reference_pack_id: null,
    external_id: null,
    tactic_status: null,
    provenance: [],
    created_at: "2026-09-23T00:00:00.000Z",
    ...partial,
  };
}

describe("merge / dedupe engine", () => {
  it("extracts strong study and gap identifiers", () => {
    expect(extractDeterministicIds("NSCLC_CE_01 CNS Differentiation")).toContain("nsclc-ce-01");
    expect(extractDeterministicIds("RATIONALE-305 HRQoL")).toContain("rationale-305");
    expect(extractDeterministicIds("NCT01234567 ongoing")).toContain("nct01234567");
    expect(extractDeterministicIds("G:1 primary ITT")).toContain("g:1");
  });

  it("merges gaps that share NSCLC_CE_01 in the same pack", () => {
    const result = mergeDedupeCandidates([
      candidate({
        id: "gap_a",
        claim_type: "gap",
        statement: "Need CNS outcomes in EGFR NSCLC",
        external_id: "NSCLC_CE_01",
        reference_pack_id: BGB,
      }),
      candidate({
        id: "gap_b",
        claim_type: "gap",
        statement: "CNS Differentiation evidence gap",
        external_id: "NSCLC_CE_01",
        reference_pack_id: BGB,
        provenance: [
          { source_file_id: "src-1", block_id: "b2", quote: "NSCLC_CE_01 CNS Differentiation" },
        ],
      }),
    ]);
    expect(Object.keys(result.absorbed)).toHaveLength(1);
    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]?.external_id).toBe("NSCLC_CE_01");
    expect(result.survivors[0]?.provenance).toHaveLength(1);
    expect(result.merges[0]?.reason).toBe("identity");
  });

  it("does not merge the same gap id across BeOne gold packs", () => {
    expect(
      packsMayMerge(
        candidate({
          id: "g1",
          claim_type: "gap",
          statement: "Need CNS outcomes",
          external_id: "NSCLC_CE_01",
          reference_pack_id: BGB,
        }),
        candidate({
          id: "g2",
          claim_type: "gap",
          statement: "Need CNS outcomes",
          external_id: "NSCLC_CE_01",
          reference_pack_id: TISLE,
        }),
      ),
    ).toBe(false);

    const result = mergeDedupeCandidates([
      candidate({
        id: "gap_bgb",
        claim_type: "gap",
        statement: "Need CNS outcomes in EGFR NSCLC",
        external_id: "NSCLC_CE_01",
        reference_pack_id: BGB,
      }),
      candidate({
        id: "gap_tisle",
        claim_type: "gap",
        statement: "Need CNS outcomes in EGFR NSCLC",
        external_id: "NSCLC_CE_01",
        reference_pack_id: TISLE,
      }),
    ]);
    expect(result.absorbed).toEqual({});
    expect(result.survivors.map((s) => s.id).sort()).toEqual(["gap_bgb", "gap_tisle"]);
  });

  it("does not collapse BGB tactic numbers into Tisle G: identifiers", () => {
    const result = mergeDedupeCandidates([
      candidate({
        id: "tac_bgb",
        claim_type: "tactic",
        statement: "CNS-specific outcomes within pivotal trial",
        external_id: "2",
        reference_pack_id: BGB,
        tactic_status: "planned",
        status: "planned",
      }),
      candidate({
        id: "tac_tisle",
        claim_type: "tactic",
        statement: "TIS Plus Chemo vs PBO Plus Chemo as 1L Treatment of Advanced GC/GEJC",
        external_id: "G:1",
        reference_pack_id: TISLE,
        tactic_status: "planned",
        status: "planned",
      }),
    ]);
    expect(result.survivors).toHaveLength(2);
    expect(identityKeys(result.survivors.find((s) => s.id === "tac_tisle")!)).toContain("g:1");
    expect(identityKeys(result.survivors.find((s) => s.id === "tac_bgb")!)).not.toContain("2");
  });

  it("merges exact statements in the same pack and unions provenance", () => {
    const result = mergeDedupeCandidates([
      candidate({
        id: "gap_1",
        claim_type: "gap",
        statement: "Need RWE on long term tislelizumab efficacy in Caucasian patients",
        reference_pack_id: TISLE,
        provenance: [{ source_file_id: "s", block_id: "b1", quote: "Caucasian patients" }],
      }),
      candidate({
        id: "gap_2",
        claim_type: "gap",
        statement: "Need RWE on long term tislelizumab efficacy in Caucasian patients",
        reference_pack_id: TISLE,
        provenance: [{ source_file_id: "s", block_id: "b2", quote: "long term" }],
      }),
    ]);
    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]?.provenance).toHaveLength(2);
    expect(result.merges[0]?.reason).toBe("statement");
  });

  it("merges conservative same-block overlap with near-identical wording", () => {
    const result = mergeDedupeCandidates([
      candidate({
        id: "tac_1",
        claim_type: "tactic",
        statement: "Registry follow-up for pneumonitis rates in community hospitals",
        reference_pack_id: BGB,
        tactic_status: "ongoing",
        provenance: [{ source_file_id: "s", block_id: "row-12", quote: "pneumonitis rates" }],
      }),
      candidate({
        id: "tac_2",
        claim_type: "tactic",
        statement: "Registry follow-up for pneumonitis rates in community hospitals ongoing",
        reference_pack_id: BGB,
        tactic_status: "ongoing",
        provenance: [{ source_file_id: "s", block_id: "row-12", quote: "community hospitals" }],
      }),
    ]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges[0]?.reason).toBe("block_overlap");
  });

  it("surfaces conflicting tactic statuses instead of auto-picking", () => {
    const result = mergeDedupeCandidates([
      candidate({
        id: "tac_live",
        claim_type: "tactic",
        statement: "Extended follow-up within pivotal trials",
        external_id: "NCT01234567",
        reference_pack_id: BGB,
        tactic_status: "ongoing",
        status: "ongoing",
      }),
      candidate({
        id: "tac_dead",
        claim_type: "tactic",
        statement: "Extended follow-up within pivotal trials (cancelled)",
        external_id: "NCT01234567",
        reference_pack_id: BGB,
        tactic_status: "cancelled",
        status: "cancelled",
      }),
    ]);
    expect(result.survivors).toHaveLength(2);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]?.reason).toBe("conflicting_tactic_status");
    expect(result.absorbed).toEqual({});
  });

  it("does not merge a gap with a tactic that shares an identifier", () => {
    const result = mergeDedupeCandidates([
      candidate({
        id: "gap_1",
        claim_type: "gap",
        statement: "Need CNS outcomes NSCLC_CE_01",
        external_id: "NSCLC_CE_01",
        reference_pack_id: BGB,
      }),
      candidate({
        id: "tac_1",
        claim_type: "tactic",
        statement: "CNS-specific outcomes NSCLC_CE_01",
        external_id: "NSCLC_CE_01",
        reference_pack_id: BGB,
        tactic_status: "planned",
      }),
    ]);
    expect(result.survivors).toHaveLength(2);
  });
});
