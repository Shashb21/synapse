import type { CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import type { TacticStatus, TacticType } from "@/lib/iegp/enums";
import type { IegpState, Tactic, TacticExpansion, ExpansionScope } from "@/lib/iegp/types";
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
 * Where a date came from: a user's own entry ("human"), a saved activity row
 * whose origin was not recorded ("saved"), the tactic record, the S9 study
 * design, or a model estimate.
 */
export type ScheduleSource = "human" | "saved" | "tactic" | "design" | "model";

export type ScheduleField = "start" | "duration" | "readout_lag";

export type ScheduleBasis = {
  start: ScheduleSource;
  end: ScheduleSource;
  readout: ScheduleSource | null;
};

/** A dependency a model inferred, waiting for a person to accept or reject it (KAN-85). */
export type ProposedDependency = { id: string; reason: string };

/**
 * How an activity belongs to the plan (KAN-85): committed future work
 * (planned/ongoing), historical evidence already generated (completed), or a
 * proposed tactic that is not yet in the plan.
 */
export type Inclusion = "committed" | "completed" | "proposed";

export function inclusionOf(status: TacticStatus): Inclusion {
  if (status === "completed") return "completed";
  if (status === "proposed") return "proposed";
  return "committed";
}

export const INCLUSION_LABELS: Record<Inclusion, string> = {
  committed: "In the plan",
  completed: "Completed — historical evidence",
  proposed: "Proposed — not yet in the plan",
};

/** The schedule fields of an activity that a model estimated and no person has reviewed. */
export function estimatedFields(basis: ScheduleBasis | undefined | null): ("start" | "end" | "readout")[] {
  if (!basis) return [];
  return (["start", "end", "readout"] as const).filter((field) => basis[field] === "model");
}

/**
 * Problems in the saved schedule that the build reports instead of silently
 * ignoring (KAN-85): a dependency loop, or a dependency on an activity that is
 * not on the timeline (removed, undated or unknown).
 */
export type TimelineProblem = {
  kind: "cycle" | "dangling";
  activity_id: string;
  upstream_id: string;
  message: string;
};

export type TimelineActivity = {
  id: string;
  tactic_id: string;
  expansion_id?: string;
  parent_activity_id?: string;
  parent_tactic_name?: string;
  expansion_version?: string;
  expansion_scope?: ExpansionScope;
  tactic_name: string;
  tactic_type: TacticType | "not_recorded";
  /** A person's own type name and colour, drawn instead of the type's family colour (KAN-51). */
  tactic_custom_type?: CustomTacticType | null;
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
    /** The strategic objectives of the gaps it answers ("" when none is recorded). */
    objective: string;
    /** What the work delivers: its intended use, else "" (shown as "Not recorded"). */
    outputs: string;
    inclusion: Inclusion;
    evidence_question: string;
    population: string;
    comparator: string;
    outcomes: string;
    data_source: string;
    study_design: string;
    owner: string;
    /** The tactic's budget as typed, e.g. "$120k" (KAN-56: edited from the timeline side panel). */
    budget?: string | null;
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
    /** True once a user set the dependencies by hand; rebuilds keep them and never ask the model. */
    depends_locked: boolean;
    /** True once a user wrote the schedule rationale by hand. */
    rationale_locked: boolean;
    /** True when a user added this activity by hand (its tactic need not be mapped to a gap). */
    manual: boolean;
    /**
     * Dependencies a model inferred that no person has reviewed (KAN-85). They
     * never gate scheduling, conflicts or the saved plan until accepted.
     */
    proposed_dependencies: ProposedDependency[];
    /** Upstream ids a person rejected: never proposed again for this activity. */
    rejected_dependencies: string[];
    /** The inputs the model saw last: when they change, its proposals and estimates are asked again. */
    inputs_key: string;
    /** True when a model estimate was made from inputs that have since changed. */
    estimate_stale: boolean;
  };
};

/** An activity a user took off the timeline; rebuilds leave it off until someone adds it back. */
export type RemovedActivity = {
  activity_id: string;
  tactic_id: string;
  expansion_id?: string;
  parent_activity_id?: string;
  parent_tactic_name?: string;
  expansion_version?: string;
  expansion_scope?: ExpansionScope;
  tactic_name: string;
  reason: string;
};

/** Details shared by dated and pending activities; contains no fabricated schedule. */
export type ActivityDetails = Pick<TimelineActivity,
  "tactic_type" | "tactic_custom_type" | "tactic_status" | "band" | "gap_ids" | "gap_names"
