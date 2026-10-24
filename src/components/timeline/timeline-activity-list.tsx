"use client";

import type { ReactNode } from "react";
import { filterView, type TimelinePriorityFilter } from "./gap-gantt";
import type { GapTimelineGroup, GapTimelineItem, GapTimelineView } from "@/modules/stages/s10-timeline/gap-view";
import { gapNumberLabel } from "@/lib/iegp/gap-number";
import { estimatedFields } from "@/modules/stages/s10-timeline/build";

/** A readable schedule using the same groups, filters and activity selection as the chart. */
export function TimelineActivityList({ view, filter, setting, onSelect, pendingReason, gapAction }: {
  view: GapTimelineView;
  filter: TimelinePriorityFilter;
  setting: string | null;
  onSelect: (id: string) => void;
  pendingReason: (reason: string) => string;
  gapAction?: (gap: GapTimelineGroup) => ReactNode;
}) {
  const shown = filterView(view, filter, setting);
  const names = new Map([...view.prioritized, ...view.not_prioritized, ...view.deferred].flatMap(group => group.items).concat(view.other).map(item => [item.activity_id, item.tactic_name]));
  const items = (rows: GapTimelineItem[]) => <ul className="divide-y divide-border">
    {rows.map(item => {
      const activity = item.activity;
      const conflicts = view.conflicts.filter(conflict => conflict.successor_id === item.activity_id || conflict.predecessor_id === item.activity_id);
      return <li key={item.key} className="min-w-0 py-3 text-sm [overflow-wrap:anywhere]" data-activity-list-id={item.activity_id}>
        {item.context_only ? <p className="font-medium">{item.tactic_name} · Family context</p> : <button type="button" onClick={() => onSelect(item.activity_id)} className="min-h-10 text-left font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">{item.tactic_name}</button>}
        <p className="text-xs text-muted-foreground">{item.tactic_status.replaceAll("_", " ")}{item.expansion_id ? ` · Expansion of ${item.parent_tactic_name}` : ""}</p>
        {item.context_only ? null : <>
          <p className="mt-1">{activity ? `${activity.start_date} → ${activity.end_date}` : "Not dated yet"}</p>
          {activity?.readout_date ? <p className="text-xs">Readout: {activity.readout_date}</p> : null}
          <p className="text-xs text-muted-foreground">Owner: {activity?.meta.owner || item.pending?.meta.owner || "Not recorded"}</p>
          {item.pending ? <p className="mt-1 text-xs">{pendingReason(item.pending.reason)}</p> : null}
          {activity && estimatedFields(activity.meta.schedule_basis).length > 0 ? <p className="mt-1 text-xs text-unknown-foreground">{activity.meta.estimate_stale ? "Estimate — out of date" : "Estimate — check dates before accepting"}</p> : null}
          {item.expansion_id ? <p className="text-xs">{(activity ?? item.pending)?.meta.counts_toward_addressing ? "Counts toward addressing" : "Not counting toward addressing"}</p> : null}
          {activity?.depends_on.length ? <p className="mt-1 text-xs">Depends on: {activity.depends_on.map(id => names.get(id) ?? id).join(", ")}</p> : null}
          {conflicts.map(conflict => <p key={`${conflict.predecessor_id}:${conflict.successor_id}`} className="mt-1 text-xs text-destructive">Broken dependency: {conflict.successor_name} starts {conflict.successor_start} before {conflict.predecessor_name} ends {conflict.predecessor_end}.</p>)}
        </>}
      </li>;
    })}
  </ul>;
  const sections = [
    { label: "Prioritized gaps", groups: shown.prioritized },
    { label: "Not prioritized", groups: shown.not_prioritized },
    { label: "Deferred gaps", groups: shown.deferred },
  ];
  const empty = sections.every(section => section.groups.length === 0) && shown.other.length === 0;
  return <div className="grid min-w-0 gap-5" data-testid="timeline-activity-list">
    {empty ? <p className="p-3 text-sm text-muted-foreground">No gaps match these timeline filters.</p> : null}
    {sections.map(section => section.groups.length ? <section key={section.label} className="min-w-0 border border-border bg-card p-3">
      <h2 className="text-sm font-semibold">{section.label}</h2>
      {section.groups.map(group => <section key={group.gap_id} className="mt-3 min-w-0 border-t border-border pt-3">
        <h3 className="break-words text-sm font-semibold">{gapNumberLabel(group.number)} · {group.gap_name}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{group.band ? `${group.band} priority` : section.label}{group.settings.length ? ` · ${group.settings.join(", ")}` : ""}</p>
        {group.statement ? <p className="mt-1 break-words text-xs text-muted-foreground">{group.statement}</p> : null}
        {group.items.length ? items(group.items) : <p className="my-2 text-sm text-muted-foreground">No activities yet.</p>}
        {gapAction?.(group)}
      </section>)}
    </section> : null)}
    {shown.other.length ? <section className="min-w-0 border border-border bg-card p-3"><h2 className="text-sm font-semibold">Other activities</h2>{items(shown.other)}</section> : null}
    {shown.markers.length ? <section className="border border-border bg-card p-3"><h2 className="text-sm font-semibold">Decisions and milestones</h2><ul className="mt-2 grid gap-2 text-xs">{shown.markers.map(marker => <li key={marker.id}>{marker.date} · {marker.label} · {marker.detail}</li>)}</ul></section> : null}
  </div>;
}
