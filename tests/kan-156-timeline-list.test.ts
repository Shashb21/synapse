/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineActivityList } from "@/components/timeline/timeline-activity-list";
import { buildSeed } from "@/lib/iegp/seed";
import { buildTimeline } from "@/modules/stages/s10-timeline/build";
import { gapTimelineView, type GapTimelineItem } from "@/modules/stages/s10-timeline/gap-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());

function fixture() {
  const state = buildSeed();
  const model = buildTimeline({state, placements: [], overrides: []});
  const view = gapTimelineView({state, model, placements: [], today: "2026-10-21"});
  return view;
}

it("keeps all gap sections and empty gaps readable, then uses the chart's filter rules", () => {
  const view = fixture();
  const group = view.not_prioritized[0]!;
  view.prioritized = [{...group, band: "high", items: []}];
  view.deferred = [{...group, gap_id: "deferred", items: []}];
  const props = {view, filter: "all" as const, setting: null, onSelect: vi.fn(), pendingReason: (reason: string) => reason};
  const html = renderToStaticMarkup(createElement(TimelineActivityList, props));
  expect(html).toContain("Prioritized gaps");
  expect(html).toContain("Not prioritized");
  expect(html).toContain("Deferred gaps");
  expect(html).toContain("No activities yet.");
  const filtered = renderToStaticMarkup(createElement(TimelineActivityList, {...props, filter: "high"}));
  expect(filtered).not.toContain("Deferred gaps");
  expect(filtered).not.toContain("Not prioritized");
});

it("selects pending activity IDs and leaves family context noninteractive", () => {
  const view = fixture();
  const group = view.not_prioritized.find(group => group.items.some(item => item.pending))!;
  const pending = group.items.find(item => item.pending)!;
  const context: GapTimelineItem = {...pending, key: "context", tactic_name: "Family context only", context_only: true, pending: null, activity: null};
  view.prioritized = [];
  view.not_prioritized = [{...group, items: [context, pending]}];
  view.deferred = [];
  view.other = [];
  const onSelect = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(TimelineActivityList, {view, filter: "all", setting: null, onSelect, pendingReason: () => "Date it by hand or remove it."})));
  expect(container.textContent).toContain("Date it by hand or remove it.");
  expect(container.textContent).toContain("Owner:");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  act(() => container.querySelector("button")!.click());
  expect(onSelect).toHaveBeenCalledWith(pending.activity_id);
  act(() => root.unmount());
});

it("shows dated readout, owner, named dependencies, estimates and conflicts together", () => {
  const state = buildSeed();
  const tactic = state.tactics[0]!;
  const model = buildTimeline({state, placements: [], overrides: [{id: `ACT-${tactic.id}`, start_date: "2026-11-01", end_date: "2027-02-01", readout_date: "2027-03-01", lane: "high", depends_on: [], meta: {manual: true}}]});
  const activity = model.activities[0]!;
  activity.meta.owner = "Study team";
  activity.meta.schedule_basis.start = "model";
  activity.depends_on = ["upstream"];
  const item: GapTimelineItem = {key: "dated", activity_id: activity.id, tactic_id: activity.tactic_id, tactic_name: activity.tactic_name, tactic_status: activity.tactic_status, activity, pending: null};
  const upstream: GapTimelineItem = {...item, key: "upstream", activity_id: "upstream", tactic_name: "Registry cohort", context_only: true, activity: null};
  const view = fixture();
  view.prioritized = []; view.not_prioritized = []; view.deferred = []; view.other = [upstream, item];
  view.conflicts = [{predecessor_id: "upstream", predecessor_name: "Registry cohort", predecessor_end: "2026-12-01", successor_id: activity.id, successor_name: activity.tactic_name, successor_start: activity.start_date}];
  const html = renderToStaticMarkup(createElement(TimelineActivityList, {view, filter: "all", setting: null, onSelect: vi.fn(), pendingReason: reason => reason}));
  for (const text of ["2026-11-01", "2027-02-01", "Readout: 2027-03-01", "Owner: Study team", "Depends on: Registry cohort", "Estimate", "Broken dependency:"]) expect(html).toContain(text);
});
