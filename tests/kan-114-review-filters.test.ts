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
import { buildPlanWorkspace, filterReviewGapCards, gapEligibleForMapping, gapsReadyForPrioritize, planGates, planNavCounts, reviewGapFilterCounts, type ReviewGapCard } from "@/lib/iegp/engine";
import { buildSeed } from "@/lib/iegp/seed";
import { PlanChrome } from "@/components/plan-chrome";
import { InventoryReadiness } from "@/components/inventory-readiness";

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

it("labels the real combined strip count accurately for a human-confirmed Partial gap", () => {
  const state = buildSeed();
  state.gaps = state.gaps.filter(gap => !gap.retired).slice(0, 1);
  const gap = state.gaps[0];
  gap.status = "validated_partial";
  gap.computed_status = "validated_partial";
  gap.status_override = null;
  gap.human_validated = true;
  state.asset.wizard_complete = true;
  state.asset.tactics_unlocked = true;
  const workspace = buildPlanWorkspace(state);
  const counts = planNavCounts(workspace);
  const filters = reviewGapFilterCounts(workspace.review);
  const gates = planGates(state);
  expect(counts).toEqual({ gaps: 1, unvalidated: 1 });
  expect(filters.partial).toBe(1);
  expect(filters.needs_attention).toBe(1);
  expect(filterReviewGapCards(workspace.review, "needs_validation")).toHaveLength(1);
  expect(gapsReadyForPrioritize(state)).toBe(false);
  expect(gates).toEqual({ hasSources: true, gapsUnlocked: true, planUnlocked: true, tacticsUnlocked: true });
  expect(gapEligibleForMapping(workspace.review[0].gap_status)).toBe(true);
  const nav = {
    gapsCount: counts.gaps, unvalidatedCount: counts.unvalidated,
    partialCount: filters.partial, inventoryAttentionCount: filters.needs_attention,
    ...gates, setupComplete: true, readyForPrioritize: gapsReadyForPrioritize(state),
  };
  const chromeProps = {
    active: "gaps" as const,
    nav,
    children: createElement(InventoryReadiness, { cards: workspace.review, readyForPrioritize: nav.readyForPrioritize }),
  };
  act(() => root.render(createElement(PlanChrome, chromeProps)));
  expect(container.textContent).toContain("0 gaps with unconfirmed evidence assessments");
  const strip = container.querySelector('[aria-label="Prep readiness"]')!;
  expect(strip.querySelector('a[href*="gap_filter=needs_validation"]')?.textContent).toBe("Unconfirmed or partial 1");
  expect(strip.textContent).toContain("Partial 1");
  expect(strip.textContent).toContain("Inventory review: 1 gaps needing attention");
  expect(strip.textContent).toContain("Tactics open");
  render(workspace.review, "needs_attention");
  expect(rows()).toEqual([gap.id]);
  expect(container.querySelector("tr[data-gap-id]")?.textContent).toContain("Assessment confirmed");
  expect(planGates(state)).toEqual(gates);
});

it("includes a confirmed gap when only a mapped tactic requires review", () => {
  render([
    card({ gap_id: "tactic-only", needs_review: false, tactics: [{
      id: "TAC-001", name: "Comparative study", type: "rwe_study", custom_type: null,
      status: "planned", overall: null, stale: false, needs_review: true,
      counts_toward_addressing: false, dimensions: null,
    }] }),
    card({ gap_id: "done" }),
  ]);
  act(() => button("Needs attention (1)").click());
  expect(rows()).toEqual(["tactic-only"]);
  const row = container.querySelector('tr[data-gap-id="tactic-only"]')!;
  expect(row.textContent).toContain("Assessment confirmed");
  expect(row.textContent).toContain("Review tactic mappings");
});
