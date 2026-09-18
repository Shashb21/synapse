import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("Gaps workbench buttons and leftover inbox", () => {
  it("exposes Add open gap, Add addressed gap, and Add tactic on the Gaps workbench", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/gaps-workbench.tsx"), "utf8");
    expect(src).toContain('label="Add open gap"');
    expect(src).toContain('label="Add addressed gap"');
    expect(src).toContain('label="Add tactic"');
    expect(src).toContain("create_addressed_gap");
    expect(src).toContain("SplitGapDialog");
    expect(src).toContain("View constituent needs");
    expect(src).toContain("No constituent needs yet.");
    expect(src).toContain("CoverageDimensionsMenu");
    expect(src).toContain("No tactics mapped");
    expect(src).toContain("Needs validation");
    expect(src).not.toContain("Accept gap");
    expect(src).not.toContain("Accept tactic");
    expect(src).not.toContain("Accept as new gap");
  });

  it("does not keep a Review candidate inbox or required Mappings step", () => {
    const cards = readFileSync(path.join(process.cwd(), "src/components/plan-cards.tsx"), "utf8");
    expect(cards).not.toContain("export function ReviewQueue");
    expect(cards).not.toContain("ReviewInnerTabs");
    expect(cards).not.toContain("Accept as new gap");
    expect(cards).not.toContain("Accept gap");
    expect(cards).not.toContain("Accept tactic");
    const chrome = readFileSync(path.join(process.cwd(), "src/components/plan-chrome.tsx"), "utf8");
    expect(chrome).toContain('label: "Upload"');
    expect(chrome).toContain('label: "Gaps"');
    expect(chrome).toContain('label: "Prioritize"');
    expect(chrome).toContain('label: "Tactics"');
    expect(chrome).toContain('href: "/?place=upload"');
    expect(chrome).toContain('href: "/?place=gaps"');
    expect(chrome).toContain('href: "/?place=plan"');
    expect(chrome).toContain('href: "/?place=tactics"');
    expect(chrome).not.toContain('href: "/tactics"');
    expect(chrome).not.toContain('label: "Review"');
    expect(chrome).not.toContain('label: "Mappings"');
    const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toContain("GapsWorkbench");
    expect(page).toContain('place === "gaps"');
    expect(page).toContain('place === "tactics"');
    expect(page).toContain("TacticsPlace");
    const tacticsRoute = readFileSync(path.join(process.cwd(), "src/app/tactics/page.tsx"), "utf8");
    expect(tacticsRoute).toContain("TacticsPlace");
    expect(tacticsRoute).toContain("tacticsUnlocked");
    expect(tacticsRoute).not.toContain("Propose a tactic");
  });

  it("override dialog requires a reason, omits Partial, and Cancel does not save", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/gap-status-override.tsx"), "utf8");
    expect(src).toContain('action: "override_gap_status"');
    expect(src).toContain("A reason is required to override computed gap status.");
    expect(src).toContain("Cancel");
    expect(src).toContain("Cancel does not change status.");
    expect(src).toMatch(/name="reason"/);
    expect(src).toContain('s !== "validated_partial"');
  });

  it("clicking Partial opens split or rewrite, not a status lock", () => {
    const dialog = readFileSync(path.join(process.cwd(), "src/components/split-gap-dialog.tsx"), "utf8");
    expect(dialog).toContain("split_partial_gap");
    expect(dialog).toContain("rewrite_partial_gap");
    expect(dialog).toContain("Addressed");
    expect(dialog).toContain("Open");
    expect(dialog).toContain("Partial cannot stay");
    expect(dialog).toContain("Split or rewrite");
    expect(dialog).toContain("tactic_ids");
    expect(dialog).toContain("addressed_statement");
    expect(dialog).toContain("At least one tactic");
    const workbench = readFileSync(path.join(process.cwd(), "src/components/gaps-workbench.tsx"), "utf8");
    expect(workbench).toContain("<GapBadge status={card.gap_status} />");
    expect(workbench).toContain("SplitGapDialog");
    const detail = readFileSync(path.join(process.cwd(), "src/app/gaps/[id]/page.tsx"), "utf8");
    expect(detail).toContain("Change dimension");
    expect(detail).toContain("Change overall coverage");
    expect(detail).toContain("Also mapped on");
    expect(detail).toContain("confirm_coverage_review");
    expect(detail).toContain("CoverageDimensionsMenu");
    expect(detail).toContain("No constituent needs yet.");
  });

  it("replaces stale re-lock copy and distinguishes sibling review from outdated coverage", () => {
    const badges = readFileSync(path.join(process.cwd(), "src/components/iegp-badges.tsx"), "utf8");
    expect(badges).toContain("Coverage outdated — tactic or sources changed");
    expect(badges).toContain("Review coverage — also mapped elsewhere");
    expect(badges).not.toContain(">Stale — re-lock<");
    expect(badges).not.toContain(">Needs review<");
    const workbench = readFileSync(path.join(process.cwd(), "src/components/gaps-workbench.tsx"), "utf8");
    expect(workbench).toContain("View constituent needs");
    expect(workbench).toContain("CoverageDimensionsMenu");
    expect(workbench).not.toContain("re-lock");
    const menu = readFileSync(path.join(process.cwd(), "src/components/coverage-dimensions-menu.tsx"), "utf8");
    expect(menu).toContain("Dimensions");
    expect(menu).toContain("Overall");
    expect(menu).toContain("COVERAGE_DIMENSIONS");
    const tactics = readFileSync(path.join(process.cwd(), "src/app/tactics/[id]/page.tsx"), "utf8");
    expect(tactics).not.toContain("re-lock");
    const model = readFileSync(path.join(process.cwd(), "docs/iegp-model.md"), "utf8");
    expect(model).not.toContain("re-lock");
    const problem = readFileSync(path.join(process.cwd(), "docs/problem-and-solution.md"), "utf8");
    expect(problem).not.toContain("re-lock");
  });
});
