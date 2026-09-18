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
    expect(chrome).not.toContain('label: "Review"');
    expect(chrome).not.toContain('label: "Mappings"');
    const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toContain("GapsWorkbench");
    expect(page).toContain('place === "gaps"');
    expect(page).toContain('place === "tactics"');
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
    const workbench = readFileSync(path.join(process.cwd(), "src/components/gaps-workbench.tsx"), "utf8");
    expect(workbench).toContain("<GapBadge status={card.gap_status} />");
    expect(workbench).toContain("SplitGapDialog");
  });
});
