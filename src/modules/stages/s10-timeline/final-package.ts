import { createHash } from "node:crypto";
import { desc } from "drizzle-orm";
import { db } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { findGapOrphans, gapRecord, type GapOrphan, type GapRecord } from "@/lib/iegp/gap-record";
import type { IegpState, Tactic } from "@/lib/iegp/types";
import type { PlacementRecord } from "@/modules/stages/s8-prioritization/module";
import type { StoredAxes } from "@/modules/stages/s8-prioritization/axes";
import type { TimelineModel } from "./build";

/**
 * The complete final IEGP (KAN-86): the Evidence Gap Inventory, the Evidence
 * Tactics, the Prioritisation and the Roadmap, frozen together as one version,
 * with the open items and limitations a reader needs to tell the evidence
 * inventory from the execution roadmap. Format: docs/sdlc/15-final-package.md.
 */
export const FINAL_PACKAGE_SCHEMA = "iegp-final/1";

/** Workshops are parked (KAN-84): the package says so instead of leaving a silent hole. */
export const NO_WORKSHOP = "Workshop outcomes: none (workshop not in use)";

export const LEGACY_PACKAGE_NOTE =
  "Legacy package (timeline only) — gap inventory, tactics and priority were not frozen";

type Gap = IegpState["gaps"][0];

/** Where a tactic came from, so planned work is never read as evidence already in hand. */
export type TacticOrigin = "source_document" | "recorded_missed" | "ideation" | "added_by_hand";

/** How a tactic reads in the plan: generated evidence, work under way, or work not yet committed. */
export type TacticEvidenceState =
  | "completed_evidence"
  | "ongoing_work"
  | "planned_work"
  | "proposed_not_committed"
  | "cancelled";

export type FrozenGap = {
  id: string;
  number: number | null;
  name: string;
  statement: string;
  domain: string;
  /** The status a reader sees: the engine's, or a person's override. */
  effective_status: string;
  override: { status: string; rationale: string | null; by: string } | null;
  settings: unknown;
  metadata: unknown;
  objective: { id: string; title: string } | null;
  confirmation: GapRecord["confirmation"];
  parked: { at: string; reason: string | null } | null;
  parent_gap_id: string | null;
  origin_gap_id: string | null;
  needs: {
    id: string;
    statement: string;
    role: string;
    source: { id: string; title: string; filename: string | null; source_type: string } | null;
    quote: string | null;
    block_id: string | null;
    run_id: string | null;
    candidate_row_id: string | null;
  }[];
  coverages: {
    id: string;
    tactic_id: string;
    expansion_id: string | null;
    overall: string;
    rationale: string | null;
    dimensions: unknown;
  }[];
  residuals: { id: string; statement: string; review_status: string }[];
  priority: {
    band: string | null;
    validated: boolean;
    axis_scores: Record<string, number>;
    rationale: string | null;
    validated_by: string | null;
    at: string;
  } | null;
};

export type FrozenTactic = {
  id: string;
  name: string;
  type: string;
  custom_type: string | null;
  description: string;
  evidence_question: string;
  objective: string;
  owner: string;
  function: string;
  timing: { start_date: string | null; evidence_available: string | null };
  outputs: string;
  lifecycle_status: Tactic["status"];
  evidence_state: TacticEvidenceState;
  origin: TacticOrigin;
  gap_ids: string[];
  expansions: { id: string; name: string; status: string; gap_ids: string[] }[];
};

