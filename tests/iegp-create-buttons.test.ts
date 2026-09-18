import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("Create gap and Create tactic buttons", () => {
  const src = readFileSync(path.join(process.cwd(), "src/components/plan-cards.tsx"), "utf8");

  it("exposes Create gap and Create tactic together on Review and Library", () => {
    expect(src).toMatch(/function CreateActions\(/);
    expect(src).toContain('label="Create gap"');
    expect(src).toContain('label="Create tactic"');
    const reviewStart = src.indexOf("export function ReviewQueue");
    const libraryStart = src.indexOf("export function TacticLibrary");
    expect(reviewStart).toBeGreaterThan(0);
    expect(libraryStart).toBeGreaterThan(reviewStart);
    const review = src.slice(reviewStart, libraryStart);
    const library = src.slice(libraryStart);
    expect(review).toContain("<CreateGapButton />");
    expect(review).toContain("<CreateTacticButton />");
    expect(review).toContain("ReviewInnerTabs");
    expect(review).toContain("<SuggestedResidualGaps items={residuals} />");
    expect(review).toContain("Residual evidence needs");
    expect(review).toContain('label="Accept as new gap"');
    expect(library).toContain("<CreateActions />");
  });

  it("wires the Gaps workbench from the home page", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toContain("GapsWorkbench");
    expect(page).toContain("GapStatusGuide");
    expect(page).toContain('place === "gaps"');
  });

  it("override dialog requires a reason and Cancel does not save", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/gap-status-override.tsx"), "utf8");
    expect(src).toContain('action: "override_gap_status"');
    expect(src).toContain("A reason is required to override computed gap status.");
    expect(src).toContain("Cancel");
    expect(src).toContain("Cancel does not change status.");
    expect(src).toMatch(/name="reason"/);
  });
});
