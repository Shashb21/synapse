import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingFieldsMessage } from "@/components/lock-form";
import { FALLBACK, PALETTE_TOKENS } from "@/components/timeline/gantt-chart";
import { hasSuggestedSplit, splitTitlesError } from "@/components/split-gap-dialog";

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

  it("an action dialog remounts a field whose default changed instead of changing it in place", () => {
    // Base UI warns when an uncontrolled FieldControl's defaultValue changes (Type scores, then refresh).
    const dialog = src("src/components/platform/action-dialog.tsx");
    expect(dialog).toContain('<label key={`${field.name}:${field.defaultValue ?? ""}`}');
  });

  it("customer screens never say AI is off (KAN-53)", () => {
    for (const path of [
      "src/components/walkthrough/tour-steps.ts",
      "src/components/timeline/timeline-board.tsx",
      "src/components/room/presenter-console.tsx",
      "src/components/gap-tactic-actions.tsx",
    ]) {
      // Comments may explain the rule; shown text may not break it.
      const shown = src(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(shown, path).not.toMatch(/AI is off|while AI is off|>AI off<|With AI on/);
    }
  });

  it("setup list items are named in the singular: Remove indication 1", () => {
    const fields = src("src/components/setup/setup-fields.tsx");
    expect(fields).toContain("aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`}");
    const steps = src("src/components/setup/setup-steps.tsx");
    for (const [list, item] of [
      ["Indications", "Indication"],
      ["Objectives", "Objective"],
      ["Competitors", "Competitor"],
      ["Regulatory milestones", "Milestone"],
      ["Functions involved", "Function"],
    ]) {
      expect(steps).toContain(`label="${list}"\n        itemLabel="${item}"`);
    }
  });

  it("AI wording on Tactics and Type scores only shows while AI is on", () => {
    const board = src("src/components/tactic-ideation/ideation-board.tsx");
    expect(board).not.toContain("when AI is on");
    expect(board).toMatch(/\{ai \? ", write a custom tactic, or accept a suggestion\." : " or write a custom tactic\."\}/);
    const matrix = src("src/components/prioritize/prioritize-matrix.tsx");
    expect(matrix).toMatch(/hint: ai\s*\? "A band you set here is yours: a later model run/);
    expect(matrix).toMatch(/ai\s*\? "Type the exact axis scores[^"]*No model run is needed[^"]*"\s*: "Type the exact axis scores and, if you want, the band\."/);
  });

  it("a split can't make two gaps with the same title, and a manual split isn't called suggested", () => {
    expect(splitTitlesError("RWE in EU5", "rwe in eu5 ")).toBe(
      "The Addressed title and the Open title are the same. Give each slice its own title.",
    );
    expect(splitTitlesError("", "Open slice")).toBe("Fill in the Addressed title.");
    expect(splitTitlesError("Addressed slice", "  ")).toBe("Fill in the Open title.");
    expect(splitTitlesError("Addressed slice", "Open slice")).toBeNull();
    // No residual: both titles start as the gap's name, so nothing was suggested.
    expect(hasSuggestedSplit("Persistence vs SoC", "Persistence vs SoC")).toBe(false);
    expect(hasSuggestedSplit("Persistence vs SoC", "Persistence beyond 12 months")).toBe(true);
    const dialog = src("src/components/split-gap-dialog.tsx");
    expect(dialog).toContain('(suggested ? "Accept split" : "Split gap")');
    expect(dialog).toMatch(/<p role="alert" className="text-\[12px\] text-destructive">\s*\{error\}/);
  });

  it("Gaps with no gaps says to add gaps first, not '0 gaps still unconfirmed'", () => {
    const workbench = src("src/components/gaps-workbench.tsx");
    expect(workbench).toMatch(/cards\.length === 0 \? \([\s\S]*?Add gaps first/);
  });
});
