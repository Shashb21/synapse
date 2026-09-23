import { describe, expect, it } from "vitest";
import {
  accuracyEvalReferencePack,
  candidatesFromGold,
  mustFindForPack,
  scorePackRecall,
} from "@/accuracy/eval/reference-gold";
import { sourceRecallCandidatesFromTactics } from "@/accuracy/eval/pack-recall";
import { scoreGapIdRecall } from "@/accuracy/modules/need-extract/module";

describe("pack recall scoring", () => {
  it("scores empty candidates as zero recall when targets exist", () => {
    const score = scorePackRecall("beone-bgb-58067-prmt5i", {});
    expect(score.gap_ids.targets).toBe(43);
    expect(score.gap_ids.found).toHaveLength(0);
    expect(score.gap_ids.recall).toBe(0);
    expect(score.tactic_numbers.targets).toBe(36);
    expect(score.tactic_numbers.recall).toBe(0);
    expect(score.overall_recall).toBe(0);
  });

  it("scores partial gap id recall", () => {
    const score = scorePackRecall("beone-bgb-58067-prmt5i", {
      gap_ids: ["NSCLC_CE_01", "NSCLC_CE_02", "NOT_A_GAP"],
    });
    expect(score.gap_ids.found).toEqual(["NSCLC_CE_01", "NSCLC_CE_02"]);
    expect(score.gap_ids.missing).toHaveLength(41);
    expect(score.gap_ids.recall).toBeCloseTo(2 / 43, 5);
  });

  it("oracle from filled gold yields perfect BGB and Tisle recall", () => {
    const bgb = scorePackRecall("beone-bgb-58067-prmt5i", candidatesFromGold("beone-bgb-58067-prmt5i"));
    expect(bgb.gap_ids.recall).toBe(1);
    expect(bgb.tactic_numbers.recall).toBe(1);
    expect(bgb.overall_recall).toBe(1);

    const tisle = scorePackRecall(
      "beone-tislelizumab-iegp",
      candidatesFromGold("beone-tislelizumab-iegp"),
    );
    expect(tisle.tactic_identifiers.targets).toBe(21);
    expect(tisle.tactic_identifiers.recall).toBe(1);
  });

  it("accuracyEvalReferencePack returns targets_only without candidates", async () => {
    const result = await accuracyEvalReferencePack("beone-bgb-58067-prmt5i");
    expect(result.status).toBe("targets_only");
    expect(result.targets.gap_ids).toHaveLength(43);
    expect(result.recall).toBeUndefined();
  });

  it("accuracyEvalReferencePack scores with oracleFromGold", async () => {
    const result = await accuracyEvalReferencePack("beone-bgb-58067-prmt5i", {
      oracleFromGold: true,
    });
    expect(result.status).toBe("scored");
    expect(result.recall?.overall_recall).toBe(1);
  });

  it("scoreGapIdRecall stays compatible with need_extract", () => {
    const targets = mustFindForPack("beone-bgb-58067-prmt5i").gap_ids;
    const all = scoreGapIdRecall({
      packId: "beone-bgb-58067-prmt5i",
      extractedExternalIds: targets,
    });
    expect(all.recall).toBe(1);
    expect(all.missing).toHaveLength(0);
  });

  it("excludes ideated tactics from source-recall candidates", () => {
    const mixed = sourceRecallCandidatesFromTactics([
      { origin: "inventory", number: 1, identifier: "G:1" },
      { origin: "ideated", number: 1, identifier: "G:1" },
      { origin: "ideated", number: 99, identifier: "G:99" },
    ]);
    expect(mixed.tactic_numbers).toEqual([1]);
    expect(mixed.tactic_identifiers).toEqual(["G:1"]);

    const inventoryOnly = scorePackRecall(
      "beone-tislelizumab-iegp",
      sourceRecallCandidatesFromTactics([
        { origin: "inventory", identifier: "G:1" },
        { origin: "ideated", identifier: "G:1" },
      ]),
    );
    expect(inventoryOnly.tactic_identifiers.found).toEqual(["G:1"]);
    expect(inventoryOnly.tactic_identifiers.found).toHaveLength(1);
  });
});