export type FinalPackage = {
  schema_version: typeof FINAL_PACKAGE_SCHEMA;
  built_at: string;
  workspace_id: string | null;
  plan_context: {
    asset: { name: string; inn: string; indication: string; geography: string };
    planning_context: unknown;
    objectives: { id: string; title: string }[];
  };
  evidence_gap_inventory: FrozenGap[];
  evidence_tactics: FrozenTactic[];
  prioritisation: {
    axes: { id: string; label: string }[];
    x_axis: string;
    y_axis: string;
    placements: (NonNullable<FrozenGap["priority"]> & { gap_id: string })[];
  };
  roadmap: {
    activities: TimelineModel["activities"];
    window: TimelineModel["window"];
    lanes: TimelineModel["lanes"];
    pending: TimelineModel["pending"];
    removed: TimelineModel["removed"];
    cancelled: TimelineModel["cancelled"];
    fingerprint: string;
    fingerprint_code: string;
  };
  open_items: {
    /** Open gaps with no dated activity on the roadmap. Permitted: the plan says so. */
    unscheduled: { gap_id: string; gap_name: string; reason: string }[];
    /** Open gaps with no tactic of any status. */
    unaddressed: { gap_id: string; gap_name: string }[];
    /** Open gaps a person banded "defer". */
    deferred: { gap_id: string; gap_name: string; rationale: string | null }[];
    parked: { gap_id: string; gap_name: string; reason: string | null }[];
    excluded: { gap_id: string; gap_name: string; reason: string | null }[];
    limitations: string[];
  };
  workshop_outcomes: { status: "none"; note: typeof NO_WORKSHOP };
  lineage: {
    source_ids: string[];
    run_ids: { id: string; stage: string; started_at: string; status: string }[];
    need_run_ids: string[];
  };
};

/** Everything the package reads, gathered once so every part is from the same revision. */
export type PackageInputs = {
  state: IegpState;
  model: TimelineModel;
  placements: PlacementRecord[];
  axes: StoredAxes;
  workspace_id: string | null;
  fingerprint: string;
  fingerprint_code: string;
  built_at: string;
};

const ACCEPTED_IDEA = new Set(["accepted"]);

function evidenceState(status: Tactic["status"]): TacticEvidenceState {
  switch (status) {
    case "completed":
      return "completed_evidence";
    case "ongoing":
      return "ongoing_work";
    case "planned":
      return "planned_work";
    case "cancelled":
      return "cancelled";
    default:
      return "proposed_not_committed";
  }
}

function tacticOrigin(tactic: Tactic, ideationTacticIds: Set<string>): TacticOrigin {
  if (ideationTacticIds.has(tactic.id)) return "ideation";
  if (tactic.lifecycle_stage === "recorded") return "recorded_missed";
  if (tactic.source_quote?.trim()) return "source_document";
  return "added_by_hand";
}

function frozenGap(record: GapRecord, placement: PlacementRecord | undefined): FrozenGap {
  const gap = record.gap;
  return {
    id: gap.id,
    number: gap.number ?? null,
    name: gap.name,
    statement: gap.statement,
    domain: gap.domain,
    effective_status: displayedGapStatus(gap),
    override: gap.status_override
      ? { status: gap.status_override.to, rationale: gap.status_override.reason, by: gap.status_override.actor_name }
      : null,
    settings: gap.settings ?? null,
    metadata: gap.metadata ?? null,
    objective: record.objective ? { id: record.objective.id, title: record.objective.name } : null,
    confirmation: record.confirmation,
    parked: gap.parked_at ? { at: gap.parked_at, reason: gap.parked_reason ?? null } : null,
    parent_gap_id: gap.parent_gap_id ?? null,
    origin_gap_id: gap.origin_gap_id ?? null,
    needs: record.needs.map(({ need, role, source }) => ({
      id: need.id,
      statement: need.statement,
      role,
      source: source ? { id: source.id, title: source.title, filename: source.filename ?? null, source_type: source.source_type } : null,
      quote: need.source_quote ?? null,
      block_id: need.block_id ?? null,
      run_id: need.run_id ?? null,
      candidate_row_id: need.candidate_row_id ?? null,
    })),
    coverages: record.coverages.map((c) => ({
      id: c.id,
      tactic_id: c.tactic_id,
      expansion_id: c.expansion_id ?? null,
      overall: c.overall,
      rationale: c.overall_rationale ?? null,
      dimensions: c.dimensions ?? null,
    })),
    residuals: record.residuals.map((r) => ({ id: r.id, statement: r.statement, review_status: r.review_status })),
    priority: placement
      ? {
          band: placement.band,
          validated: placement.validated,
          axis_scores: placement.axis_scores,
          rationale: placement.rationale,
          validated_by: placement.validated ? placement.actor_name : null,
          at: placement.at,
        }
      : null,
  };
}