> & {meta: Pick<TimelineActivity["meta"],
  "evidence_question" | "population" | "comparator" | "outcomes" | "data_source" |
  "study_design" | "owner" | "budget" | "function" | "priority_rationale" | "counts_toward_addressing" |
  "objective" | "outputs" | "inclusion"
>};

export type PendingActivity = ActivityDetails & {
  activity_id: string;
  tactic_id: string;
  expansion_id?: string;
  parent_activity_id?: string;
  parent_tactic_name?: string;
  expansion_version?: string;
  expansion_scope?: ExpansionScope;
  tactic_name: string;
  missing: ScheduleField[];
  reason: string;
};

export type TimelineModel = {
  activities: TimelineActivity[];
  window: { start: string; end: string; months: number };
  lanes: { id: TimelineBand; label: string; count: number }[];
  unscheduled: { gap_id: string; gap_name: string; reason: string }[];
  /** Mapped tactics with no schedule yet: a user dates them by hand, or a build (with a model) does. */
  pending: PendingActivity[];
  /** Activities a user removed by hand. */
  removed: RemovedActivity[];
  /** Cancelled tactics mapped to live gaps: excluded from the plan, listed so the count is visible. */
  cancelled: { tactic_id: string; tactic_name: string }[];
  /** Cycles and dependencies on activities not on the timeline. */
  problems: TimelineProblem[];
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
  meta?:
    | (Partial<
        Pick<
          TimelineActivity["meta"],
          | "schedule_rationale"
          | "schedule_basis"
          | "dependency_note"
          | "lane_locked"
          | "depends_locked"
          | "rationale_locked"
          | "manual"
        >
      > & {
        /** A user's reason for each dependency they set, by upstream activity id. */
        dependency_reasons?: Record<string, string>;
        proposed_dependencies?: ProposedDependency[];
        rejected_dependencies?: string[];
        inputs_key?: string;
        estimate_stale?: boolean;
        removed?: boolean;
        removed_reason?: string;
      })
    | null;
};

/** True when the saved row says a user took the activity off the timeline. */
export function isRemoved(saved: SavedActivity | null | undefined): boolean {
  return saved?.meta?.removed === true;
}

export type TimelineCandidate = {
  id: string;
  /** The strategic objectives of its gaps. */
  objective: string;
  tactic: Omit<Tactic, "type"> & {type: TacticType | "not_recorded"};
  expansion?: TacticExpansion;
  parent_name?: string;
  band: TimelineBand;
  gap_ids: string[];
  gap_names: string[];
  priority_rationale: string | null;
  counting: boolean;
  design: ActivityDesign;
  saved: SavedActivity | null;
};

export function activityId(tacticId: string, expansionId?: string): string {
  return expansionId ? `ACT-EXP-${expansionId}` : `ACT-${tacticId}`;
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
  const objectiveById = new Map(args.state.objectives.map((objective) => [objective.id, objective.name]));
  const gapById = new Map(liveGaps.map((gap) => [gap.id, gap]));

  const gapsForTactic = new Map<string, string[]>();
  for (const coverage of args.state.coverages) {
    if (!gapById.has(coverage.gap_id)) continue;
    const scopeId = activityId(coverage.tactic_id, coverage.expansion_id ?? undefined);
    const list = gapsForTactic.get(scopeId) ?? [];
    list.push(coverage.gap_id);
    gapsForTactic.set(scopeId, list);
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
      // Only a band a human validated places the activity; a deferred gap is out of this cycle.
      if (!placement?.validated || !placement.band || placement.band === "defer") continue;
      if (!best || RANK[placement.band] > RANK[best]) best = placement.band;
    }
    if (!sawOpen) return "addressed";
    return best ?? "unprioritized";
  };

  const candidates: TimelineCandidate[] = [];
  const scopes = args.state.tactics.flatMap(parent => [
    {tactic: parent, expansion: undefined as TacticExpansion | undefined, parent_name: parent.name},
    ...(args.state.expansions ?? []).filter(child => child.tactic_id === parent.id).map(expansion => ({
      tactic: {...parent, ...expansion.scope, type: expansion.scope.type ?? "not_recorded" as const, custom_type: null, comparator: expansion.scope.comparator ?? "", data_source: expansion.scope.data_source ?? "", status: expansion.status, budget: expansion.scope.cost_effort},
      expansion, parent_name: parent.name,
    })),
  ]);
  for (const {tactic, expansion, parent_name} of scopes) {
    if (tactic.status === "cancelled" || (!expansion && tactic.review_status === "rejected")) continue;
    const id = activityId(tactic.id, expansion?.id);
    const gapIds = [...new Set(gapsForTactic.get(id) ?? [])];
    const saved = args.overrides?.find((row) => row.id === id) ?? null;
    // A user can put any tactic on the timeline by hand, mapped or not.
    if (gapIds.length === 0 && saved?.meta?.manual !== true) continue;
    // A user removed it: it stays off until someone adds it back.
    if (isRemoved(saved)) continue;
    candidates.push({
      id,
      objective: [
        ...new Set(gapIds.map((gapId) => objectiveById.get(gapById.get(gapId)?.objective_id ?? "") ?? "").filter(Boolean)),
      ].join("; "),
      tactic,
      expansion,
      parent_name,
      band: gapIds.length === 0 ? "unprioritized" : bandOf(gapIds),
      gap_ids: gapIds,
      gap_names: gapIds.map((gapId) => gapById.get(gapId)?.name ?? gapId),
      priority_rationale:
        gapIds
          .map((gapId) => placementByGap.get(gapId))
          .find((placement) => placement?.validated)?.rationale ?? null,
      counting:
        countingCoverages(
          args.state.coverages.filter((coverage) => coverage.tactic_id === tactic.id && (coverage.expansion_id ?? null) === (expansion?.id ?? null)),
          args.state.tactics,
          args.state.expansions,
        ).length > 0,
      design: args.designs?.get(expansion ? id : tactic.id) ?? {},
      saved,
    });
  }
  return candidates;
}

