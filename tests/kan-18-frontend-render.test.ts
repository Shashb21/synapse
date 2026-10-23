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
import { sourceClaimReviewData, sourceReviewTargetVersion } from "@/lib/iegp/source-review";
import { SourceClaimReviewContent } from "@/components/source-claim-review-content";
import { SuggestionReferences } from "@/components/prioritize/suggestion-references";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { LockForm } from "@/components/lock-form";
import { GapPanel } from "@/components/gap-panel";
import { GapsWorkbench } from "@/components/gaps-workbench";
import { PrioritizeMatrix, type PrioritizeGap } from "@/components/prioritize/prioritize-matrix";
import { GapCoverageContext, GapRecordSections } from "@/components/gap-record-sections";
import type { GapRecord } from "@/lib/iegp/gap-record";
import { getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
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

it("history identifies shared objective context and missing model support without inventing values", () => {
  act(() => root.render(createElement(EntityHistory, { entries: [{
    id: "shared-deadline", at: "2026-10-16T12:00:00Z", kind: "edit", entity_type: "objective", entity_id: "OBJ-A", shared_context: true,
    action: "edit", field: "evidence_needed_by", before: "2027-01-01", after: "2027-02-01", rationale: null,
    actor_name: "Context editor", actor_function: "medical_affairs", actor_principal: null, actor_role: null, request_id: null,
  }, {
    id: "older-suggestion", at: "2026-10-15T12:00:00Z", kind: "edit", entity_type: "gap", entity_id: "GAP-A",
    action: "suggest", field: "placement", before: null, after: "High", rationale: null,
    actor_name: "Model", actor_function: "system", actor_principal: null, actor_role: null, request_id: null,
  }] })));
  expect(container.textContent).toContain("Shared context");
  expect(container.textContent).toContain("objective OBJ-A");
  expect(container.textContent).toContain("2027-01-01");
  expect(container.textContent).toContain("2027-02-01");
  expect(container.textContent).toContain("Reason not recorded");
  expect(container.textContent).toContain("Supporting references not recorded for this suggestion");
  expect(container.textContent).toContain("older changes may be omitted");
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
    [...container.querySelectorAll('[aria-label="Evidence status"] button')]
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
    expect(pressed()).toEqual(["All evidence statuses"]);
    render("open");
    expect(pressed()).toEqual(["Open"]);

    const chips = [...container.querySelectorAll('[aria-label="Evidence status"] button')] as HTMLButtonElement[];
    const other = chips.find((chip) => chip.getAttribute("aria-pressed") !== "true" && /^Partially Addressed/.test(chip.textContent ?? ""))!;
    act(() => other.click());
    expect(new URL(window.location.href).searchParams.get("gap_filter")).toBe("partial");
    expect(new URL(window.location.href).searchParams.get("place")).toBe("gaps");
    const attention = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Review state"] button')]
      .find((button) => button.textContent?.startsWith("Needs attention"))!;
    act(() => attention.click());
    expect(new URL(window.location.href).searchParams.get("gap_attention")).toBe("needs_attention");
    expect(new URL(window.location.href).searchParams.get("gap_filter")).toBe("partial");
    act(() => chips.find((chip) => /^All/.test(chip.textContent ?? ""))!.click());
    expect(new URL(window.location.href).searchParams.has("gap_filter")).toBe(false);
    expect(new URL(window.location.href).searchParams.get("gap_attention")).toBe("needs_attention");
    act(() => attention.click());
    expect(new URL(window.location.href).searchParams.has("gap_attention")).toBe(false);
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

function panelRecord(gap: PrioritizeGap, tacticsUnlocked = false): GapRecord {
  const seed = buildSeed();
  return {
    requirement_review: getRequirementBasisReview(seed, seed.gaps[0]!.id),
    gap: { ...seed.gaps[0]!, id: gap.gap_id, name: gap.gap_name, statement: gap.statement },
    objective: gap.objective ? { ...seed.objectives[0]!, ...gap.objective } : null,
    coverage_status: { computed: "validated_open", shown: "validated_open", needs_review: false },
    confirmation: { confirmed: false, by: null, at: null, rationale: null },
    parent: null, origin: null, children: [], related: [], needs: [], candidates: [],
    coverages: [], expansions: [], mapping_rejections: [],
    priority: gap.band || gap.suggested_band ? { ...gap,
      suggested_band: gap.suggested_band ?? gap.band!, suggested_rationale: gap.suggested_rationale ?? "",
      suggested_references: [], run_id: null, needs_review: false, review_reason: null, review_event_id: null, version: gap.version ?? undefined,
      actor_function: "medical_affairs", at: gap.at ?? "2026-10-16T12:00:00Z",
    } : null,
    ideas: [], timeline: [], breakout_groups: [], pending_suggestions: [], residuals: [], versions: [], history: [],
    priority_axes: [axis("impact"), axis("urgency")], tactics_unlocked: tacticsUnlocked, open: true,
  };
}
function mockGapRead(record: GapRecord) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } })));
}

