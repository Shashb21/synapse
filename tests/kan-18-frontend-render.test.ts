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
import { SuggestionReferences } from "@/components/prioritize/suggestion-references";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { LockForm } from "@/components/lock-form";
import { GapsWorkbench } from "@/components/gaps-workbench";
import { PrioritizeMatrix, type PrioritizeGap } from "@/components/prioritize/prioritize-matrix";
import { GapRecordSections } from "@/components/gap-record-sections";
import type { GapRecord } from "@/lib/iegp/gap-record";
import { buildSeed } from "@/lib/iegp/seed";
import { EvidenceDecisionContext } from "@/components/prioritize/priority-context";
import { EntityHistory } from "@/components/entity-history";
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

it("priority history exposes complete old/new judgements and identifies missing historical reasons", () => {
  const snapshot = JSON.stringify({ band: "high", axis_scores: { impact: 80 }, rationale: "The full priority explanation ".repeat(15), confirmed: true });
  act(() => root.render(createElement(EntityHistory, { entries: [{
    id: "legacy-decision", at: "2025-01-01T00:00:00Z", kind: "edit", entity_type: "gap", entity_id: "GAP-A",
    action: "validate", field: "placement", before: snapshot, after: snapshot, rationale: null,
    actor_name: "Earlier reviewer", actor_function: "medical_affairs", actor_principal: null, actor_role: null, request_id: null,
  }] })));
  expect(container.textContent).toContain("Reason not recorded");
  const full = container.querySelector("details");
  expect(full?.querySelector("summary")?.textContent).toBe("Show full change");
  expect(full?.textContent).toContain("Priority confirmed");
  expect(full?.textContent).toContain("The full priority explanation ".repeat(15).trim());
});

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

