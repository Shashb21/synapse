import type { TacticStatus, TacticType } from "@/lib/iegp/enums";
import type { IegpState } from "@/lib/iegp/types";
import { countingCoverages, displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import type { PlacementRecord } from "@/modules/stages/s8-prioritization/module";

export type TimelineBand = "high" | "medium" | "low" | "addressed";

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
    dependency_note: string | null;
    counts_toward_addressing: boolean;
  };
};

export type TimelineModel = {
  activities: TimelineActivity[];
  window: { start: string; end: string; months: number };
  lanes: { id: TimelineBand; label: string; count: number }[];
  unscheduled: { gap_id: string; gap_name: string; reason: string }[];
};

const DISSEMINATION: TacticType[] = ["publication", "congress_abstract", "evidence_dissemination"];

const DURATION_MONTHS: Partial<Record<TacticType, number>> = {
  phase3_trial: 30,
  rwe_study: 12,
  registry: 24,
  chart_review: 7,
  hcru_study: 9,
  slr: 4,
  nma: 5,
  itc: 6,
  maic: 6,
  pro_study: 14,
  patient_survey: 6,
  cea: 8,
  budget_impact_model: 5,
  iis: 18,
  academic_collaboration: 12,
  secondary_analysis: 4,
  subgroup_analysis: 4,
  long_term_followup: 24,
  publication: 4,
  congress_abstract: 3,
  evidence_dissemination: 3,
  natural_history_study: 18,
};

const READOUT_LAG_MONTHS: Partial<Record<TacticType, number>> = {
  phase3_trial: 4,
  registry: 3,
  rwe_study: 2,
  publication: 0,
  congress_abstract: 0,
  evidence_dissemination: 0,
};

const BAND_OFFSET_MONTHS: Record<TimelineBand, number> = {
  high: 0,
  medium: 3,
  low: 7,
  addressed: 0,
};

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

/**
 * Deterministic build of the final IEGP timeline from validated state. Dates the
 * user has set on a tactic or on a saved activity always win; everything else is
 * synthesised from priority band and tactic type so the plan is never empty.
 */