/** Read details from this scope and the shared coverage engine, independent of dates. */
function activityDetails(candidate: TimelineCandidate): ActivityDetails {
  const tactic = candidate.tactic;
  return {
    tactic_type: tactic.type,
    tactic_custom_type: tactic.custom_type ?? null,
    tactic_status: tactic.status,
    band: candidate.band,
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
      budget: tactic.budget ?? null,
      function: tactic.function,
      priority_rationale: candidate.priority_rationale,
      counts_toward_addressing: candidate.counting,
      objective: candidate.objective,
      outputs: (tactic as { intended_use?: string }).intended_use?.trim() ?? "",
      inclusion: inclusionOf(tactic.status),
    },
  };
}

/**
 * What a model's dependency answer and date estimate for an activity depend on:
 * its tactic's dates and status, its design timing and the gaps it answers.
 * When this changes, a rebuild asks again (KAN-85); otherwise it never does.
 */
export function inputsKey(candidate: TimelineCandidate): string {
  return JSON.stringify([
    candidate.tactic.start_date ?? null,
    candidate.tactic.evidence_available ?? null,
    candidate.tactic.status,
    candidate.design.duration_months ?? null,
    candidate.design.readout_lag_months ?? null,
    [...candidate.gap_ids].sort(),
  ]);
}

/** True when a saved row predates KAN-85: its unlocked dependencies were a model's facts. */
function legacyRow(saved: SavedActivity): boolean {
  return saved.meta?.inputs_key === undefined && saved.meta?.proposed_dependencies === undefined;
}

/**
 * The model's proposals waiting on a saved row. Rows from before KAN-85 kept a
 * model's dependencies as facts; they come back as proposals for a person to
 * review. A person's own (depends_locked) stay as they are.
 */
export function savedProposals(saved: SavedActivity | null): ProposedDependency[] {
  if (!saved) return [];
  if (saved.meta?.proposed_dependencies) return saved.meta.proposed_dependencies;
  if (saved.meta?.depends_locked === true || !legacyRow(saved)) return [];
  return saved.depends_on.map((id) => ({ id, reason: saved.meta?.dependency_note ?? "Inferred by an earlier build." }));
}

