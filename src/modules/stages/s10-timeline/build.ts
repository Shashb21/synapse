import type { TacticStatus, TacticType } from "@/lib/iegp/enums";
import type { IegpState, Tactic } from "@/lib/iegp/types";
import { countingCoverages, displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import type { PlacementRecord } from "@/modules/stages/s8-prioritization/module";

/**
 * "unprioritized" holds activities whose open gaps have no validated band yet.
 * A model's suggested band is not a priority until a human validates it, so it
 * never places an activity; the lane keeps the tactic visible without ranking it.
 */
export type TimelineBand = "high" | "medium" | "low" | "unprioritized" | "addressed";

export const TIMELINE_LANES: TimelineBand[] = ["high", "medium", "low", "unprioritized", "addressed"];

export const LANE_LABELS: Record<TimelineBand, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  unprioritized: "Not yet prioritized",
  addressed: "Addressed evidence",
};

/**
 * Where a date came from: a saved activity row (a user's edit or an earlier
 * build), the tactic record, the S9 study design, or a model estimate.
 */
export type ScheduleSource = "saved" | "tactic" | "design" | "model";

export type ScheduleField = "start" | "duration" | "readout_lag";

export type ScheduleBasis = {
  start: ScheduleSource;
  end: ScheduleSource;
  readout: ScheduleSource | null;
};

export type TimelineActivity = {
  id: string;
  tactic_id: string;
  tactic_name: string;
  tactic_type: TacticType;
  tactic_status: TacticStatus;
  lane: TimelineBand;
  band: TimelineBand;
  start_date: string;
  end_date: string;
  readout_date: string | null;
  depends_on: string[];
  gap_ids: string[];
  gap_names: string[];
  meta: {
    evidence_question: string;
    population: string;
    comparator: string;
    outcomes: string;
    data_source: string;
    study_design: string;
    owner: string;
    function: string;
    priority_rationale: string | null;
    /** The model's reasons for each dependency, or null when there are none. */
    dependency_note: string | null;
    counts_toward_addressing: boolean;
    /** The model's reasoning for any date it estimated; null when none was estimated. */
    schedule_rationale: string | null;
    schedule_basis: ScheduleBasis;
    /** True once a user has moved the activity to a lane by hand. */
    lane_locked: boolean;
  };
};

export type PendingActivity = {
  activity_id: string;
  tactic_id: string;
  tactic_name: string;
  missing: ScheduleField[];
  reason: string;
};

export type TimelineModel = {
  activities: TimelineActivity[];
  window: { start: string; end: string; months: number };
  lanes: { id: TimelineBand; label: string; count: number }[];
  unscheduled: { gap_id: string; gap_name: string; reason: string }[];
  /** Mapped tactics with no schedule yet: a timeline build (with a model) dates them. */
  pending: PendingActivity[];
};

/** Duration and readout lag carried by the tactic's own design (S9, model- or human-authored). */
export type ActivityDesign = {
  duration_months?: number;
  readout_lag_months?: number;
  /** Why the design proposed that timing, when it said. */
  timing_rationale?: string;
};

/** A model's estimate for the schedule fields an activity is missing. */
export type ScheduleEstimate = {
  start_offset_months?: number;
  duration_months?: number;
  readout_lag_months?: number;
  rationale: string;
};

export type DependencyAnswer = { upstream: { id: string; reason: string }[] };

/** A persisted activity row: a user's edit or an earlier build, kept across rebuilds. */
export type SavedActivity = {
  id: string;
  start_date: string;
  end_date: string;
  readout_date: string | null;
  lane: string;
  depends_on: string[];
  meta?: Partial<Pick<TimelineActivity["meta"], "schedule_rationale" | "schedule_basis" | "dependency_note" | "lane_locked">> | null;
};

export type TimelineCandidate = {
  id: string;
  tactic: Tactic;
  band: TimelineBand;
  gap_ids: string[];
  gap_names: string[];
  priority_rationale: string | null;
  counting: boolean;
  design: ActivityDesign;
  saved: SavedActivity | null;
};

