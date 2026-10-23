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

/** KAN-119: ID header sorting follows displayed gap numbers with stable missing-value handling. */

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


it("ID header sorts displayed numbers both ways with stable ties and missing numbers last", () => {
  const cards = [card({ gap_id: "a", number: 1000 }), card({ gap_id: "z", number: 2 }), card({ gap_id: "b", number: 10 }), card({ gap_id: "c", number: 2 }), card({ gap_id: "missing", number: 0 })];
  act(() => root.render(createElement(GapsWorkbench, { cards, availableTactics: [], readyForPrioritize: false })));
  const header = Array.from(container.querySelectorAll('th')).find(th => th.textContent?.startsWith('ID'))!;
  const order = () => Array.from(container.querySelectorAll('tr[data-gap-id]')).map(row => row.getAttribute('data-gap-id'));
  act(() => header.querySelector('button')!.click());
  expect(header.getAttribute('aria-sort')).toBe('ascending');
  expect(order()).toEqual(['c', 'z', 'b', 'a', 'missing']);
  act(() => header.querySelector('button')!.click());
  expect(header.getAttribute('aria-sort')).toBe('descending');
  expect(order()).toEqual(['a', 'b', 'c', 'z', 'missing']);
});

it("mobile sorting shares the desktop header sort state and has a reset", () => {
  act(() => root.render(createElement(GapsWorkbench, { cards: [card({gap_id: "b", number: 10}), card({gap_id: "a", number: 2})], availableTactics: [], readyForPrioritize: false })));
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Sort gaps"]')!;
  expect(select).not.toBeNull();
  act(() => { select.value = "id"; select.dispatchEvent(new Event("change", {bubbles: true})); });
  expect(Array.from(container.querySelectorAll('tr[data-gap-id]')).map(row => row.getAttribute('data-gap-id'))).toEqual(["a", "b"]);
  const direction = container.querySelector<HTMLButtonElement>('[aria-label="Reverse gap sort direction"]')!;
  act(() => direction.click());
  expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe('descending');
  act(() => { select.value = ""; select.dispatchEvent(new Event("change", {bubbles: true})); });
  expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe('none');
});