/** Builds the package from one read of the workspace. Pure apart from the gap and run reads. */
export async function buildFinalPackage(inputs: PackageInputs): Promise<FinalPackage> {
  const { state, model, placements } = inputs;
  const placementByGap = new Map(placements.map((p) => [p.gap_id, p]));
  const live = state.gaps.filter(isLiveGap);
  const records: GapRecord[] = [];
  for (const gap of live) {
    const record = await gapRecord(gap.id, state);
    if (record) records.push(record);
  }
  const ideas = await db().select().from(t.ideationProposals);
  const ideationTacticIds = new Set(
    ideas.filter((row) => ACCEPTED_IDEA.has(row.status) && row.tactic_id).map((row) => row.tactic_id!),
  );
  const objectivesById = new Map(state.objectives.map((o) => [o.id, o]));
  const gapsByTactic = new Map<string, Set<string>>();
  for (const c of state.coverages) {
    if (!live.some((g) => g.id === c.gap_id)) continue;
    const set = gapsByTactic.get(c.tactic_id) ?? new Set<string>();
    set.add(c.gap_id);
    gapsByTactic.set(c.tactic_id, set);
  }
  const tactics: FrozenTactic[] = state.tactics.map((tactic) => {
    const gapIds = [...(gapsByTactic.get(tactic.id) ?? [])].sort();
    const objective = [
      ...new Set(
        gapIds
          .map((id) => live.find((g) => g.id === id)?.objective_id)
          .filter((id): id is string => Boolean(id))
          .map((id) => objectivesById.get(id)?.name ?? id),
      ),
    ].join("; ");
    return {
      id: tactic.id,
      name: tactic.name,
      type: tactic.type,
      custom_type: tactic.custom_type?.label ?? null,
      description: tactic.description,
      evidence_question: tactic.evidence_question,
      objective,
      owner: tactic.owner,
      function: tactic.function,
      timing: { start_date: tactic.start_date, evidence_available: tactic.evidence_available },
      outputs: tactic.intended_use,
      lifecycle_status: tactic.status,
      evidence_state: evidenceState(tactic.status),
      origin: tacticOrigin(tactic, ideationTacticIds),
      gap_ids: gapIds,
      expansions: state.expansions
        .filter((e) => e.tactic_id === tactic.id)
        .map((e) => ({ id: e.id, name: e.scope.name, status: e.status, gap_ids: [...e.gap_ids] })),
    };
  });

  const openLive = live.filter((g) => displayedGapStatus(g) === "validated_open");
  const tacticGapIds = new Set(state.coverages.map((c) => c.gap_id));
  const scheduledGapIds = new Set(model.activities.flatMap((a) => a.gap_ids));
  const unaddressed = openLive.filter((g) => !tacticGapIds.has(g.id));
  const deferred = openLive.filter((g) => placementByGap.get(g.id)?.band === "defer");
  const parked = state.gaps.filter((g) => !g.retired && g.parked_at);
  const excluded = state.gaps.filter((g) => !g.retired && g.status === "excluded");
  const unscheduled = [
    ...model.unscheduled,
    ...openLive
      .filter((g) => !scheduledGapIds.has(g.id) && !model.unscheduled.some((row) => row.gap_id === g.id))
      .map((g) => ({ gap_id: g.id, gap_name: g.name, reason: "No dated activity on the roadmap." })),
  ];
  const limitations: string[] = [NO_WORKSHOP];
  if (unaddressed.length > 0) {
    limitations.push(`${unaddressed.length} open gap(s) have no tactic yet; the roadmap does not close them.`);
  }
  if (deferred.length > 0) limitations.push(`${deferred.length} open gap(s) are deferred to a later cycle.`);
  const planned = tactics.filter((x) => x.evidence_state === "planned_work" || x.evidence_state === "ongoing_work").length;
  if (planned > 0) {
    limitations.push(`${planned} tactic(s) are planned or ongoing work: their evidence is not yet generated.`);
  }
  const proposed = tactics.filter((x) => x.evidence_state === "proposed_not_committed").length;
  if (proposed > 0) limitations.push(`${proposed} tactic(s) are proposed and not yet committed to the plan.`);

  const runs = await db()
    .select({ id: t.moduleRuns.id, stage: t.moduleRuns.stage, started_at: t.moduleRuns.started_at, status: t.moduleRuns.status })
    .from(t.moduleRuns)
    .orderBy(desc(t.moduleRuns.started_at))
    .limit(200);

  return {
    schema_version: FINAL_PACKAGE_SCHEMA,
    built_at: inputs.built_at,
    workspace_id: inputs.workspace_id,
    plan_context: {
      asset: {
        name: state.asset.name,
        inn: state.asset.inn,
        indication: state.asset.indication,
        geography: state.asset.geography,
      },
      planning_context: state.asset.planning_context ?? null,
      objectives: state.objectives.map((o) => ({ id: o.id, title: o.name })),
    },
    evidence_gap_inventory: records.map((record) => frozenGap(record, placementByGap.get(record.gap.id))),
    evidence_tactics: tactics,
    prioritisation: {
      axes: inputs.axes.axes.map((axis) => ({ id: axis.id, label: axis.label })),
      x_axis: inputs.axes.x_axis,
      y_axis: inputs.axes.y_axis,
      placements: placements
        .filter((p) => live.some((g) => g.id === p.gap_id))
        .map((p) => ({
          gap_id: p.gap_id,
          band: p.band,
          validated: p.validated,
          axis_scores: p.axis_scores,
          rationale: p.rationale,
          validated_by: p.validated ? p.actor_name : null,
          at: p.at,
        })),
    },
    roadmap: {
      activities: model.activities,
      window: model.window,
      lanes: model.lanes,
      pending: model.pending,
      removed: model.removed,
      cancelled: model.cancelled,
      fingerprint: inputs.fingerprint,
      fingerprint_code: inputs.fingerprint_code,
    },
    open_items: {
      unscheduled,
      unaddressed: unaddressed.map((g) => ({ gap_id: g.id, gap_name: g.name })),
      deferred: deferred.map((g) => ({ gap_id: g.id, gap_name: g.name, rationale: placementByGap.get(g.id)?.rationale ?? null })),
      parked: parked.map((g) => ({ gap_id: g.id, gap_name: g.name, reason: g.parked_reason ?? null })),
      excluded: excluded.map((g) => ({ gap_id: g.id, gap_name: g.name, reason: g.exclusion_note ?? g.exclusion_reason ?? null })),
      limitations,
    },
    workshop_outcomes: { status: "none", note: NO_WORKSHOP },
    lineage: {
      source_ids: state.sources.map((s) => s.id).sort(),
      run_ids: runs,
      need_run_ids: [...new Set(state.needs.map((n) => n.run_id).filter((id): id is string => Boolean(id)))].sort(),
    },
  };
}

