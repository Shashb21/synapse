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
import type { ReviewGapCard } from "@/lib/iegp/engine";

/** KAN-115: next actions follow review-task priority and retain remaining work. */

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


function renderCard(overrides: Partial<ReviewGapCard> = {}) {
  act(() => root.render(createElement(GapsWorkbench, { cards: [card(overrides)], availableTactics: [], readyForPrioritize: false })));
}
it("toggles the review region closed and reopens with task focus", () => {
  // Arrange: the review starts collapsed, with an actionable mapping task.
  renderCard({ needs_review: true });
  const next = container.querySelector<HTMLButtonElement>('[data-next-action] button')!;
  const region = () => container.querySelector('[aria-label="Outstanding gap review"]');
  expect(next.getAttribute('aria-expanded')).toBe('false');
  expect(region()).toBeNull();

  // Act / Assert: opening focuses the task; closing returns focus to its trigger.
  act(() => next.click());
  expect(next.getAttribute('aria-expanded')).toBe('true');
  expect(region()).not.toBeNull();
  expect(document.activeElement?.getAttribute('href')).toBe('/gaps/GAP-001#mapped-tactics');
  act(() => next.click());
  expect(next.getAttribute('aria-expanded')).toBe('false');
  expect(region()).toBeNull();
  expect(document.activeElement).toBe(next);

  act(() => next.click());
  expect(next.getAttribute('aria-expanded')).toBe('true');
  expect(region()).not.toBeNull();
  expect(document.activeElement?.getAttribute('href')).toBe('/gaps/GAP-001#mapped-tactics');
});

it("switches review rows with only the current row expanded and its task focused", () => {
  // Arrange: two independently actionable rows.
  act(() => root.render(createElement(GapsWorkbench, {
    cards: [card({ needs_review: true }), card({ gap_id: 'GAP-002', human_validated: false })],
    availableTactics: [], readyForPrioritize: false,
  })));
  const first = container.querySelector<HTMLButtonElement>('tr[data-gap-id="GAP-001"] [data-next-action] button')!;
  const second = container.querySelector<HTMLButtonElement>('tr[data-gap-id="GAP-002"] [data-next-action] button')!;

  // Act / Assert: switching replaces the region, including when returning to an earlier row.
  act(() => first.click());
  act(() => second.click());
  expect(first.getAttribute('aria-expanded')).toBe('false');
  expect(second.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelectorAll('[aria-label="Outstanding gap review"]')).toHaveLength(1);
  expect(document.activeElement?.textContent).toBe('Confirm evidence assessment');
  act(() => first.click());
  expect(first.getAttribute('aria-expanded')).toBe('true');
  expect(second.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelectorAll('[aria-label="Outstanding gap review"]')).toHaveLength(1);
  expect(document.activeElement?.getAttribute('href')).toBe('/gaps/GAP-001#mapped-tactics');
});

it("opens the primary task and exposes additional tasks in priority order", () => {
  renderCard({ gap_status: "validated_partial", human_validated: false, needs_review: true, new_source: { at: "2026-10-15", statement: "New evidence", source_title: "Study" } });
  const next = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Resolve partial gap');
  expect(next).toBeDefined();
  act(() => next!.click());
  expect(container.textContent).toContain('Additional tasks (3)');
  expect(document.activeElement?.textContent).toContain('Resolve');
});
it("advances through independent remaining tasks and leaves attention only when none remain", () => {
  const flags = { human_validated: false, needs_review: true, new_source: { at: "2026-10-15", statement: null, source_title: null } };
  for (const [overrides, label] of [
    [flags, 'Review tactic mappings'],
    [{ ...flags, needs_review: false }, 'Review new source'],
    [{ human_validated: false }, 'Confirm evidence assessment'],
    [{ human_validated: true }, 'No outstanding review'],
  ] as const) {
    renderCard(overrides);
    const row = container.querySelector('tr[data-gap-id]')!;
    expect(row.querySelector('[data-next-action]')?.textContent).toContain(label);
  }
});

it("focuses the existing mapping and source review controls", () => {
  renderCard({ needs_review: true });
  let next = container.querySelector<HTMLButtonElement>('[data-next-action] button')!;
  act(() => next.click());
  expect(document.activeElement?.getAttribute('href')).toBe('/gaps/GAP-001#mapped-tactics');
  act(() => next.click());
  renderCard({ new_source: { at: '2026-10-15', statement: null, source_title: null } });
  next = container.querySelector<HTMLButtonElement>('[data-next-action] button')!;
  act(() => next.click());
  expect(document.activeElement?.textContent).toBe('Mark reviewed');
  act(() => next.click());
  renderCard({ human_validated: false });
  next = container.querySelector<HTMLButtonElement>('[data-next-action] button')!;
  act(() => next.click());
  expect(document.activeElement?.textContent).toBe('Confirm evidence assessment');
});