export function activityId(tacticId: string): string {
  return `ACT-${tacticId}`;
}

export function addMonths(iso: string, months: number): string {
  const date = new Date(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

export function monthsBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1
  );
}

function maxDate(dates: string[]): string | null {
  const valid = dates.filter(Boolean).sort();
  return valid.length ? valid[valid.length - 1]! : null;
}

const RANK: Record<"high" | "medium" | "low", number> = { high: 3, medium: 2, low: 1 };

/**
 * The activities the validated state implies, one per live mapped tactic, with
 * the band a human validated on the open gaps it answers. Nothing is dated here.
 */
export function timelineCandidates(args: {
  state: IegpState;
  placements: PlacementRecord[];
  designs?: Map<string, ActivityDesign>;
  overrides?: SavedActivity[];
}): TimelineCandidate[] {
  const placementByGap = new Map(args.placements.map((placement) => [placement.gap_id, placement]));
  const liveGaps = args.state.gaps.filter(isLiveGap);
  const gapById = new Map(liveGaps.map((gap) => [gap.id, gap]));

  const gapsForTactic = new Map<string, string[]>();
  for (const coverage of args.state.coverages) {
    if (!gapById.has(coverage.gap_id)) continue;
    const list = gapsForTactic.get(coverage.tactic_id) ?? [];
    list.push(coverage.gap_id);
    gapsForTactic.set(coverage.tactic_id, list);
  }

  const bandOf = (gapIds: string[]): TimelineBand => {
    let best: "high" | "medium" | "low" | null = null;
    let sawOpen = false;
    for (const gapId of gapIds) {
      const gap = gapById.get(gapId);
      if (!gap) continue;
      if (displayedGapStatus(gap) === "validated_addressed") continue;
      sawOpen = true;
      const placement = placementByGap.get(gapId);
      // Only a band a human validated places the activity.
      if (!placement?.validated || !placement.band) continue;
      if (!best || RANK[placement.band] > RANK[best]) best = placement.band;
    }
    if (!sawOpen) return "addressed";
    return best ?? "unprioritized";
  };

  const candidates: TimelineCandidate[] = [];
  for (const tactic of args.state.tactics) {
    if (tactic.status === "cancelled" || tactic.review_status === "rejected") continue;
    const gapIds = [...new Set(gapsForTactic.get(tactic.id) ?? [])];
    if (gapIds.length === 0) continue;
    const id = activityId(tactic.id);
    candidates.push({
      id,
      tactic,
      band: bandOf(gapIds),
      gap_ids: gapIds,
      gap_names: gapIds.map((gapId) => gapById.get(gapId)?.name ?? gapId),
      priority_rationale:
        gapIds
          .map((gapId) => placementByGap.get(gapId))
          .find((placement) => placement?.validated)?.rationale ?? null,
      counting:
        countingCoverages(
          args.state.coverages.filter((coverage) => coverage.tactic_id === tactic.id),
          args.state.tactics,
        ).length > 0,
      design: args.designs?.get(tactic.id) ?? {},
      saved: args.overrides?.find((row) => row.id === id) ?? null,
    });
  }
  return candidates;
}

/** Which schedule fields no human, saved row or design supplies, so a model must estimate them. */
export function missingSchedule(candidate: TimelineCandidate): ScheduleField[] {
  if (candidate.saved) return [];
  const missing: ScheduleField[] = [];
  if (!candidate.tactic.start_date) missing.push("start");
  if (candidate.design.duration_months === undefined) missing.push("duration");
  if (candidate.design.readout_lag_months === undefined && !candidate.tactic.evidence_available) {
    missing.push("readout_lag");
  }
  return missing;
}

/**
 * Lays out the final IEGP timeline. It makes no judgement: every date comes
 * from a saved row, the tactic, its design, or a model estimate passed in, and
 * dependencies come from the model (or the saved row). The only arithmetic is
 * calendar layout — a start the model estimated is pushed past the readouts it
 * was told it depends on. Activities still missing a value are returned as
 * pending, never filled in.
 */
