import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { setupContextFromState } from "@/lib/iegp/planning-context";
import type { IegpState } from "@/lib/iegp/types";
import type { PlacementRecord } from "@/modules/stages/s8-prioritization/module";
import {
  activityId,
  addMonths,
  monthsBetween,
  type PendingActivity,
  type TimelineActivity,
  type TimelineBand,
  type TimelineModel,
} from "./build";

/**
 * The timeline as the owner plans it (KAN-25): one group per prioritized gap,
 * its tactics beneath it as bars, undated ones shown as "Unscheduled". It is a
 * view over the S10 model and makes no judgement: a gap's priority is the band
 * a human validated in S8, its tactics are the ones mapped to it, and every date
 * is the one S10 holds (a person's, a design's, or a model's).
 */

export type PriorityBand = "high" | "medium" | "low";

export type GapTimelineItem = {
  /** Unique per row: an activity can answer several gaps and shows under each. */
  key: string;
  activity_id: string;
  tactic_id: string;
  tactic_name: string;
  tactic_status: string;
  /** The dated activity, or null while it is unscheduled. */
  activity: TimelineActivity | null;
  /** Why it is unscheduled, when it is. */
  pending: PendingActivity | null;
};

export type GapTimelineGroup = {
  gap_id: string;
  gap_name: string;
  statement: string;
  domain: string;
  /** The validated S8 band; null for a gap not prioritized yet. */
  band: PriorityBand | null;
  /** Span of its dated tactics; null when none is dated ("Unscheduled"). */
  start: string | null;
  end: string | null;
  items: GapTimelineItem[];
};

/** Finish-to-start: the successor starts before its predecessor ends. */
export type DependencyConflict = {
  predecessor_id: string;
  predecessor_name: string;
  predecessor_end: string;
  successor_id: string;
  successor_name: string;
  successor_start: string;
};

export type TimelineMarker = {
  id: string;
  kind: "key_decision" | "milestone";
  label: string;
  date: string;
  detail: string;
};

export type GapTimelineView = {
  /** Prioritized gaps, by band (high → low) then name. */
  prioritized: GapTimelineGroup[];
  /** Open gaps with no validated band yet, by name. */
  not_prioritized: GapTimelineGroup[];
  /** Activities that sit under none of the gaps above (addressed gaps, hand-added tactics). */
  other: GapTimelineItem[];
  conflicts: DependencyConflict[];
  markers: TimelineMarker[];
  window: { start: string; end: string; months: number };
  counts: { dated: number; unscheduled: number };
};

const BAND_RANK: Record<PriorityBand, number> = { high: 0, medium: 1, low: 2 };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every finish-to-start dependency whose successor starts before the predecessor ends. */
export function dependencyConflicts(
  activities: Pick<TimelineActivity, "id" | "tactic_name" | "start_date" | "end_date" | "depends_on">[],
): DependencyConflict[] {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const conflicts: DependencyConflict[] = [];
  for (const successor of activities) {
    for (const upstreamId of successor.depends_on) {
      const predecessor = byId.get(upstreamId);
      if (!predecessor || !successor.start_date || !predecessor.end_date) continue;
      if (successor.start_date < predecessor.end_date) {
        conflicts.push({
          predecessor_id: predecessor.id,
          predecessor_name: predecessor.tactic_name,
          predecessor_end: predecessor.end_date,
          successor_id: successor.id,
          successor_name: successor.tactic_name,
          successor_start: successor.start_date,
        });
      }
    }
  }
  return conflicts;
}

