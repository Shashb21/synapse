import { describe, expect, it } from "vitest";
import { seedWorkspaceFromGold } from "@/accuracy/store/seed-from-gold";
import { listClaims } from "@/accuracy/store/claim-store";
import { listSourceFiles } from "@/accuracy/store/source-store";

describe("seed workspace from gold", () => {
  it("creates workspace with BGB gold gaps and tactics and parses pptx locally", async () => {
    const result = await seedWorkspaceFromGold({
      packId: "beone-bgb-58067-prmt5i",
      workspaceName: "Seed test BGB",
      parseSource: true,
    });
    expect(result.gaps).toBe(43);
    expect(result.tactics).toBe(36);
    expect(result.parse_blocks).toBeGreaterThan(10);

    const claims = await listClaims(result.workspace_id, { limit: 200 });
    expect(claims.filter((c) => c.claim_type === "gap")).toHaveLength(43);
    expect(claims.filter((c) => c.claim_type === "tactic")).toHaveLength(36);

    const sources = await listSourceFiles(result.workspace_id);
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0]?.reference_pack_id).toBe("beone-bgb-58067-prmt5i");
  }, 60_000);
});