export function buildTimeline(args: {
  state: IegpState;
  placements: PlacementRecord[];
  designs?: Map<string, ActivityDesign>;
  /** Saved activity rows: a user's edits and earlier builds. Their dates always win. */
  overrides?: SavedActivity[];
  estimates?: Map<string, ScheduleEstimate>;
  dependencies?: Map<string, DependencyAnswer>;
  /** What model start offsets count from. Defaults to today. */
  anchor?: string;
}): TimelineModel {
  const anchor = (args.anchor ?? new Date().toISOString()).slice(0, 10);
  const candidates = timelineCandidates(args);
  const liveGaps = args.state.gaps.filter(isLiveGap);

  type Resolved = {
    candidate: TimelineCandidate;
    start: string;
    startSource: ScheduleSource;
    duration: number | null;
    end: string;
    endSource: ScheduleSource;
    lag: number | null;
    readout: string | null;
    readoutSource: ScheduleSource | null;
    rationale: string | null;
  };

  const pending: PendingActivity[] = [];
  const resolved = new Map<string, Resolved>();
  for (const candidate of candidates) {
    const saved = candidate.saved;
    if (saved) {
      const basis = saved.meta?.schedule_basis;
      resolved.set(candidate.id, {
        candidate,
        start: saved.start_date,
        startSource: basis?.start ?? "saved",
        duration: null,
        end: saved.end_date,
        endSource: basis?.end ?? "saved",
        lag: null,
        readout: saved.readout_date,
        readoutSource: saved.readout_date ? (basis?.readout ?? "saved") : null,
        rationale: saved.meta?.schedule_rationale ?? null,
      });
      continue;
    }
    const estimate = args.estimates?.get(candidate.id);
    const tactic = candidate.tactic;
    const missing: ScheduleField[] = [];

    const start = tactic.start_date ?? (estimate?.start_offset_months !== undefined ? addMonths(anchor, estimate.start_offset_months) : null);
    if (!start) missing.push("start");
    const duration = candidate.design.duration_months ?? estimate?.duration_months ?? null;
    if (duration === null) missing.push("duration");
    const lag = candidate.design.readout_lag_months ?? estimate?.readout_lag_months ?? null;
    if (lag === null && !tactic.evidence_available) missing.push("readout_lag");

    if (!start || duration === null || missing.length > 0) {
      pending.push({
        activity_id: candidate.id,
        tactic_id: tactic.id,
        tactic_name: tactic.name,
        missing,
        reason: `No ${missing.map((field) => field.replace("_", " ")).join(", ")} yet. Rebuild the timeline to have the model estimate ${missing.length === 1 ? "it" : "them"}.`,
      });
      continue;
    }
    const end = addMonths(start, duration);
    const readout = tactic.evidence_available ?? addMonths(end, lag!);
    const startSource: ScheduleSource = tactic.start_date ? "tactic" : "model";
    const endSource: ScheduleSource = candidate.design.duration_months !== undefined ? "design" : "model";
    const readoutSource: ScheduleSource = tactic.evidence_available
      ? "tactic"
      : candidate.design.readout_lag_months !== undefined
        ? "design"
        : "model";
    const sources = [startSource, endSource, readoutSource];
    const reasons = [
      sources.includes("design") ? candidate.design.timing_rationale : undefined,
      sources.includes("model") ? estimate?.rationale : undefined,
    ].filter((reason): reason is string => Boolean(reason));
    resolved.set(candidate.id, {
      candidate,
      start,
      startSource,
      duration,
      end,
      endSource,
      lag,
      readout,
      readoutSource,
      rationale: reasons.length > 0 ? reasons.join(" ") : null,
    });
  }

  // Dependencies the model inferred for this build, else the ones saved with the row.
  const dependenciesOf = (id: string): { id: string; reason: string | null }[] => {
    const answer = args.dependencies?.get(id);
    const list = answer
      ? answer.upstream.map((row) => ({ id: row.id, reason: row.reason }))
      : (resolved.get(id)?.candidate.saved?.depends_on ?? []).map((upstream) => ({ id: upstream, reason: null }));
    return list.filter((row) => row.id !== id && resolved.has(row.id));
  };

  // Layout in dependency order, so an upstream readout is final before it gates.
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const upstream of dependenciesOf(id)) visit(upstream.id);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  for (const id of resolved.keys()) visit(id);

  const activities: TimelineActivity[] = [];
  const placed = new Map<string, TimelineActivity>();
  for (const id of order) {
    const row = resolved.get(id)!;
    const upstream = dependenciesOf(id);
    let { start, end, readout } = row;
    if (upstream.length > 0 && row.startSource === "model" && !row.candidate.saved) {
      const gate = maxDate(
        upstream.map((dependency) => {
          const other = placed.get(dependency.id);
          return other?.readout_date ?? other?.end_date ?? "";
        }),
      );
      if (gate && gate > start) {
        start = gate;
        end = addMonths(gate, row.duration!);
        if (row.readoutSource !== "tactic") readout = addMonths(end, row.lag!);
      }
    }
    const reasons = upstream.filter((dependency) => dependency.reason);
    const candidate = row.candidate;
    const tactic = candidate.tactic;
    const laneLocked = candidate.saved?.meta?.lane_locked === true;
    const savedLane = candidate.saved?.lane as TimelineBand | undefined;
    const activity: TimelineActivity = {
      id,
      tactic_id: tactic.id,
      tactic_name: tactic.name,
      tactic_type: tactic.type,
      tactic_status: tactic.status,
      lane: laneLocked && savedLane && TIMELINE_LANES.includes(savedLane) ? savedLane : candidate.band,
      band: candidate.band,
      start_date: start,
      end_date: end,
      readout_date: readout,
      depends_on: upstream.map((dependency) => dependency.id),
      gap_ids: candidate.gap_ids,
      gap_names: candidate.gap_names,
      meta: {
        evidence_question: tactic.evidence_question,
        population: tactic.population,
        comparator: tactic.comparator,
        outcomes: tactic.outcomes,
        data_source: tactic.data_source,
        study_design: tactic.study_design,
        owner: tactic.owner,
        function: tactic.function,
        priority_rationale: candidate.priority_rationale,
        dependency_note:
          reasons.length > 0
            ? reasons.map((dependency) => `${placed.get(dependency.id)?.tactic_name ?? dependency.id}: ${dependency.reason}`).join(" ")
            : upstream.length > 0
              ? (candidate.saved?.meta?.dependency_note ?? null)
              : null,
        counts_toward_addressing: candidate.counting,
        schedule_rationale: row.rationale,
        schedule_basis: { start: row.startSource, end: row.endSource, readout: readout ? row.readoutSource : null },
        lane_locked: laneLocked,
      },
    };
    placed.set(id, activity);
    activities.push(activity);
  }

  const dates = activities.flatMap((activity) => [activity.start_date, activity.readout_date ?? activity.end_date]);
  const windowStart = dates.length ? dates.slice().sort()[0]! : anchor;
  const windowEnd = dates.length ? dates.slice().sort()[dates.length - 1]! : addMonths(anchor, 12);

  const unscheduled = liveGaps
    .filter(
      (gap) =>
        displayedGapStatus(gap) === "validated_open" &&
        !candidates.some((candidate) => candidate.gap_ids.includes(gap.id)),
    )
    .map((gap) => ({
      gap_id: gap.id,
      gap_name: gap.name,
      reason: "Open gap with no mapped or ideated tactic yet.",
    }));

  const lanes: TimelineModel["lanes"] = TIMELINE_LANES.map((lane) => ({
    id: lane,
    label: LANE_LABELS[lane],
    count: activities.filter((activity) => activity.lane === lane).length,
  }));

  return {
    activities: activities.sort(
      (a, b) => a.start_date.localeCompare(b.start_date) || a.tactic_name.localeCompare(b.tactic_name),
    ),
    window: {
      start: windowStart,
      end: windowEnd,
      months: Math.max(1, monthsBetween(windowStart, windowEnd)),
    },
    lanes,
    unscheduled,
    pending,
  };
}