describe("gap panel priority draft continuity", () => {
  it.each(["equivalent", "changed", "failed"])("retains the open draft and submitted snapshot through %s parent props", async kind => {
    const original = { ...gap("GAP-DRAFT", 80, 75), band: "high" as const, version: "saved-v1" };
    const initial = panelRecord(original);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let revalidating = false;
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        submitted = JSON.parse(String(options.body));
        return new Response(JSON.stringify({ error: "Priority changed; retain your draft" }), { status: 400 });
      }
      if (revalidating) {
        await hold;
        if (kind === "failed") throw new Error("Gap details could not be loaded. Try again.");
      }
      return new Response(JSON.stringify(revalidating ? { ...initial, priority: { ...initial.priority, version: "saved-v2", rationale: "Latest saved rationale" } } : initial));
    }));
    const render = (version: string) => act(async () => root.render(createElement(PrioritizeMatrix, {
      scope: "all", gaps: [{ ...original, version }], axes: [axis("impact"), axis("urgency")],
      xAxis: axis("impact"), yAxis: axis("urgency"),
      identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" }, mayPrioritize: true,
    })));
    await render("saved-v1");
    await act(async () => (container.querySelector('button[data-gap-id="GAP-DRAFT"]') as HTMLButtonElement).click());
    await act(async () => byText("Edit scores").click());
    const rationale = document.querySelector('textarea[name="rationale"]') as HTMLTextAreaElement;
    const reason = document.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    // Change controls through the DOM just as a person does; keep the original form node as evidence.
    const fill = (control: HTMLTextAreaElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => { fill(rationale, "Unsaved rationale"); fill(reason, "Reason still being written"); });
    revalidating = true;
    try {
      await render(kind === "equivalent" ? "saved-v1" : "saved-v2");
      expect(document.querySelector('textarea[name="rationale"]')).toBe(rationale);
      expect(rationale.value).toBe("Unsaved rationale");
      expect(reason.value).toBe("Reason still being written");
    } finally { await act(async () => { release(); }); }
    expect(document.querySelector('textarea[name="rationale"]')).toBe(rationale);
    expect(rationale.value).toBe("Unsaved rationale");
    if (kind === "changed") expect(document.querySelector('[data-testid="gap-priority"]')?.textContent).toContain("Latest saved rationale");
    if (kind === "failed") expect(document.querySelector('[data-testid="gap-panel"]')?.textContent).toContain("could not be loaded");
    await act(async () => rationale.closest("form")!.requestSubmit());
    expect(submitted).toMatchObject({ expected_version: "saved-v1", rationale: "Unsaved rationale", reason: "Reason still being written" });
    expect(rationale.closest("form")?.querySelector('[role="alert"]')?.textContent).toContain("retain your draft");
    expect(rationale.value).toBe("Unsaved rationale");
    expect(reason.value).toBe("Reason still being written");
  });
});

it("shares confirmed coverage, review flags and recorded actor/reason without changing status", () => {
  const record = panelRecord({ ...gap("GAP-COVERAGE", 80, 75), band: "high" });
  record.coverage_status = { computed: "validated_partial", shown: "validated_partial", needs_review: true };
  record.confirmation = { confirmed: true, by: { principal: "reviewer@example.test", name: "Coverage reviewer", function: "medical_affairs", role: "medical_affairs" }, at: "2026-10-16T12:00:00Z", rationale: "Reviewed the partial evidence" };
  act(() => root.render(createElement(GapCoverageContext, { record })));
  expect(container.textContent).toContain("Partially Addressed");
  expect(container.textContent).toContain("Review coverage");
  expect(container.textContent).toContain("Confirmed by Coverage reviewer");
  expect(container.textContent).toContain("Reviewed the partial evidence");
  expect(container.querySelector("a")?.textContent).toBe("Resolve — split or rewrite");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/gaps/GAP-COVERAGE#gap-coverage-actions");
});

