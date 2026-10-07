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

import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePageRefresh } from "@/components/platform/use-page-refresh";
import { GapsWorkbench } from "@/components/gaps-workbench";
import { PrioritizeMatrix, type PrioritizeGap } from "@/components/prioritize/prioritize-matrix";
import { LockForm } from "@/components/lock-form";
import type { ReviewGapCard } from "@/lib/iegp/engine";
import type { PriorityAxis } from "@/modules/stages/s8-prioritization/axes";

/**
 * KAN-68: after an action the page shows the new server data without a reload.
 * Views render straight from props (or drop local overrides when new props
 * come), and every action refreshes in a transition, so a dialog closes with
 * the new data rather than seconds before it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function render(element: ReactElement) {
  act(() => root.render(element));
}

function card(id: string, number: number, overrides: Partial<ReviewGapCard> = {}): ReviewGapCard {
  return {
    gap_id: id,
    gap_name: `Gap ${id}`,
    statement: `Statement ${id}`,
    domain: "efficacy",
    tactics: [],
    computed_status: "validated_open",
    gap_status: "validated_open",
    status_override: null,
    human_validated: false,
    residual: null,
    parent_gap_id: null,
    history_count: 0,
    need_count: 1,
    needs: [],
    needs_review: false,
    settings: [],
    metadata: {} as ReviewGapCard["metadata"],
    number,
    new_source: null,
    related: [],
    ...overrides,
  };
}

function chipText() {
  return container.querySelector('[aria-label="Filter gaps"]')?.textContent ?? "";
}

describe("Evidence Inventory follows the refreshed cards", () => {
  const partial = card("GAP-001", 1, { gap_status: "validated_partial", computed_status: "validated_partial" });
  const open = card("GAP-002", 2);
  const before = [partial, open];
  // After "Rewrite and retire original": the partial is gone, its rewrite is Open and confirmed.
  const after = [card("GAP-003", 3, { human_validated: true }), open];

  function workbench(cards: ReviewGapCard[]) {
    return createElement(GapsWorkbench, { cards, availableTactics: [], readyForPrioritize: false });
  }

  it("shows the new counts and rows, not the retired gap", () => {
    render(workbench(before));
    expect(chipText()).toContain("Partial (1)");
    expect(chipText()).toContain("Unconfirmed (2)");
    expect(container.textContent).toContain("Gap GAP-001");

    render(workbench(after));
    expect(chipText()).toContain("All (2)");
    expect(chipText()).toContain("Partial (0)");
    expect(chipText()).toContain("Unconfirmed (1)");
    expect(container.textContent).not.toContain("Gap GAP-001");
    expect(container.textContent).toContain("Gap GAP-003");
  });

  it("keeps the person's filter across the refresh", () => {
    render(workbench(before));
    const unconfirmed = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Unconfirmed ("))!;
    act(() => unconfirmed.click());
    expect(unconfirmed.getAttribute("aria-pressed")).toBe("true");

    render(workbench(after));
    const chip = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Unconfirmed ("))!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // Only the one gap still unconfirmed is listed.
    expect(container.textContent).toContain("Gap GAP-002");
    expect(container.textContent).not.toContain("Gap GAP-003");
  });

  it("drops 'Unconfirmed' from a row once the refreshed card is confirmed", () => {
    render(workbench([open]));
    expect(container.querySelector('[data-gap-id="GAP-002"]')?.textContent).toContain("Unconfirmed");
    render(workbench([{ ...open, human_validated: true }]));
    expect(container.querySelector('[data-gap-id="GAP-002"]')?.textContent).not.toContain("Unconfirmed");
  });
});

describe("Prioritization Matrix follows the refreshed placements", () => {
  const axes: PriorityAxis[] = [
    { id: "impact", label: "Impact", description: "", weight: 1, low_label: "Low", high_label: "High" },
    { id: "urgency", label: "Urgency", description: "", weight: 1, low_label: "Low", high_label: "High" },
  ];
  const identity = { signed_in: true, actor_name: "A. Rao", actor_function: "medical_affairs" as const };

  function gap(id: string, overrides: Partial<PrioritizeGap> = {}): PrioritizeGap {
    return {
      gap_id: id,
      gap_name: `Gap ${id}`,
      statement: "",
      domain_label: "Efficacy",
      settings: [],
      tactic_count: 0,
      axis_scores: null,
      band: null,
      validated: false,
      suggested_band: null,
      suggested_rationale: null,
      human_axes: [],
      human_band: false,
      rationale: null,
      actor_name: null,
      at: null,
      ...overrides,
    };
  }

  function matrix(gaps: PrioritizeGap[]) {
    return createElement(PrioritizeMatrix, {
      scope: "all",
      gaps,
      axes,
      xAxis: axes[0]!,
      yAxis: axes[1]!,
      identity,
      mayPrioritize: true,
    });
  }

  function highCount() {
    const chip = [...container.querySelectorAll('[aria-label="Highlight a priority"] button')][0]!;
    return chip.textContent ?? "";
  }

  it("puts the placed gaps in their quadrants when the placement run's refresh lands", () => {
    render(matrix([gap("GAP-001"), gap("GAP-002")]));
    expect(highCount()).toMatch(/0$/);

    const placed = { axis_scores: { impact: 90, urgency: 90 }, band: "high" as const, suggested_band: "high" as const };
    render(matrix([gap("GAP-001", placed), gap("GAP-002", placed)]));
    expect(highCount()).toMatch(/2$/);
  });

  it("shows Validated once the refreshed placement is validated", () => {
    const placed = { axis_scores: { impact: 90, urgency: 90 }, band: "high" as const };
    render(matrix([gap("GAP-001", placed)]));
    expect(container.textContent).toContain("Draft");
    render(matrix([gap("GAP-001", { ...placed, validated: true, actor_name: "A. Rao" })]));
    expect(container.textContent).not.toContain("Draft");
    expect(container.textContent).toContain("Validated");
  });
});

describe("usePageRefresh", () => {
  let hook: ReturnType<typeof usePageRefresh>;
  function Probe() {
    hook = usePageRefresh();
    return null;
  }

  it("refreshes in place and runs the follow-up with it", () => {
    render(createElement(Probe));
    const then = vi.fn();
    act(() => hook.refresh(then));
    expect(then).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("navigates with a push and no refresh, which would cancel the push", () => {
    render(createElement(Probe));
    act(() => hook.navigate("/?place=plan"));
    expect(router.push).toHaveBeenCalledWith("/?place=plan");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("dialogs whose confirm moves on", () => {
  it("LockForm with href goes there after the action saves", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      createElement(LockForm, {
        label: "Continue to prioritize",
        action: "complete_wizard",
        confirmLabel: "Go to prioritize",
        href: "/?place=plan",
      }),
    );
    const trigger = [...document.querySelectorAll("button")].find((b) => b.textContent === "Continue to prioritize")!;
    await act(async () => trigger.click());
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Go to prioritize")!;
    expect(confirm).toBeTruthy();
    await act(async () => confirm.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).action).toBe("complete_wizard");
    expect(router.push).toHaveBeenCalledWith("/?place=plan");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("LockForm without href refreshes in place", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    render(createElement(LockForm, { label: "Confirm status", action: "validate_gap", confirmLabel: "Confirm Open" }));
    const trigger = [...document.querySelectorAll("button")].find((b) => b.textContent === "Confirm status")!;
    await act(async () => trigger.click());
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Confirm Open")!;
    await act(async () => confirm.click());
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("Continue to prioritize and Continue to tactics name the next place", () => {
    expect(src("src/components/gaps-workbench.tsx")).toMatch(/action="complete_wizard"[\s\S]{0,80}href="\/\?place=plan"/);
    expect(src("src/components/prioritize/prioritize-place.tsx")).toMatch(/action="unlock_tactics"[\s\S]{0,120}href="\/\?place=tactics"/);
  });
});

describe("every customer action refreshes through usePageRefresh", () => {
  const files = [
    "src/components/platform/action-dialog.tsx",
    "src/components/platform/run-stage-button.tsx",
    "src/components/lock-form.tsx",
    "src/components/split-gap-dialog.tsx",
    "src/components/gap-status-override.tsx",
    "src/components/prioritize/prioritize-matrix.tsx",
  ];
  it.each(files)("%s has no bare router.refresh()", (file) => {
    const text = src(file);
    expect(text).toContain("usePageRefresh");
    expect(text).not.toMatch(/router\.refresh\(\)/);
  });
});
