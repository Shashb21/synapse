/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
import type { GapSuggestionCard } from "@/lib/iegp/gap-suggestion-cards";
import type { ReviewGapCard } from "@/lib/iegp/engine";

/** KAN-114: evidence coverage and outstanding review are independent. */

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

const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!;
function render(cards: ReviewGapCard[], initialFilter?: "needs_validation" | "needs_attention", suggestions: GapSuggestionCard[] = []) {
  act(() => root.render(createElement(GapsWorkbench, { cards, initialFilter, suggestions, availableTactics: [], readyForPrioritize: false })));
}
const rows = () => [...container.querySelectorAll("tr[data-gap-id]")].map(r => r.getAttribute("data-gap-id"));
it("combines attention and evidence filters, counts distinct gaps and resets empty results", () => {
  render([
    card({ gap_id: "unconfirmed", human_validated: false }),
    card({ gap_id: "partial", gap_status: "validated_partial" }),
    card({ gap_id: "source", new_source: { at: "today", statement: null, source_title: null } }),
    card({ gap_id: "mapping", needs_review: true }),
    card({ gap_id: "multiple", human_validated: false, needs_review: true, new_source: { at: "today", statement: null, source_title: null } }),
    card({ gap_id: "done", gap_status: "validated_addressed" }),
  ]);
  expect(rows()).toHaveLength(6);
  act(() => button("Needs attention (5)").click());
  expect(rows().sort()).toEqual(["mapping", "multiple", "partial", "source", "unconfirmed"]);
  act(() => button("Open (4)").click());
  expect(rows()).toHaveLength(4);
  expect(container.textContent).toContain("Showing 4 of 6 gaps");
  expect(container.textContent).toContain("Pending source suggestions: 0");
  act(() => button("Addressed (1)").click());
  expect(rows()).toHaveLength(0);
  expect(container.textContent).toContain("No gaps match these filters.");
  act(() => button("Reset filters").click());
  expect(rows()).toHaveLength(6);
});
it("shows confirmed assessment separately from remaining review work and preserves legacy links", () => {
  render([card({ gap_id: "partial", gap_status: "validated_partial" }), card({ gap_id: "mapping", needs_review: true }), card()], "needs_validation");
  expect(rows()).toEqual(["partial"]);
  expect(container.textContent).toContain("Evidence status");
  expect(container.textContent).toContain("Review state");
  expect(container.querySelector('tr[data-gap-id="partial"]')?.textContent).toContain("Assessment confirmed");
  expect(container.querySelector('tr[data-gap-id="partial"]')?.textContent).toContain("Resolve partial gap");
  act(() => button("Reset filters").click());
  expect(container.querySelector('tr[data-gap-id="mapping"]')?.textContent).toContain("Review tactic mappings");
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

it("counts source suggestions separately from distinct gaps needing attention", () => {
  render([card()], "needs_attention", [suggestion]);
  expect(rows()).toHaveLength(0);
  expect(container.textContent).toContain("Needs attention (0)");
  expect(container.textContent).toContain("Pending source suggestions: 1");
});
it("persists both filter dimensions and resets their URL parameters", () => {
  render([card({ human_validated: false })]);
  act(() => button("Needs attention (1)").click());
  act(() => button("Open (1)").click());
  expect(new URL(window.location.href).searchParams.get("gap_filter")).toBe("open");
  expect(new URL(window.location.href).searchParams.get("gap_attention")).toBe("needs_attention");
  act(() => button("Reset filters").click());
  expect(new URL(window.location.href).searchParams.has("gap_filter")).toBe(false);
  expect(new URL(window.location.href).searchParams.has("gap_attention")).toBe(false);
});

it("keeps confirmed Addressed gaps with later source and mapping flags in Needs attention", () => {
  render([
    card({ gap_id: "source", gap_status: "validated_addressed", new_source: { at: "today", statement: null, source_title: null } }),
    card({ gap_id: "mapping", gap_status: "validated_addressed", needs_review: true }),
    card({ gap_id: "confirmed", gap_status: "validated_addressed" }),
  ]);
  act(() => button("Needs attention (2)").click());
  act(() => button("Addressed (3)").click());
  expect(rows().sort()).toEqual(["mapping", "source"]);
  expect(container.querySelector('tr[data-gap-id="mapping"]')?.textContent).toContain("Assessment confirmed");
});
