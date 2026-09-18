import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("Create gap and Create tactic buttons", () => {
  const src = readFileSync(path.join(process.cwd(), "src/components/plan-cards.tsx"), "utf8");
  const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");

  it("exposes Create gap and Create tactic together on Review and Library", () => {
    expect(src).toMatch(/function CreateActions\(/);
    expect(src).toContain('label="Create gap"');
    expect(src).toContain('label="Create tactic"');
    const reviewStart = src.indexOf("export function ReviewQueue");
    const leftoverStart = src.indexOf("export function SuggestedResidualGaps");
    const libraryStart = src.indexOf("export function TacticLibrary");
    expect(reviewStart).toBeGreaterThan(0);
    expect(leftoverStart).toBeGreaterThan(reviewStart);
    expect(libraryStart).toBeGreaterThan(leftoverStart);
    const review = src.slice(reviewStart, leftoverStart);
    const leftover = src.slice(leftoverStart, libraryStart);
    const library = src.slice(libraryStart);
    expect(review).toContain("<CreateActions />");
    expect(review).not.toContain("SuggestedResidualGaps");
    expect(leftover).toContain("Leftover as a new gap");
    expect(leftover).toContain('label="Accept as new gap"');
    expect(leftover).toContain('label="Reject leftover"');
    expect(library).toContain("<CreateActions />");
    expect(page).toContain("<SuggestedResidualGaps items={workspace.residualGapSuggestions} />");
    expect(page).not.toContain("residuals={workspace.residualGapSuggestions}");
  });
});