describe("priority decision context", () => {
  it("shows unknown context without blocking manual priority review", () => {
    act(() => root.render(createElement(PrioritizeMatrix, {
      scope: "all",
      gaps: [{ ...gap("GAP-CONTEXT", 80, 75), statement: "Comparative evidence is missing.", band: "high" }],
      axes: [axis("impact"), axis("urgency")],
      xAxis: axis("impact"),
      yAxis: axis("urgency"),
      identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" },
      mayPrioritize: true,
    })));
    act(() => (container.querySelector('button[aria-label^="Gap GAP-CONTEXT:"]') as HTMLButtonElement).click());
    const detail = container.querySelector("article")!;
    expect(detail.textContent).toContain("Evidence needed");
    expect(detail.textContent).toContain("Comparative evidence is missing.");
    for (const label of ["Objective", "Affected decision", "Decision date", "Evidence needed by"]) {
      const term = [...detail.querySelectorAll("dt")].find((node) => node.textContent === label);
      expect(term?.nextElementSibling?.textContent).toBe("Unknown");
    }
    expect(detail.textContent).toContain("Priority applies across all settings");
    expect(byText("Review and confirm priority").disabled).toBe(false);
    expect(detail.textContent).not.toContain("Continue to tactics");
  });

  it("explains a confirmed High priority's plan-wide gate and retained Tactics access", () => {
    const render = (tacticsUnlocked: boolean) => act(() => root.render(createElement(PrioritizeMatrix, {
      scope: "1L",
      gaps: [{ ...gap("GAP-HIGH", 80, 75), band: "high", validated: true,
        statement: "Missing comparative evidence.",
        objective: { name: "Support access", key_decision: "Submit the dossier", decision_date: "2027-06-20" },
        rationale: "Blocks the dossier", actor_name: "Human reviewer", human_axes: ["impact"],
      }],
      axes: [axis("impact"), axis("urgency")], xAxis: axis("impact"), yAxis: axis("urgency"),
      identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" },
      mayPrioritize: true, tacticsUnlocked,
    })));
    render(false);
    act(() => (container.querySelector('button[aria-label^="Gap GAP-HIGH:"]') as HTMLButtonElement).click());
    const detail = () => container.querySelector("article")!;
    expect(detail().textContent).toContain("Support access");
    expect(detail().textContent).toContain("Submit the dossier");
    expect(detail().textContent).toContain("2027-06-20");
    expect(detail().textContent).toContain("Evidence needed byUnknown");
    expect(detail().textContent).toContain("Priority confirmed by Human reviewer");
    expect(detail().textContent).toContain("80 / 100 · set by hand");
    expect(detail().textContent).toContain("Blocks the dossier");
    expect([...detail().querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toContainEqual(["/?place=plan&setting=all", "Review remaining plan-wide priorities"]);
    expect(detail().textContent).not.toContain("Continue to tactics");
    render(true);
    expect([...detail().querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toContainEqual(["/?place=tactics", "Continue to tactics"]);
    expect(byText("Review or change priority")).toBeTruthy();
  });


  it("shows a supplied evidence deadline separately from the decision date", () => {
    act(() => root.render(createElement(EvidenceDecisionContext, {
      statement: "No comparative persistence evidence.",
      objective: { name: "HTA access", key_decision: "Submit dossier", evidence_needed_by: "2027-04-01", decision_date: "2027-06-20" },
    })));
    const value = (label: string) => [...container.querySelectorAll("dt")].find((node) => node.textContent === label)?.nextElementSibling?.textContent;
    expect(value("Evidence needed by")).toBe("2027-04-01");
    expect(value("Decision date")).toBe("2027-06-20");
  });

  it("lets an unset gap be prioritized by hand and keeps viewers read-only", () => {
    const render = (mayPrioritize: boolean) => act(() => root.render(createElement(PrioritizeMatrix, {
      scope: "all", gaps: [{ ...gap("GAP-UNSET", 0, 0), axis_scores: null }],
      axes: [axis("impact"), axis("urgency")], xAxis: axis("impact"), yAxis: axis("urgency"),
      identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" }, mayPrioritize,
    })));
    render(true);
    act(() => (container.querySelector('[data-testid="unplaced-gap"]') as HTMLButtonElement).click());
    expect(byText("Set priority").disabled).toBe(false);
    render(false);
    expect(byText("Set priority")).toBeUndefined();
    expect(byText("Review and confirm priority")).toBeUndefined();
    expect(container.textContent).toContain("Evidence needed");
  });

});

it("withholds newer references when inspecting an earlier displayed suggestion", async () => {
  const reference = { entity_type: "gap" as const, entity_id: "GAP-A", reason: "Supports suggestion A" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "version-b", references: [{
    entity_type: "gap", entity_id: "GAP-B", reason: "Supports suggestion B", title: "Newer suggestion B reference", excerpt: "Evidence supplied for B", href: "/gaps/GAP-B",
  }] }), { status: 200, headers: { "content-type": "application/json" } })));
  act(() => root.render(createElement(SuggestionReferences, { gapId: "GAP-A", version: "version-a", references: [reference] })));
  await act(async () => { byText("Inspect supporting references").click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/suggestion changed.*refresh.*inspect/i);
  expect(container.textContent).not.toContain("Newer suggestion B reference");
  expect(container.querySelector('a[href="/gaps/GAP-B"]')).toBeNull();
});

describe("the full gap record priority", () => {
  const seed = buildSeed();
  const record = (priority: GapRecord["priority"]): GapRecord => ({
    gap: seed.gaps[0]!, objective: seed.objectives[0]!,
    confirmation: { confirmed: false, by: null, at: null, rationale: null },
    parent: null, origin: null, children: [], related: [], needs: [], candidates: [],
    coverages: [], expansions: [], mapping_rejections: [], priority,
    ideas: [], timeline: [], breakout_groups: [], pending_suggestions: [], residuals: [], versions: [], history: [],
  });
  const priority: NonNullable<GapRecord["priority"]> = {
    gap_id: seed.gaps[0]!.id, run_id: null, band: null, suggested_band: "high", suggested_references: [], suggested_rationale: "Suggested for the dossier",
    axis_scores: { impact: 82, urgency: 76 }, validated: false, rationale: null, needs_review: false, review_reason: null, review_event_id: null,
    actor_name: "Reviewer", actor_function: "medical_affairs", at: "2026-10-16T13:00:00Z",
  };

  it("offers review for an unconfirmed suggestion without presenting its rationale as a human reason", () => {
    act(() => root.render(createElement(GapRecordSections, { record: record(priority), axes: [axis("impact"), axis("urgency")], open: true })));
    const section = container.querySelector('[data-testid="gap-priority"]')!;
    expect(section.textContent).toContain("High");
    expect(section.textContent).toContain("82 / 100");
    expect(section.textContent).toContain("76 / 100");
    expect(section.textContent).toContain("Reason not recorded");
    expect([...section.querySelectorAll("a")].map((a) => a.textContent)).toContain("Review and confirm priority");
  });

  it("labels an older model suggestion with missing reasoning and references honestly", () => {
    act(() => root.render(createElement(AiStatusProvider, { enabled: true }, createElement(GapRecordSections, { record: record({ ...priority, run_id: "older-model-run", suggested_rationale: "" }), axes: [], open: true }))));
    const section = container.querySelector('[data-testid="gap-priority"]')!;
    expect(section.textContent).toContain("Reason not recorded");
    expect(section.textContent).toContain("Supporting references not recorded for this suggestion");
  });

  it("does not present a wholly manual placement as an unsupported model suggestion", () => {
    act(() => root.render(createElement(AiStatusProvider, { enabled: true }, createElement(GapRecordSections, { record: record({ ...priority, run_id: null, suggested_rationale: "", rationale: "Human planning judgement" }), axes: [], open: true }))));
    const section = container.querySelector('[data-testid="gap-priority"]')!;
    expect(section.textContent).toContain("Human planning judgement");
    expect(section.textContent).not.toContain("Supporting references not recorded for this suggestion");
  });

  it.each([
    ["high", true, true, "Continue to tactics"],
    ["high", false, true, "Priority confirmed"],
    ["high", true, false, "Priority confirmed"],
    ["medium", true, true, "Priority confirmed"],
    ["low", true, true, "Priority confirmed"],
    ["defer", true, true, "Priority confirmed"],
  ] as const)("preserves next-action eligibility for %s, Open=%s, Tactics=%s", (band, open, tacticsUnlocked, action) => {
    act(() => root.render(createElement(GapRecordSections, {
      record: record({ ...priority, band, validated: true, rationale: "Human rationale" }),
      axes: [axis("impact"), axis("urgency")], open, tacticsUnlocked,
    })));
    const section = container.querySelector('[data-testid="gap-priority"]')!;
    expect(section.textContent).toContain("Human rationale");
    expect([...section.querySelectorAll("a")].map((a) => a.textContent)).toContain(action);
    if (action !== "Continue to tactics") expect(section.textContent).not.toContain("Continue to tactics");
  });
});

describe("Prioritize matrix nudges", () => {
  it("keyboard movement opens a reason step without saving either gap", async () => {
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
    expect(moved).toEqual([]);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Reason for change");
  });
});

describe("Prioritize matrix nudges on unload", () => {
  it("leaving with unreasoned keyboard movements never sends a save", () => {
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
    expect(sent).toEqual([]);
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