export function buildTimeline(args: {
  state: IegpState;
  placements: PlacementRecord[];
  /** Saved, user-edited activity rows. */
  overrides?: {
    id: string;
    start_date: string;
    end_date: string;
    readout_date: string | null;
    lane: string;
    depends_on: string[];
  }[];
  anchor?: string;
}): TimelineModel {
  const anchor = (args.anchor ?? new Date().toISOString()).slice(0, 10);
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
    let best: TimelineBand = "low";
    let sawOpen = false;
    for (const gapId of gapIds) {
      const gap = gapById.get(gapId);
      if (!gap) continue;
      if (displayedGapStatus(gap) === "validated_addressed") continue;
      sawOpen = true;
      const placement = placementByGap.get(gapId);
      const band = (placement?.validated ? placement.band : placement?.suggested_band) ?? "low";
      if (band === "high") return "high";
      if (band === "medium") best = "medium";
    }
    return sawOpen ? best : "addressed";
  };

  const activities: TimelineActivity[] = [];
  for (const tactic of args.state.tactics) {
    if (tactic.status === "cancelled" || tactic.review_status === "rejected") continue;
    const gapIds = [...new Set(gapsForTactic.get(tactic.id) ?? [])];
    if (gapIds.length === 0) continue;
    const band = bandOf(gapIds);
    const duration = DURATION_MONTHS[tactic.type] ?? 9;
    const override = args.overrides?.find((row) => row.id === `ACT-${tactic.id}`);
    const start =
      override?.start_date ??
      tactic.start_date ??
      addMonths(anchor, BAND_OFFSET_MONTHS[band] + (tactic.status === "proposed" ? 2 : 0));
    const end = override?.end_date ?? addMonths(start, duration);
    const readout =
      override?.readout_date ??
      tactic.evidence_available ??
      addMonths(end, READOUT_LAG_MONTHS[tactic.type] ?? 2);
    const counting = countingCoverages(
      args.state.coverages.filter((coverage) => coverage.tactic_id === tactic.id),
      args.state.tactics,
    ).length > 0;
    activities.push({
      id: `ACT-${tactic.id}`,
      tactic_id: tactic.id,
      tactic_name: tactic.name,
      tactic_type: tactic.type,
      tactic_status: tactic.status,
      lane: (override?.lane as TimelineBand) ?? band,
      band,
      start_date: start,
      end_date: end,
      readout_date: readout,
      depends_on: override?.depends_on ?? [],
      gap_ids: gapIds,
      gap_names: gapIds.map((gapId) => gapById.get(gapId)?.name ?? gapId),
      meta: {
        evidence_question: tactic.evidence_question,
        population: tactic.population,
        comparator: tactic.comparator,
        outcomes: tactic.outcomes,
        data_source: tactic.data_source,
        study_design: tactic.study_design,
        owner: tactic.owner,
        function: tactic.function,
        priority_rationale:
          gapIds
            .map((gapId) => placementByGap.get(gapId))
            .find((placement) => placement?.validated)?.rationale ?? null,
        dependency_note: null,
        counts_toward_addressing: counting,
      },
    });
  }

  // Timing interdependencies: dissemination waits on the readouts it reports,
  // and a child gap's work waits on the parent's addressed slice.
  for (const activity of activities) {
    if (activity.depends_on.length > 0) continue;
    const dependencies = new Set<string>();
    if (DISSEMINATION.includes(activity.tactic_type)) {
      for (const other of activities) {
        if (other.id === activity.id) continue;
        if (DISSEMINATION.includes(other.tactic_type)) continue;
        if (other.gap_ids.some((gapId) => activity.gap_ids.includes(gapId))) {
          dependencies.add(other.id);
        }
      }
    }
    for (const gapId of activity.gap_ids) {
      const parentId = gapById.get(gapId)?.parent_gap_id;
      if (!parentId) continue;
      for (const other of activities) {
        if (other.id !== activity.id && other.gap_ids.includes(parentId)) dependencies.add(other.id);
      }
    }
    activity.depends_on = [...dependencies];
    if (dependencies.size > 0) {
      const gate = maxDate(
        [...dependencies]
          .map((id) => activities.find((candidate) => candidate.id === id))
          .map((dependency) => dependency?.readout_date ?? dependency?.end_date ?? ""),
      );
      if (gate && gate > activity.start_date) {
        const length = monthsBetween(activity.start_date, activity.end_date) - 1;
        activity.start_date = gate;
        activity.end_date = addMonths(gate, Math.max(1, length));
        activity.readout_date = addMonths(
          activity.end_date,
          READOUT_LAG_MONTHS[activity.tactic_type] ?? 2,
        );
        activity.meta.dependency_note = `Starts after the readout of ${[...dependencies].length} upstream activity(ies).`;
      }
    }
  }

  const dates = activities.flatMap((activity) => [activity.start_date, activity.readout_date ?? activity.end_date]);
  const windowStart = dates.length ? dates.slice().sort()[0]! : anchor;
  const windowEnd = dates.length ? dates.slice().sort()[dates.length - 1]! : addMonths(anchor, 12);

  const unscheduled = liveGaps
    .filter(
      (gap) =>
        displayedGapStatus(gap) === "validated_open" &&
        !activities.some((activity) => activity.gap_ids.includes(gap.id)),
    )
    .map((gap) => ({
      gap_id: gap.id,
      gap_name: gap.name,
      reason: "Open gap with no mapped or ideated tactic yet.",
    }));

  const lanes: TimelineModel["lanes"] = (["high", "medium", "low", "addressed"] as TimelineBand[]).map(
    (lane) => ({
      id: lane,
      label:
        lane === "addressed"
          ? "Addressed evidence"
          : `${lane[0]!.toUpperCase()}${lane.slice(1)} priority`,
      count: activities.filter((activity) => activity.lane === lane).length,
    }),
  );

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
  };
}
