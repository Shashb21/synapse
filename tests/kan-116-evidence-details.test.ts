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
import { buildSeed } from "@/lib/iegp/seed";
import { getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import { GapSettingsEditor } from "@/components/gap-settings-editor";

/** KAN-116: evidence precedes tactics and actions; failed settings saves retain input. */

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
  vi.unstubAllGlobals();
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


async function openEvidence(needs: { statement: string; title: string; role: string }[] = []) {
  const seed = buildSeed();
  const gap = { ...seed.gaps[0]!, id: "GAP-001" };
  const record = {
    gap, objective: null, requirement_review: getRequirementBasisReview(seed, seed.gaps[0]!.id),
    confirmation: { confirmed: false, by: null, at: null, rationale: null },
    coverage_status: { computed: "validated_open", shown: "validated_open", needs_review: false },
    parent: null, origin: null, children: [], related: [],
    needs: needs.map((entry, index) => ({ need: { id: `need-${index}`, statement: entry.statement }, source: { id: `source-${index}`, title: entry.title }, role: entry.role })),
    coverages: [], priority: null, ideas: [], timeline: [], breakout_groups: [], pending_suggestions: [], history: [],
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => record }));
  act(() => root.render(createElement(GapsWorkbench, { cards: [card()], availableTactics: [], readyForPrioritize: false })));
  await act(async () => container.querySelector<HTMLAnchorElement>('[data-testid="gap-row-toggle"]')!.click());
  return document.querySelector('[data-testid="gap-panel"]')!;
}

it("opens the shared evidence record before tactics, with collapsed history and full record access", async () => {
  const pane = await openEvidence();
  const text = pane.textContent!;
  expect(text.indexOf("Constituent needs")).toBeLessThan(text.indexOf("Linked tactics"));
  expect(text).toContain("No constituent needs yet.");
  expect(pane.querySelector("details")!.open).toBe(false);
  expect(Array.from(pane.querySelectorAll("a")).find(a => a.textContent === "Edit gap and mappings")?.getAttribute("href")).toBe("/gaps/GAP-001");
});

it("announces failed settings saves, retains entered values, and offers retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "Settings failed" }) }));
  act(() => root.render(createElement(GapSettingsEditor, { gapId: "GAP-001", settings: ["1L"], options: [] })));
  const input = container.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "Metastatic");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const reason = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reason, "Reflect the intended treatment setting");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save settings")!.click());
  const error = container.querySelector('[role="alert"]');
  expect(error?.textContent).toContain("Settings failed");
  expect(input.getAttribute("aria-describedby")).toBe(error?.id);
  expect(container.textContent).toContain("Metastatic");
  expect(Array.from(container.querySelectorAll("button")).some(b => b.textContent === "Retry saving settings")).toBe(true);
  vi.unstubAllGlobals();
});

it("renders source titles, scientific statements and roles in the shared evidence record", async () => {
  const pane = await openEvidence([{ statement: "Comparative evidence is missing.", title: "Clinical interview", role: "supporting" }]);
  const evidence = pane.querySelector('section[aria-label="Constituent needs"]')!;
  expect(evidence.textContent).toContain("Clinical interview");
  expect(evidence.textContent).toContain("supporting");
  expect(evidence.textContent).toContain("Comparative evidence is missing.");
});