/** Key decisions and regulatory milestones from the setup context, when they carry a date. */
export function timelineMarkers(state: IegpState): TimelineMarker[] {
  const context = setupContextFromState(state);
  const markers: TimelineMarker[] = [];
  const seen = new Set<string>();
  const push = (marker: TimelineMarker) => {
    if (!ISO_DATE.test(marker.date)) return;
    const key = `${marker.kind}:${marker.label}:${marker.date}`;
    if (seen.has(key)) return;
    seen.add(key);
    markers.push(marker);
  };
  const objectives = context.objectives.length > 0 ? context.objectives : state.objectives;
  objectives.forEach((objective, index) => {
    if (!objective.key_decision || !objective.decision_date) return;
    push({
      id: `decision-${objective.id || index}`,
      kind: "key_decision",
      label: objective.key_decision,
      date: objective.decision_date,
      detail: objective.name ? `Key decision · ${objective.name}` : "Key decision",
    });
  });
  context.regulatory_milestones.forEach((milestone, index) => {
    if (!milestone.name) return;
    push({
      id: `milestone-${index}`,
      kind: "milestone",
      label: milestone.name,
      date: milestone.date,
      detail: "Regulatory milestone",
    });
  });
  return markers.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

export function gapTimelineView(args: {
  model: TimelineModel;
  state: IegpState;
  placements: PlacementRecord[];
  /** Pads an empty window; defaults to today. */
  today?: string;
}): GapTimelineView {
  const { model, state } = args;
  const today = (args.today ?? new Date().toISOString()).slice(0, 10);
  const dated = new Map(model.activities.map((activity) => [activity.id, activity]));
  const pending = new Map(model.pending.map((row) => [row.activity_id, row]));
  const tacticById = new Map(state.tactics.map((tactic) => [tactic.id, tactic]));
  const placementByGap = new Map(args.placements.map((placement) => [placement.gap_id, placement]));

  const itemFor = (gapId: string, tacticId: string): GapTimelineItem | null => {
    const id = activityId(tacticId);
    const activity = dated.get(id) ?? null;
    const waiting = activity ? null : (pending.get(id) ?? null);
    // Removed by hand, cancelled or rejected: not on the timeline.
    if (!activity && !waiting) return null;
    const tactic = tacticById.get(tacticId);
    return {
      key: `${gapId}:${id}`,
      activity_id: id,
      tactic_id: tacticId,
      tactic_name: activity?.tactic_name ?? waiting?.tactic_name ?? tactic?.name ?? tacticId,
      tactic_status: activity?.tactic_status ?? tactic?.status ?? "proposed",
      activity,
      pending: waiting,
    };
  };

  const shown = new Set<string>();
  const groupFor = (gap: IegpState["gaps"][number], band: PriorityBand | null): GapTimelineGroup => {
    const tacticIds = [
      ...new Set(state.coverages.filter((coverage) => coverage.gap_id === gap.id).map((coverage) => coverage.tactic_id)),
    ];
    const items = tacticIds
      .map((tacticId) => itemFor(gap.id, tacticId))
      .filter((item): item is GapTimelineItem => item !== null)
      .sort(
        (a, b) =>
          (a.activity ? 0 : 1) - (b.activity ? 0 : 1) ||
          (a.activity?.start_date ?? "").localeCompare(b.activity?.start_date ?? "") ||
          a.tactic_name.localeCompare(b.tactic_name),
      );
    for (const item of items) shown.add(item.activity_id);
    const starts = items.flatMap((item) => (item.activity ? [item.activity.start_date] : [])).sort();
    const ends = items.flatMap((item) => (item.activity ? [item.activity.end_date] : [])).sort();
    return {
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      domain: gap.domain,
      band,
      start: starts[0] ?? null,
      end: ends[ends.length - 1] ?? null,
      items,
    };
  };

  const liveGaps = state.gaps.filter(isLiveGap);
  const prioritized: GapTimelineGroup[] = [];
  const notPrioritized: GapTimelineGroup[] = [];
  for (const gap of liveGaps) {
    const placement = placementByGap.get(gap.id);
    // Only a band a human validated makes a gap prioritized.
    if (placement?.validated && placement.band) {
      prioritized.push(groupFor(gap, placement.band));
    } else if (displayedGapStatus(gap) === "validated_open") {
      notPrioritized.push(groupFor(gap, null));
    }
  }
  prioritized.sort(
    (a, b) => BAND_RANK[a.band!] - BAND_RANK[b.band!] || a.gap_name.localeCompare(b.gap_name),
  );
  notPrioritized.sort((a, b) => a.gap_name.localeCompare(b.gap_name));

  // Nothing silently disappears: whatever no group shows is listed on its own.
  const other: GapTimelineItem[] = [];
  for (const activity of model.activities) {
    if (shown.has(activity.id)) continue;
    other.push({
      key: `other:${activity.id}`,
      activity_id: activity.id,
      tactic_id: activity.tactic_id,
      tactic_name: activity.tactic_name,
      tactic_status: activity.tactic_status,
      activity,
      pending: null,
    });
  }
  for (const row of model.pending) {
    if (shown.has(row.activity_id)) continue;
    other.push({
      key: `other:${row.activity_id}`,
      activity_id: row.activity_id,
      tactic_id: row.tactic_id,
      tactic_name: row.tactic_name,
      tactic_status: tacticById.get(row.tactic_id)?.status ?? "proposed",
      activity: null,
      pending: row,
    });
  }

  const markers = timelineMarkers(state);
  const dates = [
    ...model.activities.flatMap((activity) => [activity.start_date, activity.readout_date ?? activity.end_date, activity.end_date]),
    ...markers.map((marker) => marker.date),
  ]
    .filter((date) => ISO_DATE.test(date))
    .sort();
  const start = dates[0] ?? today;
  const last = dates[dates.length - 1] ?? addMonths(today, 12);
  // At least a year, so an almost empty plan still has room to drag into.
  const end = last > addMonths(start, 11) ? last : addMonths(start, 11);

  return {
    prioritized,
    not_prioritized: notPrioritized,
    other,
    conflicts: dependencyConflicts(model.activities),
    markers,
    window: { start, end, months: Math.max(1, monthsBetween(start, end)) },
    counts: { dated: model.activities.length, unscheduled: model.pending.length },
  };
}

/** The colour lane for a row: its gap's validated band, else the activity's own lane. */
export function rowBand(group: GapTimelineGroup | null, activity: TimelineActivity | null): TimelineBand {
  if (group?.band) return group.band;
  if (group) return "unprioritized";
  return activity?.lane ?? "unprioritized";
}
