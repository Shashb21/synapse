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
    expect(review).toContain("<CreateActions />");
    expect(review).toContain("<SuggestedResidualGaps items={residuals} />");
    expect(review).toContain("Residual evidence needs");
    expect(review).toContain('label="Accept as new gap"');
    expect(library).toContain("<CreateActions />");
  });
});
