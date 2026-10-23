/** @vitest-environment jsdom */
/** Render the decision guidance at the point where a reviewer acts. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProposalCard, type ProposalCardModel } from "@/components/ideation/proposal-card";
import { IdeationBoard } from "@/components/tactic-ideation/ideation-board";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { signed_in: true, actor_name: "Reviewer", actor_function: "medical_affairs" as const };
const proposal: ProposalCardModel = {
  id: "idea-1", gap_id: "gap-1", name: "Registry study", type: "registry", rationale: "Answer the decision", evidence_question: "Adult outcomes?",
  design: { population: "Adults", comparator: "Usual care", outcomes: "Survival", data_source: "Registry", study_design: "Observational", duration_months: 12, readout_lag_months: 1, timing_rationale: "Annual review" },
  status: "proposed", critic_note: null, judge_score: 80, created_at: "2026-10-21", decided_by: null, decision_rationale: null, tactic_id: null,
  proposal_kind: "new", target_tactic_id: null, expansion_id: null, expansion_scope: null, reviewed_parent: null, comparative_rationale: "", rank: null, origin: "human", edited_by: null, edited_at: null,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it.each(["new", "expansion"] as const)("explains %s acceptance without promising evidence", async kind => {
  act(() => root.render(createElement(ProposalCard, { proposal: { ...proposal, proposal_kind: kind }, identity, mayIdeate: true })));
  const accept = [...host.querySelectorAll("button")].find(button => button.textContent === "Accept")!;
  await act(async () => accept.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(kind === "new" ? "proposed tactic" : "proposed expansion");
  expect(dialog.textContent).toContain("coverage starts unassessed");
  expect(dialog.textContent).toContain("does not deliver evidence or automatically make the gap Addressed");
  expect(dialog.querySelector('[name="rationale"]')).not.toBeNull();
});

it("explains planning, assessed Full coverage and publication exceptions in the tactic guide", () => {
  act(() => root.render(createElement(IdeationBoard, { gaps: [], proposals: [], library: [], identity, mayIdeate: true })));
  const guide = host.querySelector('[data-testid="ideation-guide"]')!;
  expect(guide.textContent).toContain("Planning alone does not make a gap Addressed");
  expect(guide.textContent).toContain("human-confirmed Full coverage can count while planned");
  expect(guide.textContent).toContain("Publication tactics with evidence already available can count even when proposed");
  expect(guide.textContent).not.toContain("counts toward closing the gap");
});