/**
 * What stops a complete final (KAN-86), in plain English. Unscheduled, deferred,
 * parked and excluded items are allowed: the package lists them instead.
 */
/** One thing that stops a complete final, with the gap it names (if any) and what to do. */
export type PackageBlocker = {
  issue: "candidate" | "partial" | "unconfirmed" | "no_band" | "orphans" | "foreign_reference";
  gap_id: string | null;
  message: string;
};

export function finalPackageBlockers(args: {
  state: IegpState;
  placements: PlacementRecord[];
  orphans: GapOrphan[];
}): PackageBlocker[] {
  const { state, placements, orphans } = args;
  const blockers: PackageBlocker[] = [];
  const label = (gap: Gap) => `${gap.name} (${gap.id})`;
  const live = state.gaps.filter(isLiveGap);
  for (const gap of live) {
    const status = displayedGapStatus(gap);
    if (gap.status === "candidate") {
      blockers.push({ issue: "candidate", gap_id: gap.id, message: `${label(gap)} is still a candidate. Keep it as Open or Addressed, or exclude it, on Evidence Inventory.` });
    } else if (status === "validated_partial") {
      blockers.push({ issue: "partial", gap_id: gap.id, message: `${label(gap)} is Partially Addressed. Split it or rewrite it as Open or Addressed.` });
    } else if (!gap.human_validated) {
      blockers.push({ issue: "unconfirmed", gap_id: gap.id, message: `${label(gap)} has not been confirmed. Confirm it on Evidence Inventory.` });
    }
  }
  const validatedBand = new Set(placements.filter((p) => p.validated && p.band).map((p) => p.gap_id));
  for (const gap of live.filter((g) => displayedGapStatus(g) === "validated_open")) {
    if (!validatedBand.has(gap.id)) {
      blockers.push({
        issue: "no_band",
        gap_id: gap.id,
        message: `${label(gap)} is Open with no validated priority band. Validate its band on the Prioritization Matrix.`,
      });
    }
  }
  if (orphans.length > 0) {
    blockers.push({
      issue: "orphans",
      gap_id: null,
      message: `${orphans.length} record(s) still point at a retired or missing gap (${[...new Set(orphans.map((o) => o.gap_id))].join(", ")}). Ask your administrator to run the gap check.`,
    });
  }
  return blockers;
}

