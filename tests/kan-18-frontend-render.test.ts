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
import { LockForm } from "@/components/lock-form";
import { GapsWorkbench } from "@/components/gaps-workbench";
import { PrioritizeMatrix, type PrioritizeGap } from "@/components/prioritize/prioritize-matrix";
import { AudienceView } from "@/components/room/audience-view";
import { NETWORK_ERROR } from "@/lib/post-json";
import type { ReviewGapCard } from "@/lib/iegp/engine";
import type { ReviewGapFilter } from "@/lib/iegp/engine";
import type { PriorityAxis } from "@/modules/stages/s8-prioritization/axis-math";

/** KAN-18 front-end reliability, rendered as a person sees it. */

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
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const byText = (text: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) as HTMLButtonElement;

describe("a dialog whose request fails never sticks on Saving…", () => {
  it("LockForm shows the network error as an alert and frees its button", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    act(() => root.render(createElement(LockForm, { label: "Lock residual text", action: "lock_residual" })));
    await act(async () => byText("Lock residual text").click());
    const submit = byText("Lock");
    expect(submit).toBeTruthy();
    await act(async () => {
      submit.closest("form")!.requestSubmit();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(NETWORK_ERROR);
    expect(byText("Lock").disabled).toBe(false);
    expect(byText("Saving…")).toBeUndefined();
  });
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

describe("the Gaps filter follows the URL", () => {
  const pressed = () =>
    [...container.querySelectorAll('[aria-label="Filter gaps"] button')]
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.textContent?.replace(/\s*\(\d+\)$/, ""));
  const render = (initialFilter?: ReviewGapFilter) =>
    act(() =>
      root.render(
        createElement(GapsWorkbench, { cards: [card()], availableTactics: [], readyForPrioritize: false, initialFilter }),
      ),
    );

  it("a new gap_filter on the same page changes the chip, and a chip writes the URL", () => {
    window.history.replaceState(null, "", "/?place=gaps");
    render(undefined);
    expect(pressed()).toEqual(["All"]);
    render("needs_validation");
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0]).not.toBe("All");

    const chips = [...container.querySelectorAll('[aria-label="Filter gaps"] button')] as HTMLButtonElement[];
    const other = chips.find((chip) => chip.getAttribute("aria-pressed") !== "true" && !/^All/.test(chip.textContent ?? ""))!;
    act(() => other.click());
    expect(new URL(window.location.href).searchParams.get("gap_filter")).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("place")).toBe("gaps");
    act(() => chips.find((chip) => /^All/.test(chip.textContent ?? ""))!.click());
    expect(new URL(window.location.href).searchParams.has("gap_filter")).toBe(false);
  });
});

const axis = (id: string): PriorityAxis => ({
  id,
  label: id,
  description: "",
  weight: 1,
  low_label: "Low",
  high_label: "High",
});

const gap = (id: string, x: number, y: number): PrioritizeGap => ({
  gap_id: id,
  gap_name: `Gap ${id}`,
  statement: "",
  domain_label: "Clinical",
  settings: [],
  tactic_count: 0,
  axis_scores: { impact: x, urgency: y },
  band: null,
  validated: false,
  suggested_band: null,
  suggested_rationale: null,
  rationale: null,
  actor_name: null,
  at: null,
});

describe("Prioritize matrix nudges", () => {
  it("nudging a second gap still saves the first one", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ placement: { band: "high", validated: true } }));
    vi.stubGlobal("fetch", fetchMock);
    act(() =>
      root.render(
        createElement(PrioritizeMatrix, {
          scope: "all",
          gaps: [gap("GAP-A", 40, 40), gap("GAP-B", 60, 60)],
          axes: [axis("impact"), axis("urgency")],
          xAxis: axis("impact"),
          yAxis: axis("urgency"),
          identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" },
          mayPrioritize: true,
        }),
      ),
    );
    const button = (name: string) =>
      container.querySelector(`button[aria-label^="Gap ${name}:"]`) as HTMLButtonElement;
    act(() => {
      button("GAP-A").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    act(() => {
      button("GAP-B").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const moved = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init.body)))
      .filter((body) => body.action === "move_placement")
      .map((body) => body.gap_id)
      .sort();
    expect(moved).toEqual(["GAP-A", "GAP-B"]);
  });
});

describe("Prioritize matrix nudges on unload", () => {
  it("a nudge still waiting on its debounce is sent with keepalive when the page goes away", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ placement: { band: "high", validated: true } }));
    vi.stubGlobal("fetch", fetchMock);
    act(() =>
      root.render(
        createElement(PrioritizeMatrix, {
          scope: "all",
          gaps: [gap("GAP-A", 40, 40), gap("GAP-B", 60, 60)],
          axes: [axis("impact"), axis("urgency")],
          xAxis: axis("impact"),
          yAxis: axis("urgency"),
          identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" },
          mayPrioritize: true,
        }),
      ),
    );
    const button = (name: string) =>
      container.querySelector(`button[aria-label^="Gap ${name}:"]`) as HTMLButtonElement;
    act(() => {
      button("GAP-A").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      button("GAP-B").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    // Reload / close before the 450 ms debounce: React does not unmount, the page just goes.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const sent = fetchMock.mock.calls
      .filter(([, init]) => init?.keepalive === true)
      .map(([, init]) => JSON.parse(String(init.body)))
      .filter((body) => body.action === "move_placement")
      .map((body) => `${body.gap_id}:${body.x},${body.y}`)
      .sort();
    expect(sent).toEqual(["GAP-A:42,40", "GAP-B:60,62"]);
  });
});

describe("Room audience", () => {
  it("the audience frame is watch-only: inert, no pointer, no tab stop", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
    act(() =>
      root.render(
        createElement(AudienceView, {
          workspaceKey: "ws",
          initialState: { href: "/?place=gaps", rev: 1 } as never,
        }),
      ),
    );
    const frame = container.querySelector('[data-testid="audience-frame"]') as HTMLIFrameElement;
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.className).toContain("pointer-events-none");
    expect(frame.tabIndex).toBe(-1);
  });
});