describe("priority decision context", () => {
  it("shows unknown context without blocking manual priority review", async () => {
    mockGapRead(panelRecord({ ...gap("GAP-CONTEXT", 80, 75), statement: "Comparative evidence is missing.", band: "high" }));
    act(() => root.render(createElement(PrioritizeMatrix, {
      scope: "all",
      gaps: [{ ...gap("GAP-CONTEXT", 80, 75), statement: "Comparative evidence is missing.", band: "high" }],
      axes: [axis("impact"), axis("urgency")],
      xAxis: axis("impact"),
      yAxis: axis("urgency"),
      identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" },
      mayPrioritize: true,
    })));
    await act(async () => (container.querySelector('button[aria-label^="Gap GAP-CONTEXT:"]') as HTMLButtonElement).click());
    const detail = document.querySelector('[data-testid="gap-panel"]')!;
    expect(detail.textContent).toContain("Evidence needed");
    expect(detail.textContent).toContain("Comparative evidence is missing.");
    for (const label of ["Objective", "Affected decision", "Decision date", "Evidence needed by"]) {
      const term = [...detail.querySelectorAll("dt")].find((node) => node.textContent === label);
      expect(term?.nextElementSibling?.textContent).toBe("Unknown");
    }
    expect(detail.textContent).toContain("Priority applies across all settings");
    expect(byText("Validate priority").disabled).toBe(false);
    expect(detail.textContent).not.toContain("Continue to tactics");
  });

  it("explains a confirmed High priority's plan-wide gate and retained Tactics access", async () => {
    const confirmedGap = { ...gap("GAP-HIGH", 80, 75), band: "high" as const, validated: true, statement: "Missing comparative evidence.", objective: { name: "Support access", key_decision: "Submit the dossier", decision_date: "2027-06-20" }, rationale: "Blocks the dossier", actor_name: "Human reviewer", human_axes: ["impact"] };
    const render = async (tacticsUnlocked: boolean) => {
      mockGapRead(panelRecord(confirmedGap, tacticsUnlocked));
      await act(async () => root.render(createElement(PrioritizeMatrix, {
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
    };
    await render(false);
    await act(async () => (container.querySelector('button[aria-label^="Gap GAP-HIGH:"]') as HTMLButtonElement).click());
    const detail = () => document.querySelector('[data-testid="gap-panel"]')!;
    expect(detail().textContent).toContain("Support access");
    expect(detail().textContent).toContain("Submit the dossier");
    expect(detail().textContent).toContain("2027-06-20");
    expect(detail().textContent).toContain("Evidence needed byUnknown");
    expect(detail().textContent).toContain("Priority validated by Human reviewer");
    expect(detail().textContent).toContain("80 / 100 · set by hand");
    expect(detail().textContent).toContain("Blocks the dossier");
    expect([...detail().querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toContainEqual(["/?place=plan&setting=all", "Review remaining plan-wide priorities"]);
    expect(detail().textContent).not.toContain("Continue to tactics");
    await render(true);
    expect([...detail().querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toContainEqual(["/?place=tactics", "Continue to tactics"]);
    expect(byText("Review or change validated priority")).toBeTruthy();
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

  it("lets an unset gap be prioritized by hand and keeps viewers read-only", async () => {
    mockGapRead(panelRecord({ ...gap("GAP-UNSET", 0, 0), axis_scores: null }));
    const render = (mayPrioritize: boolean) => act(async () => root.render(createElement(PrioritizeMatrix, {
      scope: "all", gaps: [{ ...gap("GAP-UNSET", 0, 0), axis_scores: null }],
      axes: [axis("impact"), axis("urgency")], xAxis: axis("impact"), yAxis: axis("urgency"),
      identity: { signed_in: true, actor_name: "Tester", actor_function: "medical_affairs" }, mayPrioritize,
    })));
    await render(true);
    await act(async () => (container.querySelector('[data-testid="unplaced-gap"]') as HTMLButtonElement).click());
    expect(byText("Set priority").disabled).toBe(false);
    await render(false);
    expect(byText("Set priority")).toBeUndefined();
    expect(byText("Validate priority")).toBeUndefined();
    expect(document.querySelector('[data-testid="gap-panel"]')?.textContent).toContain("Evidence needed");
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
    requirement_review: getRequirementBasisReview(seed, seed.gaps[0]!.id),
    gap: seed.gaps[0]!, objective: seed.objectives[0]!,
    coverage_status: { computed: "validated_open", shown: "validated_open", needs_review: false },
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
    expect([...section.querySelectorAll("a")].map((a) => a.textContent)).toContain("Validate priority");
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
    ["high", false, true, "Priority validated"],
    ["high", true, false, "Priority validated"],
    ["medium", true, true, "Priority validated"],
    ["low", true, true, "Priority validated"],
    ["defer", true, true, "Priority validated"],
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


it("renders populated source review data with scoped rows, correction tokens and stale-citation blocking", () => {
  const state = buildSeed();
  const coverage = state.coverages[0]!;
  const block = state.blocks[0]!;
  const source = state.sources.find(row => row.id === block.source_id)!;
  const current = {
    id: "REVIEW-current", version: "opening-review", kind: "discrepancy" as const, origin: "human" as const,
    source_id: source.id, block_id: block.id, passage: block.text,
    source_title: source.title, source_location: block.location,
    gap_id: coverage.gap_id, tactic_id: coverage.tactic_id, coverage_id: coverage.id,
    rationale: "Current citation requires explicit review", status: "pending" as const,
    created_at: "2026-10-17T00:00:00Z", created_by: { name: "Cited reviewer", function: "medical_affairs" as const }, history: [],
  };
  state.source_reviews = [current, { ...current, id: "REVIEW-stale", passage: "A passage replaced in the retained source", rationale: "Stale citation remains on record" }, { ...current, id: "REVIEW-foreign", gap_id: "GAP-OUTSIDE", rationale: "Out-of-scope private finding" }];
  const data = sourceClaimReviewData(state, { gapId: coverage.gap_id, tacticId: coverage.tactic_id });
  expect(data.rows.map(row => row.id)).toEqual(["REVIEW-current", "REVIEW-stale"]);
  expect(data.rows.map(row => row.current)).toEqual([true, false]);
  expect(data.relationships[0]!.label).toContain(state.tactics.find(row => row.id === coverage.tactic_id)!.name);
  expect(data.rows[0]!.corrections.find(row => row.target === "tactic")!.version).toBe(sourceReviewTargetVersion(state, current, "tactic"));
  expect(data.blocks.find(row => row.id === block.id)!.label).toContain(source.title);
  act(() => root.render(createElement(SourceClaimReviewContent, { data, identity: { signed_in: true, actor_name: "Reader", actor_function: "medical_affairs" }, canReview: true })));
  expect(container.textContent).toContain("Pending source discrepancy");
  expect(container.textContent).toContain(current.passage);
  expect(container.textContent).toContain("Acceptance is blocked");
  expect(container.textContent).not.toContain("Out-of-scope private finding");
  const cards = container.querySelectorAll('[data-testid="source-review"]');
  expect(cards[0]!.textContent).toContain("Review tactic correction");
  expect(cards[1]!.textContent).not.toContain("Review tactic correction");
  expect(cards[1]!.textContent).toContain("Dismiss discrepancy");
});


it.each(["requirement", "source"])("reloads gap panel data and write tokens after a successful %s review", async kind => {
  const state = buildSeed();
  const coverage = state.coverages[0]!;
  const block = state.blocks[0]!;
  const source = state.sources.find(row => row.id === block.source_id)!;
  state.source_reviews = [{
    id: "panel-review", version: "source-opening", kind: "discrepancy", origin: "human",
    source_id: source.id, block_id: block.id, passage: block.text,
    source_title: source.title, source_location: block.location,
    gap_id: coverage.gap_id, tactic_id: coverage.tactic_id, coverage_id: coverage.id,
    rationale: "A retained discrepancy for panel review", status: "pending",
    created_at: "2026-10-17T00:00:00Z", created_by: { name: "Panel reviewer", function: "medical_affairs" }, history: [],
  }];
  const initial = { ...panelRecord(gap(coverage.gap_id, 0, 0)), permissions: { coverage: true },
    source_review: sourceClaimReviewData(state, { gapId: coverage.gap_id }) };
  const updated = { ...initial, requirement_review: { ...initial.requirement_review, version: "requirement-after-save" },
    source_review: { ...initial.source_review, rows: initial.source_review.rows.map(row => ({ ...row, status: "dismissed" as const, version: "source-after-save" })) } };
  let reads = 0;
  const submitted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      submitted.push(JSON.parse(String(options.body)));
      return submitted.length === 1 ? Response.json({ ok: true }) : Response.json({ error: "Keep this proof dialog open" }, { status: 400 });
    }
    reads += 1;
    return Response.json(reads === 1 ? initial : updated);
  }));
  await act(async () => root.render(createElement(GapPanel, { gapId: coverage.gap_id, onClose: () => {}, returnFocusRef: { current: null } })));
  expect(reads).toBe(1);
  await act(async () => byText(kind === "source" ? "Dismiss discrepancy" : "Review requirement basis").click());
  const form = document.querySelector('[role="dialog"] form') as HTMLFormElement;
  (form.elements.namedItem("rationale") as HTMLTextAreaElement).value = "Explicitly reviewed the current source and requirements";
  await act(async () => form.requestSubmit());
  expect(submitted[0]).toMatchObject(kind === "source" ? { review_id: "panel-review", expected_version: "source-opening" } : { expected_version: initial.requirement_review.version });
  expect(reads).toBe(2);
  expect(document.body.textContent).toContain("Source discrepancy dismissed");
  await act(async () => byText("Review requirement basis").click());
  const next = document.querySelector('[role="dialog"] form') as HTMLFormElement;
  (next.elements.namedItem("rationale") as HTMLTextAreaElement).value = "The next review uses the reloaded token";
  await act(async () => next.requestSubmit());
  expect(submitted[1]).toMatchObject({ expected_version: "requirement-after-save" });
});