/** Plain-English refusal for a blocked final, with the permitted open items explained. */
export function packageRefusal(blockers: PackageBlocker[]): string {
  return [
    `The complete plan cannot be saved as final yet (${blockers.length} thing${blockers.length === 1 ? "" : "s"} to resolve):`,
    ...blockers.map((row) => `• ${row.message}`),
    "Unscheduled, deferred, parked and excluded gaps do not block it: the final plan lists them as open items.",
    "You can still save a draft.",
  ].join("\n");
}

/** Canonical JSON: object keys sorted at every depth, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * sha256 over the whole package, except built_at (when it was assembled is not
 * part of what was approved; the saved record keeps the time separately).
 */
export function packageFingerprint(pkg: FinalPackage): string {
  const rest: Partial<FinalPackage> = { ...pkg };
  delete rest.built_at;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/** Whether a stored snapshot holds a complete package, or only the older timeline freeze. */
export function isCompletePackage(snapshot: { package?: unknown }): snapshot is { package: FinalPackage } {
  const pkg = snapshot.package as { schema_version?: unknown } | undefined;
  return Boolean(pkg && typeof pkg === "object" && pkg.schema_version === FINAL_PACKAGE_SCHEMA);
}

/** Same check for gap ids in the roadmap: every activity points at a gap of this workspace. */
export function foreignReferences(state: IegpState, model: TimelineModel): PackageBlocker[] {
  const ids = new Set(state.gaps.map((g) => g.id));
  const tacticIds = new Set(state.tactics.map((x) => x.id));
  const out: PackageBlocker[] = [];
  for (const activity of model.activities) {
    for (const gapId of activity.gap_ids) {
      if (!ids.has(gapId)) {
        out.push({ issue: "foreign_reference", gap_id: gapId, message: `${activity.tactic_name} points at gap ${gapId}, which is not in this workspace.` });
      }
    }
    if (!activity.meta.manual && !tacticIds.has(activity.tactic_id)) {
      out.push({ issue: "foreign_reference", gap_id: null, message: `${activity.tactic_name} points at tactic ${activity.tactic_id}, which is not in this workspace.` });
    }
  }
  return out;
}

export { findGapOrphans };
