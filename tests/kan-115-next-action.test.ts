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


function renderCard(overrides: Partial<ReviewGapCard> = {}) {
  act(() => root.render(createElement(GapsWorkbench, { cards: [card(overrides)], availableTactics: [], readyForPrioritize: false })));
}
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
    [{ human_validated: false }, 'Confirm status'],
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
  renderCard({ new_source: { at: '2026-10-15', statement: null, source_title: null } });
  next = container.querySelector<HTMLButtonElement>('[data-next-action] button')!;
  act(() => next.click());
  expect(document.activeElement?.textContent).toBe('Mark reviewed');
  renderCard({ human_validated: false });
  next = container.querySelector<HTMLButtonElement>('[data-next-action] button')!;
  act(() => next.click());
  expect(document.activeElement?.textContent).toBe('Confirm status');
});
