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
    expect(library).toContain("<CreateActions />");
    const tacticsBlock = src.slice(
      src.indexOf("function GapTacticsBlock"),
      src.indexOf("export function ReviewCard"),
    );
    expect(tacticsBlock).toContain('label="Assign tactic"');
    expect(tacticsBlock).not.toContain('label="Create tactic"');
  });
});
