import { describe, expect, it } from "vitest";
import manifest from "../reference/manifest.json";

describe("reference manifest", () => {
  it("lists two BeOne packs with separate gold", () => {
    expect(manifest.packs).toHaveLength(2);
    const ids = manifest.packs.map((p) => p.id);
    expect(ids).toContain("beone-bgb-58067-prmt5i");
    expect(ids).toContain("beone-tislelizumab-iegp");
  });
});
