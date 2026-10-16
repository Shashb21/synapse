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


it("shows evidence before tactics and actions, with edits collapsed and a full record link", () => {
  act(() => root.render(createElement(GapsWorkbench, { cards: [card()], availableTactics: [], readyForPrioritize: false })));
  expect(container.querySelector("article")).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="gap-row-toggle"]')!.click());
  const pane = container.querySelector("article")!;
  const text = pane.textContent!;
  expect(text).toContain("Sources and supporting statements");
  expect(text.indexOf("Sources and supporting statements")).toBeLessThan(text.indexOf("Review tactic mappings"));
  expect(text.indexOf("Review tactic mappings")).toBeLessThan(text.indexOf("Edit gap details"));
  expect(pane.querySelector("details")!.open).toBe(false);
  expect(Array.from(pane.querySelectorAll("a")).find(a => a.textContent === "Open full gap and evidence record")?.getAttribute("href")).toBe("/gaps/GAP-001");
  expect(text).toContain("No source yet");
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
  const error = container.querySelector('[role="alert"]');
  expect(error?.textContent).toContain("Settings failed");
  expect(input.getAttribute("aria-describedby")).toBe(error?.id);
  expect(container.textContent).toContain("Metastatic");
  expect(Array.from(container.querySelectorAll("button")).some(b => b.textContent === "Retry saving settings")).toBe(true);
  vi.unstubAllGlobals();
});

it("renders source titles, scientific statements and roles directly in the compact evidence view", () => {
  act(() => root.render(createElement(GapsWorkbench, { cards: [card({ needs: [{ id: "need-1", statement: "Comparative evidence is missing.", role: "supporting", source_title: "Clinical interview" }] })], availableTactics: [], readyForPrioritize: false })));
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="gap-row-toggle"]')!.click());
  const evidence = container.querySelector('section[aria-label="Sources and supporting statements"]')!;
  expect(evidence.textContent).toContain("Clinical interview · supporting");
  expect(evidence.textContent).toContain("Comparative evidence is missing.");
});