it("keeps ordered review reasons beside the primary action and only explains applicable mapping review", () => {
  renderCard({ gap_status: "validated_partial", human_validated: false, needs_review: true, new_source: { at: "today", statement: null, source_title: null } });
  const action = container.querySelector('[data-next-action]')!;
  expect(action.textContent).toContain("Coverage is partial; split or rewrite this gap to resolve it.");
  expect(action.textContent).toContain("Additional tasks (3): Review tactic mappings · Review new source · Confirm evidence assessment");
  expect(action.querySelector('button')?.textContent).toBe("Resolve partial gap");
  act(() => action.querySelector('button')!.click());
  expect(document.activeElement?.getAttribute('href')).toBe('/gaps/GAP-001#gap-coverage-actions');
  act(() => action.querySelector('button')!.click());
  renderCard({ human_validated: false });
  act(() => container.querySelector<HTMLButtonElement>('[data-next-action] button')!.click());
  expect(container.querySelector('[aria-label="Outstanding gap review"]')?.textContent).not.toContain("Review tactic mappings:");
});

it("keeps secondary filters in a native disclosure with collapsed active state and discoverable reset", () => {
  renderCard({ settings: ["Hospital"], human_validated: false });
  const disclosure = container.querySelector<HTMLDetailsElement>('details[data-inventory-filters]');
  expect(disclosure).not.toBeNull();
  expect(disclosure!.open).toBe(false);
  expect(disclosure!.querySelector('summary')?.textContent).toBe('Filters (0)');
  expect(disclosure!.contains(container.querySelector('[aria-label="Search gaps"]'))).toBe(false);
  expect(disclosure!.contains(Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Needs attention (1)')!)).toBe(false);
  act(() => { disclosure!.open = true; });
  const domain = container.querySelector<HTMLSelectElement>('[aria-label="Filter by domain"]')!;
  act(() => { domain.value = 'comparative_effectiveness'; domain.dispatchEvent(new Event('change', { bubbles: true })); });
  const setting = container.querySelector<HTMLSelectElement>('[aria-label="Filter by setting"]')!;
  act(() => { setting.value = 'Hospital'; setting.dispatchEvent(new Event('change', { bubbles: true })); });
  const open = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Open (1)')!;
  act(() => open.click());
  act(() => { disclosure!.open = false; });
  expect(disclosure!.querySelector('summary')?.textContent).toBe('Filters (3)');
  const active = container.querySelector('[aria-label="Active secondary filters"]')!;
  expect(active.textContent).toContain('Comparative effectiveness');
  expect(active.textContent).toContain('Hospital');
  expect(active.textContent).toContain('Open');
  expect(new URL(window.location.href).searchParams.get('gap_filter')).toBe('open');
  act(() => Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Clear secondary filters')!.click());
  expect(disclosure!.querySelector('summary')?.textContent).toBe('Filters (0)');
  expect(domain.value).toBe('');
  expect(setting.value).toBe('');
  expect(new URL(window.location.href).searchParams.has('gap_filter')).toBe(false);
  act(() => Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Reset filters')!.click());
  expect(container.querySelectorAll('tr[data-gap-id]')).toHaveLength(1);
});

it("preserves search and attention when clearing secondary filters, and resets every dimension", () => {
  // Arrange: one matching row and one outside both the search and attention scope.
  act(() => root.render(createElement(GapsWorkbench, {
    cards: [card({ human_validated: false }), card({ gap_id: "other", gap_name: "Unrelated", statement: "Other question" })],
    availableTactics: [], readyForPrioritize: false, priorities: { "GAP-001": { band: "high", validated: true } },
  })));
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === label)!;
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search gaps"]')!;
  // Act: combine search, attention, and priority before clearing secondary filters.
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Comparative');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => button('Needs attention (1)').click());
  const priority = container.querySelector<HTMLSelectElement>('[aria-label="Filter by priority"]')!;
  act(() => { priority.value = 'low'; priority.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelectorAll('tr[data-gap-id]')).toHaveLength(0);
  expect(container.querySelector('[aria-label="Active secondary filters"]')?.textContent).toContain('Low');
  act(() => button('Clear secondary filters').click());
  // Assert: clear keeps the main review scope; reset returns the full inventory.
  expect(search.value).toBe('Comparative');
  expect(button('Needs attention (1)').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelectorAll('tr[data-gap-id]')).toHaveLength(1);
  expect(new URL(window.location.href).searchParams.get('gap_attention')).toBe('needs_attention');
  act(() => button('Reset filters').click());
  expect(search.value).toBe('');
  expect(priority.value).toBe('');
  expect(container.querySelectorAll('tr[data-gap-id]')).toHaveLength(2);
  expect(new URL(window.location.href).searchParams.has('gap_attention')).toBe(false);
});

it("names evidence confirmation separately from evidence status and priority", () => {
  renderCard({ human_validated: false });
  const row = container.querySelector('tr[data-gap-id]')!;
  expect(row.textContent).toContain("Open");
  expect(row.textContent).toContain("Assessment unconfirmed");
  const action = row.querySelector<HTMLButtonElement>('[data-next-action] button')!;
  expect(action.textContent).toBe("Confirm evidence assessment");
  act(() => action.click());
  expect(document.activeElement?.textContent).toBe("Confirm evidence assessment");
  expect(container.textContent).not.toContain("Validate the gap");
});
