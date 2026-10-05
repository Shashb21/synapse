/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GapsWorkbench } from "@/components/gaps-workbench";
import type { ReviewGapCard } from "@/lib/iegp/engine";
import type { GapSuggestionCard } from "@/lib/iegp/gap-suggestion-cards";

/**
 * KAN-74/75 on the Gaps place: pending overlaps show above the table with both
 * proposals side by side, and a validated gap a new source joined carries a
 * "New source added" pill.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const card = (overrides: Partial<ReviewGapCard> = {}): ReviewGapCard => ({
  gap_id: "GAP-001",
  gap_name: "Comparative effectiveness",
  statement: "How does it compare with SoC?",
  domain: "comparative_effectiveness",
  tactics: [],
  computed_status: "validated_open",
  gap_status: "validated_open",
  status_override: null,
  human_validated: true,
  residual: null,
  parent_gap_id: null,
  history_count: 0,
  need_count: 2,
  needs: [],
  needs_review: false,
  settings: [],
  metadata: { stakeholders: [], geography: "", regional_nuances: "", notes: "" },
  number: 1,
  new_source: null,
  related: [],
  ...overrides,
});

const suggestion: GapSuggestionCard = {
  id: "gsug-1",
  gap_id: "GAP-001",
  gap_number: 1,
  gap_name: "Comparative effectiveness",
  gap_statement: "How does it compare with SoC?",
  source_title: "KOL interviews",
  source_quote: "Nobody has looked at the over-75s.",
  extra_source_count: 1,
  shared_part: "Comparative effectiveness versus SoC is unknown.",
  new_part: "Nothing is known for patients over 75.",
  merged_name: "Comparative effectiveness incl. over-75s",
  merged_statement: "How does it compare with SoC, including in patients over 75?",
  split_name: "Effectiveness in over-75s",
  split_statement: "How effective is it in patients over 75?",
};

function render(props: { cards: ReviewGapCard[]; suggestions?: GapSuggestionCard[] }) {
  act(() =>
    root.render(
      createElement(GapsWorkbench, { availableTactics: [], readyForPrioritize: false, ...props }),
    ),
  );
}

describe("Gaps place, KAN-74/75", () => {
  it("shows pending overlaps with both proposals and their actions", () => {
    render({ cards: [card()], suggestions: [suggestion] });
    const section = container.querySelector('[data-testid="gap-suggestions"]')!;
    expect(section.textContent).toContain("Suggested changes (1)");
    expect(section.textContent).toContain("KOL interviews and 1 more saying the same");
    expect(section.textContent).toContain(suggestion.merged_statement);
    expect(section.textContent).toContain(suggestion.split_statement);
    const buttons = [...section.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(buttons).toEqual(expect.arrayContaining(["Accept merge", "Accept split", "Reject"]));
  });

  it("shows nothing when no suggestion is pending", () => {
    render({ cards: [card()] });
    expect(container.querySelector('[data-testid="gap-suggestions"]')).toBeNull();
  });

  it("marks a gap a new source joined after it was validated", () => {
    render({
      cards: [
        card({ new_source: { at: "2026-10-04T10:00:00Z", statement: "Over-75s matter.", source_title: "KOL interviews" } }),
        card({ gap_id: "GAP-002", number: 2, gap_name: "Persistence" }),
      ],
    });
    const rows = [...container.querySelectorAll("tr[data-gap-id]")];
    expect(rows.find((row) => row.getAttribute("data-gap-id") === "GAP-001")!.textContent).toContain("New source added");
    expect(rows.find((row) => row.getAttribute("data-gap-id") === "GAP-002")!.textContent).not.toContain("New source added");
  });
});