/** The dependencies that schedule a saved activity: a person's own, or ones they accepted. */
export function acceptedDependencies(saved: SavedActivity | null): string[] {
  if (!saved) return [];
  if (saved.meta?.depends_locked === true) return saved.depends_on;
  if (legacyRow(saved)) return [];
  return saved.depends_on;
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
 * from a saved row, the tactic, its design, or a model estimate passed in.
 * Only dependencies a person set or accepted schedule anything; a model's are
 * proposals shown for review (KAN-85, docs/sdlc/14-roadmap-policy.md). The only
 * arithmetic is calendar layout — a start the model estimated is pushed past
 * the readouts of the activities it is accepted to wait on. Activities still
 * missing a value are returned as pending, never filled in. Loops and
 * dependencies on activities that are not on the timeline are reported as
 * problems, not silently dropped.
 */
export function buildTimeline(args: {
  state: IegpState;
  placements: PlacementRecord[];
  designs?: Map<string, ActivityDesign>;
  /** Saved activity rows: a user's edits and earlier builds. Their dates always win. */
  overrides?: SavedActivity[];
  estimates?: Map<string, ScheduleEstimate>;
  /** A model's fresh dependency proposals, for the activities this build asked about. */
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
        ...activityDetails(candidate),
        activity_id: candidate.id,
        tactic_id: tactic.id,
        ...(candidate.expansion ? {expansion_id: candidate.expansion.id, parent_activity_id: activityId(tactic.id), parent_tactic_name: candidate.parent_name, expansion_version: candidate.expansion.version, expansion_scope: candidate.expansion.scope} : {}),
        tactic_name: tactic.name,
        missing,
        reason: `No ${missing.map((field) => field.replace("_", " ")).join(", ")} yet. Date it by hand, or rebuild the timeline to have the model estimate ${missing.length === 1 ? "it" : "them"}.`,
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

  const problems: TimelineProblem[] = [];
  const nameOf = (id: string) => resolved.get(id)?.candidate.tactic.name ?? id;
  const allCandidates = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  // Only dependencies a person set or accepted gate the schedule. One on an
  // activity that is not dated on the timeline is reported, not dropped silently.
  const dependenciesOf = (id: string): { id: string; reason: string | null }[] => {
    const saved = resolved.get(id)?.candidate.saved ?? null;
    return acceptedDependencies(saved)
      .filter((upstream) => upstream !== id)
      .filter((upstream) => resolved.has(upstream))
      .map((upstream) => ({ id: upstream, reason: saved?.meta?.dependency_reasons?.[upstream] ?? null }));
  };
  for (const id of resolved.keys()) {
    const saved = resolved.get(id)!.candidate.saved;
    for (const upstream of acceptedDependencies(saved)) {
      if (upstream === id || resolved.has(upstream)) continue;
      const known = allCandidates.get(upstream);
      problems.push({
        kind: "dangling",
        activity_id: id,
        upstream_id: upstream,
        message: `${nameOf(id)} waits on ${known ? known.tactic.name : upstream}, which ${
          known ? "has no dates on the timeline" : "is not on the timeline"
        }. Date it, or edit the dependencies.`,
      });
    }
  }

  // A model's proposals: this build's fresh answer, else what the row kept.
  // Never one a person rejected or already accepted, never the activity itself.
  const proposalsOf = (id: string): ProposedDependency[] => {
    const saved = resolved.get(id)?.candidate.saved ?? null;
    if (saved?.meta?.depends_locked === true && !args.dependencies?.has(id)) return savedProposals(saved);
    const fresh = args.dependencies?.get(id);
    const list = fresh ? fresh.upstream.map((row) => ({ id: row.id, reason: row.reason })) : savedProposals(saved);
    const accepted = new Set(acceptedDependencies(saved));
    const rejected = new Set(saved?.meta?.rejected_dependencies ?? []);
    return list.filter((row) => row.id !== id && resolved.has(row.id) && !accepted.has(row.id) && !rejected.has(row.id));
  };

  // An estimated start is itself a proposal, so it is laid out after the readouts
  // of what it is accepted or proposed to wait on; nothing saved is ever moved.
  const estimatedStart = (id: string) => {
    const row = resolved.get(id)!;
    return row.startSource === "model" && !row.candidate.saved;
  };
  const gatesOf = (id: string): string[] => [
    ...new Set([
      ...dependenciesOf(id).map((dependency) => dependency.id),
      ...(estimatedStart(id) ? proposalsOf(id).map((proposal) => proposal.id) : []),
    ]),
  ];
  const acceptedEdge = (id: string, upstream: string) => dependenciesOf(id).some((dependency) => dependency.id === upstream);

  // Layout in dependency order, so an upstream readout is final before it gates.
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visiting.add(id);
    for (const upstreamId of gatesOf(id)) {
      const upstream = { id: upstreamId };
      if (visiting.has(upstream.id)) {
        if (!acceptedEdge(id, upstream.id)) continue;
        problems.push({
          kind: "cycle",
          activity_id: id,
          upstream_id: upstream.id,
          message: `${nameOf(id)} and ${nameOf(upstream.id)} wait on each other (a dependency loop). Remove one of the dependencies.`,
        });
        continue;
      }
      visit(upstream.id);
    }
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
    const gates = gatesOf(id);
    if (gates.length > 0 && estimatedStart(id)) {
      const gate = maxDate(
        gates.map((upstreamId) => {
          const other = placed.get(upstreamId);
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
    const savedMeta = candidate.saved?.meta ?? null;
    const currentKey = inputsKey(candidate);
    const askedNow = args.dependencies?.has(id) === true || !candidate.saved;
    const savedKey = savedMeta?.inputs_key;
    const basisNow = { start: row.startSource, end: row.endSource, readout: readout ? row.readoutSource : null };
    const laneLocked = candidate.saved?.meta?.lane_locked === true;
    const savedLane = candidate.saved?.lane as TimelineBand | undefined;
    const details = activityDetails(candidate);
    const activity: TimelineActivity = {
      ...details,
      id,
      tactic_id: tactic.id,
      ...(candidate.expansion ? {expansion_id: candidate.expansion.id, parent_activity_id: activityId(tactic.id), parent_tactic_name: candidate.parent_name, expansion_version: candidate.expansion.version, expansion_scope: candidate.expansion.scope} : {}),
      tactic_name: tactic.name,
      lane: laneLocked && savedLane && TIMELINE_LANES.includes(savedLane) ? savedLane : candidate.band,
      start_date: start,
      end_date: end,
      readout_date: readout,
      depends_on: upstream.map((dependency) => dependency.id),
      meta: {
        ...details.meta,
        dependency_note:
          reasons.length > 0
            ? reasons.map((dependency) => `${placed.get(dependency.id)?.tactic_name ?? dependency.id}: ${dependency.reason}`).join(" ")
            : upstream.length > 0
              ? (candidate.saved?.meta?.dependency_note ?? null)
              : null,
        schedule_rationale: row.rationale,
        schedule_basis: basisNow,
        lane_locked: laneLocked,
        depends_locked: candidate.saved?.meta?.depends_locked === true,
        rationale_locked: candidate.saved?.meta?.rationale_locked === true,
        manual: candidate.saved?.meta?.manual === true,
        proposed_dependencies: proposalsOf(id),
        rejected_dependencies: savedMeta?.rejected_dependencies ?? [],
        inputs_key: askedNow ? currentKey : (savedKey ?? ""),
        // A model estimate made from inputs that have since changed is out of date.
        estimate_stale:
          !askedNow &&
          savedKey !== undefined &&
          savedKey !== currentKey &&
          estimatedFields(basisNow).length > 0,
      },
    };
    placed.set(id, activity);
    activities.push(activity);
  }

  // Start, end and readout: a readout can fall before the end, and the window must hold the whole bar.
  const dates = activities.flatMap((activity) =>
    [activity.start_date, activity.end_date, activity.readout_date].filter((date): date is string => Boolean(date)),
  );
  const windowStart = dates.length ? dates.slice().sort()[0]! : anchor;
  const windowEnd = dates.length ? dates.slice().sort()[dates.length - 1]! : addMonths(anchor, 12);

  const tacticById = new Map(args.state.tactics.map((tactic) => [tactic.id, tactic]));
  const removed: RemovedActivity[] = [];
  for (const row of args.overrides ?? []) {
    const expansion = args.state.expansions?.find(child => activityId(child.tactic_id, child.id) === row.id);
    const tactic = tacticById.get(expansion?.tactic_id ?? row.id.replace(/^ACT-/, ""));
    if (!isRemoved(row) || !tactic) continue;
    removed.push({
      activity_id: row.id,
      tactic_id: tactic.id,
      ...(expansion ? {expansion_id: expansion.id, parent_activity_id: activityId(tactic.id), parent_tactic_name: tactic.name} : {}),
      tactic_name: expansion?.scope.name ?? tactic.name,
      reason: row.meta?.removed_reason ?? "Removed by hand.",
    });
  }
  const removedTactics = new Set(removed.map((row) => row.tactic_id));
  const unscheduled = liveGaps
    .filter(
      (gap) =>
        displayedGapStatus(gap) === "validated_open" &&
        !candidates.some((candidate) => candidate.gap_ids.includes(gap.id)),
    )
    .map((gap) => ({
      gap_id: gap.id,
      gap_name: gap.name,
      reason: args.state.coverages.some(
        (coverage) => coverage.gap_id === gap.id && removedTactics.has(coverage.tactic_id),
      )
        ? "Its activity was removed from the timeline by hand."
        : "Open gap with no mapped or ideated tactic yet.",
    }));

  // Cancelled tactics on live gaps are not in the plan; the count stays visible.
  const liveGapIds = new Set(liveGaps.map((gap) => gap.id));
  const cancelled = args.state.tactics
    .filter(
      (tactic) =>
        tactic.status === "cancelled" &&
        args.state.coverages.some((coverage) => coverage.tactic_id === tactic.id && liveGapIds.has(coverage.gap_id)),
    )
    .map((tactic) => ({ tactic_id: tactic.id, tactic_name: tactic.name }));

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
    removed,
    cancelled,
    problems,
  };
}
