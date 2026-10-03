import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/** KAN-68: minor findings from the end-to-end QA pass (KAN-64). */
describe("KAN-68 QA polish", () => {
  it("Prioritize errors are announced as alerts, not muted text", () => {
    const matrix = src("src/components/prioritize/prioritize-matrix.tsx");
    expect(matrix).toMatch(/message\?\.error \? \(\s*<p role="alert" className="[^"]*text-destructive/);
    expect(matrix).toMatch(/\{error \? \(\s*<p role="alert" className="[^"]*text-destructive/);
    // Every failure path goes through the error flavour.
    expect(matrix).not.toMatch(/setMessage\((?:json|result)\.error/);
    expect(matrix).not.toMatch(/setMessage\(saveError\)/);
  });
});
