/** @vitest-environment jsdom */
/** Planning is a saved relationship fact, independent of scientific coverage or delivery. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TacticExpansion } from "@/lib/iegp/types";
import { buildSeed } from "@/lib/iegp/seed";
import { mappedTactics, emptyDimensions, unlocked, type OpenGapCard, type PlanTactic } from "@/lib/iegp/engine";
import { IdeationBoard } from "@/components/tactic-ideation/ideation-board";
import { planningLabel, filterPlanningGaps, summarizePlanning } from "@/components/tactic-ideation/planning";
import { loadTacticIdeation, type RetainedTacticGap } from "@/components/tactic-ideation/data";

const mocks = vi.hoisted(() => ({ loadState: vi.fn(), placements: vi.fn(), proposals: vi.fn() }));
vi.mock("@/lib/iegp/store", () => ({ loadState: mocks.loadState }));
vi.mock("@/modules/stages/s8-prioritization/module", () => ({ listPlacements: mocks.placements }));
vi.mock("@/modules/stages/s9-ideation/module", () => ({ listIdeationProposals: mocks.proposals, ideationBandOrder: () => new Set() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext: async () => ({ signed_in: true, actor: { name: "Reviewer", function: "medical_affairs" }, role: "medical_affairs" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { signed_in: true, actor_name: "Reviewer", actor_function: "medical_affairs" as const };

function fixture(status: PlanTactic["status"] = "proposed", overall: PlanTactic["overall"] = "unassessed") {
  const state = buildSeed();
  const gap = state.gaps[0]!;
  const tactic = state.tactics[0]!;
  gap.status = "validated_open";
  gap.status_override = null;
  tactic.status = status;
  tactic.review_status = "accepted";
  tactic.evidence_available = null;
  state.gaps = [gap];
  state.tactics = [tactic];
  state.coverages = [{ id: "coverage", gap_id: gap.id, tactic_id: tactic.id, overall: overall!, dimensions: emptyDimensions(), overall_rationale: "Recorded scope", overall_lock: unlocked(), stale: false, needs_review: false }];
  const card = { statement: gap.statement, settings: gap.settings ?? [], metadata: gap.metadata, gap_status: "validated_open" as const, computed_status: "validated_open" as const, suggested_status: "validated_open" as const, status_override: null, counting_join_count: 0, parent_gap_id: null, residual: null, band: "high" as const, gap_id: gap.id, gap_name: "Comparison evidence", number: 1, domain: "comparative_effectiveness" as const, tactics: mappedTactics(state, gap.id) };
  return { state, card };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); mocks.placements.mockResolvedValue([]); mocks.proposals.mockResolvedValue([]); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(gaps: OpenGapCard[], retainedGaps: RetainedTacticGap[] = []) {
  act(() => root.render(createElement(IdeationBoard, { gaps, retainedGaps, proposals: [], library: [], identity, mayIdeate: false })));
}
function change(select: HTMLSelectElement, value: string) { act(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); }

it.each(["proposed", "cancelled", "planned", "ongoing", "completed"] as const)("keeps %s lifecycle separate from assessment and documented evidence", status => {
  const { card } = fixture(status);
  expect(planningLabel(card.tactics)).toBe(["planned", "ongoing", "completed"].includes(status) ? "Tactic planned" : "Candidate linked");
  render([card]);
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="ideation-gap-toggle"]')!.click());
  const row = host.querySelector('[data-testid="linked-planning-facts"]')!;
  expect(row.textContent).toContain("Coverage: Not yet assessed");
  expect(row.textContent).toContain("Human confirmation: Not confirmed");
  expect(row.textContent).toContain("Evidence availability: Not documented");
  expect(host.querySelector('[data-testid="ideation-gap"]')!.textContent).toContain(status);
});

it("shows no saved candidate for an option without a mapping", () => {
  const { card } = fixture();
  card.tactics = [];
  expect(planningLabel(card.tactics)).toBe("No candidate linked");
  render([card]);
  expect(host.querySelector('[data-testid="ideation-gap-toggle"]')!.textContent).toContain("No candidate linked");
});

it("retains recorded Partial, unknown dimensions, stale qualification and remaining need", () => {
  const { card } = fixture("planned", "partial");
  const tactic = card.tactics[0]!;
  tactic.stale = true;
  tactic.fit!.stale = true;
  render([card]);
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="ideation-gap-toggle"]')!.click());
  expect(host.textContent).toContain("Coverage: Partial");
  expect(host.querySelector('[data-testid="linked-planning-facts"]')!.textContent).toContain("Outdated");
  expect(host.querySelector('[data-testid="linked-planning-facts"]')!.textContent).toContain("Unknown information remains");
  expect(host.textContent).toContain("Unknown information");
  expect(host.textContent).toContain("Unanswered requirements for this tactic");
  expect(host.textContent).toContain("Delivery of evidence has not been verified by this view");
});

it("counts and filters the same current and retained populations, including no match", () => {
  const { card } = fixture();
  const planned = { ...card, gap_id: "planned", gap_name: "Planned comparison", tactics: [{ ...card.tactics[0]!, status: "planned" as const }] };
  const empty = { ...card, gap_id: "empty", gap_name: "Safety question", domain: "safety_tolerability" as OpenGapCard["domain"], tactics: [] };
  expect(summarizePlanning([card, planned, empty])).toEqual({ total: 3, unlinked: 1, linked: 1, planned: 1 });
  expect(filterPlanningGaps([card, planned, empty], { query: "comparison", domain: card.domain, links: "linked" })).toEqual([card, planned]);
  expect(summarizePlanning(filterPlanningGaps([card], { query: "missing", domain: "", links: "" }))).toEqual({ total: 0, unlinked: 0, linked: 0, planned: 0 });
  const retained: RetainedTacticGap = { ...planned, gap_status: "validated_partial", band: "high", needs_review: false, priority_confirmed: true, tactic_count: 1, option_count: 0 };
  render([card, empty], [retained]);
  change(host.querySelector<HTMLSelectElement>('[aria-label="Filter by domain"]')!, card.domain);
  change(host.querySelector<HTMLSelectElement>('[aria-label="Filter by tactics"]')!, "linked");
  expect(host.querySelector('[data-testid="current-planning-summary"]')!.textContent).toBe("Current eligible gaps: 1 shown · No candidate linked: 0 · Candidate linked: 1 · Tactic planned: 0");
  expect(host.querySelector('[data-testid="retained-planning-summary"]')!.textContent).toBe("Retained work: 1 shown · No candidate linked: 0 · Candidate linked: 0 · Tactic planned: 1");
  expect(host.querySelector('[aria-label="Existing options and planned work"]')!.textContent).toContain("Coverage: Not yet assessed");
  change(host.querySelector<HTMLSelectElement>('[aria-label="Filter by tactics"]')!, "unlinked");
  expect(host.querySelector('[data-testid="current-planning-summary"]')!.textContent).toContain("0 shown");
  expect(host.querySelector('[data-testid="retained-planning-summary"]')!.textContent).toContain("0 shown");
});

it("loads only valid mapped retained rows, preserving parent and expansion identity", async () => {
  const { state } = fixture("planned", "partial");
  const coverage = state.coverages[0]!;
  const tactic = state.tactics[0]!;
  const expansion: TacticExpansion = {
    id: "child", tactic_id: tactic.id, gap_ids: [coverage.gap_id], status: "proposed", proposal_id: "accepted-option", version: "1", history: [],
    created_at: "2026-10-22", updated_at: "2026-10-22", actor: { name: "Reviewer", function: "medical_affairs" },
    scope: { name: "Expanded comparison", evidence_question: "Child question", evidence_available: "2027-01-01", population: "Adults", outcomes: "Survival", geography: "UK", data_cut: "", analysis: "Subgroup", instrument: "", study_design: "Observational", gap_coverage: "Comparison", cost_effort: "", timing: "", feasibility_risks: "", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null },
  };
  // Deliberately malformed endpoint fixtures exercise the existing mapper's validation.
  state.expansions = [expansion];
  state.coverages.push({ ...coverage, id: "child-link", expansion_id: "child" }, { ...coverage, id: "broken-tactic", tactic_id: "missing" }, { ...coverage, id: "broken-child", expansion_id: "missing" });
  mocks.loadState.mockResolvedValue(state);
  const data = await loadTacticIdeation([]);
  expect(data.retainedGaps).toHaveLength(1);
  expect(data.retainedGaps[0]!.tactic_count).toBe(2);
  expect(data.retainedGaps[0]!.tactics.map(row => [row.id, row.expansion_id ?? null])).toEqual([[tactic.id, null], [tactic.id, "child"]]);
  expect(data.retainedGaps[0]!.tactics[1]!.fit!.contribution.evidence_available).toBe("2027-01-01");
  render([], data.retainedGaps);
  expect(host.querySelectorAll('[data-testid="linked-planning-facts"]')).toHaveLength(2);
  expect(host.textContent).toContain("Expanded comparison");
  expect(host.textContent).toContain("Recorded date 2027-01-01");
});

it("ignores retained gaps with only broken references and does not count unsaved options as links", async () => {
  const { state } = fixture();
  state.coverages[0]!.tactic_id = "missing";
  mocks.loadState.mockResolvedValue(state);
  expect((await loadTacticIdeation([])).retainedGaps).toEqual([]);
  mocks.proposals.mockResolvedValue([{ id: "option", gap_id: state.gaps[0]!.id, status: "proposed" }]);
  const data = await loadTacticIdeation([]);
  expect(data.retainedGaps[0]).toMatchObject({ tactics: [], tactic_count: 0, option_count: 1 });
  render([], data.retainedGaps);
  expect(host.querySelector('[data-testid="retained-planning-summary"]')!.textContent).toContain("No candidate linked: 1");
});

it("keeps human confirmation and recorded Full visible for retained Addressed planned work", () => {
  const { card } = fixture("planned", "full");
  card.tactics[0]!.fit!.confirmation = { ...unlocked(), locked: true, actor_name: "Human reviewer" };
  card.tactics[0]!.fit!.full_eligible = true;
  const retained: RetainedTacticGap = { ...card, gap_status: "validated_addressed", band: "high", needs_review: false, priority_confirmed: true, tactic_count: 1, option_count: 0 };
  render([], [retained]);
  expect(host.textContent).toContain("Addressed");
  expect(host.textContent).toContain("Coverage: Full");
  expect(host.textContent).toContain("Human confirmation: Confirmed by Human reviewer");
  expect(host.textContent).toContain("Lifecycle: planned");
  expect(host.textContent).toContain("Evidence availability: Not documented");
});

it("explains scientific planning rules in the accessible guide without a completion bar", () => {
  render([]);
  const guide = host.querySelector('[aria-label="How Tactic Ideation works"]')!;
  expect(guide.textContent).toContain("Planning alone does not make a gap Addressed");
  expect(guide.textContent).toContain("human-confirmed Full coverage can count while planned");
  expect(guide.textContent).toContain("Publication tactics with evidence already available can count even when proposed");
  expect(guide.textContent).toContain("A link or lifecycle does not verify delivery of evidence");
  expect(guide.querySelector('[aria-hidden]')).toBeNull();
});
