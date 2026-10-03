import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingFieldsMessage } from "@/components/lock-form";
import { FALLBACK, PALETTE_TOKENS } from "@/components/timeline/gantt-chart";

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

  it("a dialog names the required fields that are still empty", () => {
    expect(missingFieldsMessage(["Custom type name"])).toBe('Fill in "Custom type name", then try again.');
    expect(missingFieldsMessage(["Name", "Domain", "Domain"])).toBe('Fill in "Name" and "Domain", then try again.');
    expect(missingFieldsMessage(["Name", "Domain", "Why?"])).toBe('Fill in "Name", "Domain" and "Why?", then try again.');
    const form = src("src/components/lock-form.tsx");
    expect(form).not.toContain("Fill every required field");
    expect(form).toMatch(/<p role="alert" className="[^"]*text-destructive/);
  });

  it("the timeline's first render uses the same palette on server and client", () => {
    // Every fallback colour equals its light-theme token, so hydration has nothing to differ on.
    const css = src("src/app/globals.css");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    const token = (name: string) => root.match(new RegExp(`${name}:\\s*(#[0-9a-f]{3,8});`, "i"))?.[1];
    for (const [key, name] of Object.entries(PALETTE_TOKENS)) {
      expect(FALLBACK[key as keyof typeof FALLBACK], `${key} (${name})`).toBe(token(name));
    }
    const chart = src("src/components/timeline/gantt-chart.tsx");
    expect(chart).toMatch(/hydrated \? readPalette\(\) : FALLBACK/);
  });
});
