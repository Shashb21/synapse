import { describe, expect, it } from "vitest";
import {
  accuracyEvalReferencePack,
  listReferencePacks,
  loadReferenceGold,
  loadReferenceManifest,
  mustFindForPack,
} from "@/accuracy/eval/reference-gold";

describe("reference gold packs", () => {
  it("loads manifest and per-pack gold/gaps.json + gold/tactics.json", () => {
    expect(loadReferenceManifest().packs).toHaveLength(2);
    expect(listReferencePacks().map((p) => p.id)).toEqual([
      "beone-bgb-58067-prmt5i",
      "beone-tislelizumab-iegp",
    ]);

    const bgbGold = loadReferenceGold("beone-bgb-58067-prmt5i");
    expect(bgbGold.gaps.must_find_gap_ids).toHaveLength(43);
    expect(bgbGold.tactics.must_find_tactic_numbers?.length).toBeGreaterThanOrEqual(36);

    const tisleGold = loadReferenceGold("beone-tislelizumab-iegp");
    expect(tisleGold.tactics.must_find_tactic_identifiers).toHaveLength(21);
    expect(tisleGold.tactics.must_find_tactic_identifiers?.every((id) => id.startsWith("G:"))).toBe(
      true,
    );
  });

  it("exposes isolated must_find sets for extract evals", () => {
    const bgb = mustFindForPack("beone-bgb-58067-prmt5i");
    expect(bgb.gap_ids).toHaveLength(43);

    const tisle = mustFindForPack("beone-tislelizumab-iegp");
    expect(tisle.tactic_identifiers).toHaveLength(21);
    expect(tisle.tactic_identifiers.every((id) => /^G:\d+$/.test(id))).toBe(true);
  });

  it("accuracyEvalReferencePack stub returns gold targets for a pack", async () => {
    const result = await accuracyEvalReferencePack("beone-bgb-58067-prmt5i");
    expect(result.status).toBe("targets_only");
    expect(result.pack.asset).toContain("BGB-58067");
    expect(result.targets.gap_ids).toHaveLength(43);
  });
});
