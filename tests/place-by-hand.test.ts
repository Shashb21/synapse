import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { placementGapError } from "@/components/prioritize/score-input";

const axis = (label: string, typed: string, saved?: number) => ({ label, typed, saved });

describe("Place by hand refuses a save that would leave the gap off the matrix", () => {
  it("asks for the missing axis when only one score is typed and no band is picked", () => {
    expect(
      placementGapError({ x: axis("Feasibility", ""), y: axis("Payer / HTA relevance", "70"), band: "" }),
    ).toBe("Give the Feasibility score too, so the gap has a place on the matrix, or pick a band.");
    expect(
      placementGapError({ x: axis("Feasibility", "30"), y: axis("Payer / HTA relevance", ""), band: "" }),
    ).toMatch(/^Give the Payer \/ HTA relevance score too/);
  });

  it("lets through both scores, a saved score for the other axis, a band, or nothing typed", () => {
    expect(placementGapError({ x: axis("X", "30"), y: axis("Y", "70"), band: "" })).toBeNull();
    expect(placementGapError({ x: axis("X", "", 40), y: axis("Y", "70"), band: "" })).toBeNull();
    expect(placementGapError({ x: axis("X", ""), y: axis("Y", "70"), band: "high" })).toBeNull();
    expect(placementGapError({ x: axis("X", ""), y: axis("Y", ""), band: "" })).toBeNull();
  });

  it("the shared action dialog starts each opening without the last error", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/platform/action-dialog.tsx"), "utf8");
    expect(src).toMatch(/function onOpenChange\(next: boolean\) \{[\s\S]*?setError\(null\)/);
    expect(src).toContain("onOpenChange={onOpenChange}");
  });
});
