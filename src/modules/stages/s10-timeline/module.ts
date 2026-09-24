import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import { loadState } from "@/lib/iegp/store";
import type { IegpState } from "@/lib/iegp/types";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import {
  buildTimeline,
  missingSchedule,
  timelineCandidates,
  type ActivityDesign,
  type DependencyAnswer,
  type SavedActivity,
  type ScheduleEstimate,
  type ScheduleField,
  type TimelineActivity,
  type TimelineCandidate,
  type TimelineModel,
} from "./build";

const inputSchema = z.object({
  /** What the model's start offsets count from. Defaults to today. */
  anchor: z.string().optional(),
  persist: z.boolean().default(true),
});

const sourceSchema = z.enum(["saved", "tactic", "design", "model"]);

const activitySchema = z.object({
  id: z.string(),
  tactic_id: z.string(),
  tactic_name: z.string(),
  tactic_type: z.string(),
  tactic_status: z.string(),
  lane: z.string(),
  band: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  readout_date: z.string().nullable(),
  depends_on: z.array(z.string()),
  gap_ids: z.array(z.string()),
  gap_names: z.array(z.string()),
  meta: z.object({
    evidence_question: z.string(),
    population: z.string(),
    comparator: z.string(),
    outcomes: z.string(),
    data_source: z.string(),
    study_design: z.string(),
    owner: z.string(),
    function: z.string(),
    priority_rationale: z.string().nullable(),
    dependency_note: z.string().nullable(),
    counts_toward_addressing: z.boolean(),
    schedule_rationale: z.string().nullable(),
    schedule_basis: z.object({ start: sourceSchema, end: sourceSchema, readout: sourceSchema.nullable() }),
    lane_locked: z.boolean(),
  }),
});

const outputSchema = z.object({
  activities: z.array(activitySchema),
  window: z.object({ start: z.string(), end: z.string(), months: z.number() }),
  lanes: z.array(z.object({ id: z.string(), label: z.string(), count: z.number() })),
  unscheduled: z.array(z.object({ gap_id: z.string(), gap_name: z.string(), reason: z.string() })),
  pending: z.array(
    z.object({
      activity_id: z.string(),
      tactic_id: z.string(),
      tactic_name: z.string(),
      missing: z.array(z.enum(["start", "duration", "readout_lag"])),
      reason: z.string(),
    }),
  ),
});

export type TimelineInput = z.infer<typeof inputSchema>;
export type TimelineOutput = z.infer<typeof outputSchema>;

async function storedActivities(): Promise<SavedActivity[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.timelineActivities);
  return rows.map((row) => ({
    id: row.id,
    start_date: row.start_date,
    end_date: row.end_date,
    readout_date: row.readout_date,
    lane: row.lane,
    depends_on: (row.depends_on as string[]) ?? [],
    meta: (row.meta as SavedActivity["meta"]) ?? null,
  }));
}

/** A finite number above zero (or at least zero), else undefined. Schema validation only. */
const positive = (value: unknown, allowZero: boolean): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : undefined;

/**
 * The duration and readout lag each tactic's own design carries: the S9
 * proposal a human accepted into that tactic. Only values the design states
 * are returned; nothing is defaulted.
 */
export async function tacticDesigns(): Promise<Map<string, ActivityDesign>> {
  const proposals = await listIdeationProposals();
  const designs = new Map<string, ActivityDesign>();
  for (const proposal of proposals) {
    if (proposal.status !== "accepted" || !proposal.tactic_id) continue;
    const design = (proposal.design ?? {}) as Record<string, unknown>;
    const duration = positive(design.duration_months, false);
    const lag = positive(design.readout_lag_months, true);
    const why = typeof design.timing_rationale === "string" ? design.timing_rationale.trim() : "";
    designs.set(proposal.tactic_id, {
      ...(duration !== undefined ? { duration_months: duration } : {}),
      ...(lag !== undefined ? { readout_lag_months: lag } : {}),
      ...(why ? { timing_rationale: why } : {}),
    });
  }
  return designs;
}

/**
 * The timeline as saved: user edits, earlier builds, and whatever the tactics'
 * own dates and designs fix. It calls no model, so an activity nobody has dated
 * yet is listed as pending until the stage runs.
 */
export async function timelineModel(anchor?: string): Promise<TimelineModel> {
  const [state, placements, overrides, designs] = await Promise.all([
    loadState(),
    listPlacements(),
    storedActivities(),
    tacticDesigns(),
  ]);
  return buildTimeline({ state, placements, overrides, designs, anchor });
}

const DEPENDENCY_SYSTEM = `You sequence the activities of a pharma Integrated Evidence Generation Plan (IEGP).

For each activity you are asked about, decide which other listed activities it must wait for before it can start — for example a publication that reports a study's results, an analysis that needs another study's data, a model that needs an input study, or work on a sub-gap that builds on its parent gap's evidence. Only name a dependency when the activity genuinely cannot start before the upstream readout; activities that can run in parallel have none. Use only the activity ids listed, never the activity itself, and never create a cycle.

Answer for every activity in "answer_for", with an empty list when it depends on nothing. Give each dependency a one-sentence reason.

Return JSON only: {"activities":[{"id":"","depends_on":[{"id":"","reason":""}]}]}`;

const ESTIMATE_SYSTEM = `You schedule evidence-generation activities for a pharma Integrated Evidence Generation Plan (IEGP).

For each activity, estimate only the fields listed in its "estimate" array:
- start_offset_months: whole months after the plan anchor date when the work should start, given its validated priority band (or that it is not yet prioritized), its status (ongoing work may already have started), the key decisions and their dates it must inform, and the activities it depends on.
- duration_months: how long the work itself takes, from start to last data, for this design, population and data source.
- readout_lag_months: months from the end of the work to results being available to decision-makers (analysis, reporting).

Values fixed by the team are given as "fixed"; do not change them, but use them to sequence the rest. An activity should not start before the readouts it depends on. Keep each rationale to one or two sentences naming what drove the estimate.

Answer for every activity you are given.

Return JSON only: {"activities":[{"id":"","start_offset_months":0,"duration_months":0,"readout_lag_months":0,"rationale":""}]}`;

const REMEDY = "rebuild the timeline or switch the S10 route in /control.";

function describeActivity(candidate: TimelineCandidate) {
  const tactic = candidate.tactic;
  return {
    id: candidate.id,
    name: tactic.name,
    type: tactic.type,
    status: tactic.status,
    priority: candidate.band === "unprioritized" ? "not yet prioritized" : candidate.band,
    gaps: candidate.gap_names,
    evidence_question: tactic.evidence_question,
    design: {
      population: tactic.population,
      comparator: tactic.comparator,
      outcomes: tactic.outcomes,
      data_source: tactic.data_source,
      study_design: tactic.study_design,
    },
  };
}

function planningPrompt(state: IegpState, anchor: string) {
  return {
    anchor,
    asset: {
      name: state.asset.name,
      inn: state.asset.inn,
      indication: state.asset.indication,
      geography: state.asset.geography,
    },
    context: prioritizationContextFromState(state),
    decisions: state.objectives
      .filter((objective) => objective.key_decision || objective.decision_date)
      .map((objective) => ({
        objective: objective.name,
        key_decision: objective.key_decision,
        decision_date: objective.decision_date,
      })),
  };
}

/** True when `from` waiting on `upstream` would close a loop in the accepted graph. */
function wouldCycle(graph: Map<string, string[]>, from: string, upstream: string[]): boolean {
  const seen = new Set<string>();
  const stack = [...upstream];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === from) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return false;
}

async function llmDependencies(
  ctx: ModuleContext,
  args: {
    state: IegpState;
    anchor: string;
    candidates: TimelineCandidate[];
    missing: string[];
    graph: Map<string, string[]>;
    retry: boolean;
  },
): Promise<Map<string, DependencyAnswer>> {
  const known = new Set(args.candidates.map((candidate) => candidate.id));
  const parentOf = new Map(args.state.gaps.map((gap) => [gap.id, gap.parent_gap_id]));
  const payload = (await ctx.complete({
    system: DEPENDENCY_SYSTEM,
    user: JSON.stringify({
      ...planningPrompt(args.state, args.anchor),
      note: args.retry
        ? "An earlier answer left these activities out, named an unknown id or the activity itself, gave no reason, or created a cycle. Answer each again using only listed ids."
        : undefined,
      answer_for: args.missing,
      activities: args.candidates.map((candidate) => ({
        ...describeActivity(candidate),
        gap_ids: candidate.gap_ids,
        parent_gap_ids: candidate.gap_ids
          .map((gapId) => parentOf.get(gapId))
          .filter((parent): parent is string => Boolean(parent)),
      })),
    }),
    purpose: "timeline-dependencies",
  })) as { activities?: { id?: string; depends_on?: { id?: string; reason?: string }[] }[] };
  const map = new Map<string, DependencyAnswer>();
  for (const row of payload?.activities ?? []) {
    if (!row.id || !args.missing.includes(row.id) || map.has(row.id) || !Array.isArray(row.depends_on)) continue;
    const upstream = row.depends_on.map((item) => ({ id: item?.id ?? "", reason: (item?.reason ?? "").trim() }));
    // An invalid row is left out so the caller asks for it again.
    if (upstream.some((item) => !known.has(item.id) || item.id === row.id || !item.reason)) continue;
    const ids = [...new Set(upstream.map((item) => item.id))];
    if (wouldCycle(args.graph, row.id, ids)) continue;
    args.graph.set(row.id, ids);
    map.set(row.id, { upstream: ids.map((id) => upstream.find((item) => item.id === id)!) });
  }
  return map;
}

const ESTIMATE_FIELD: Record<ScheduleField, "start_offset_months" | "duration_months" | "readout_lag_months"> = {
  start: "start_offset_months",
  duration: "duration_months",
  readout_lag: "readout_lag_months",
};

async function llmEstimates(
  ctx: ModuleContext,
  args: {
    state: IegpState;
    anchor: string;
    targets: TimelineCandidate[];
    all: TimelineCandidate[];
    dependencies: Map<string, DependencyAnswer>;
    retry: boolean;
  },
): Promise<Map<string, ScheduleEstimate>> {
  const fixed = (candidate: TimelineCandidate) =>
    candidate.saved
      ? {
          start_date: candidate.saved.start_date,
          end_date: candidate.saved.end_date,
          readout_date: candidate.saved.readout_date,
        }
      : {
          start_date: candidate.tactic.start_date ?? undefined,
          duration_months: candidate.design.duration_months,
          readout_lag_months: candidate.design.readout_lag_months,
          readout_date: candidate.tactic.evidence_available ?? undefined,
        };
  const targetIds = new Set(args.targets.map((candidate) => candidate.id));
  const payload = (await ctx.complete({
    system: ESTIMATE_SYSTEM,
    user: JSON.stringify({
      ...planningPrompt(args.state, args.anchor),
      note: args.retry
        ? "An earlier answer left these activities out, missed a requested field, gave an invalid number, or gave no rationale. Answer each in full."
        : undefined,
      activities: args.targets.map((candidate) => ({
        ...describeActivity(candidate),
        estimate: missingSchedule(candidate).map((field) => ESTIMATE_FIELD[field]),
        fixed: fixed(candidate),
        depends_on: args.dependencies.get(candidate.id)?.upstream ?? [],
      })),
      other_activities: args.all
        .filter((candidate) => !targetIds.has(candidate.id))
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.tactic.name,
          type: candidate.tactic.type,
          fixed: fixed(candidate),
        })),
    }),
    purpose: "timeline-estimates",
  })) as { activities?: ({ id?: string; rationale?: string } & Record<string, unknown>)[] };
  const byId = new Map(args.targets.map((candidate) => [candidate.id, candidate]));
  const map = new Map<string, ScheduleEstimate>();
  for (const row of payload?.activities ?? []) {
    const candidate = row.id ? byId.get(row.id) : undefined;
    if (!candidate) continue;
    const rationale = (row.rationale ?? "").trim();
    if (!rationale) continue;
    const estimate: ScheduleEstimate = { rationale };
    let complete = true;
    for (const field of missingSchedule(candidate)) {
      const key = ESTIMATE_FIELD[field];
      const value = positive(row[key], field !== "duration");
      const months = value === undefined ? undefined : Math.round(value);
      if (months === undefined || (field === "duration" && months < 1)) complete = false;
      else estimate[key] = months;
    }
    // Incomplete rows are left out so the caller asks again for them.
    if (complete) map.set(candidate.id, estimate);
  }
  return map;
}

export const timelineModule: SynapseModule<TimelineInput, TimelineOutput> = {
  manifest: {
    id: "s10-timeline.gantt",
    stage: "S10",
    version: "2.0.0",
    title: "Interactive Gantt timeline",
    summary:
      "Lays out the final IEGP as dated activities. Dates a user set and durations the tactic's design carries are kept; a model infers the dependencies between activities and estimates any start, duration or readout lag nobody supplied. Only validated bands place an activity. Needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["gantt", "llm-dependencies", "llm-schedule", "save-final", "image-export"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
    requireLlm(ctx, "The timeline");
    const anchor = (input.anchor ?? new Date().toISOString()).slice(0, 10);
    const [state, placements, overrides, designs] = await Promise.all([
      loadState(),
      listPlacements(),
      storedActivities(),
      tacticDesigns(),
    ]);
    const candidates = timelineCandidates({ state, placements, designs, overrides });
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const describe = (id: string) => byId.get(id)?.tactic.name ?? id;
    const none = () => new Map(candidates.map((candidate) => [candidate.id, { upstream: [] }]));

    // Test stub only: no model runs, so no dependency is inferred. A lone
    // activity has nothing to wait on, so there is nothing to ask.
    const graph = new Map<string, string[]>();
    const dependencies: Map<string, DependencyAnswer> =
      isTestStub() || candidates.length < 2
        ? none()
        : await ctx.run.step("dependencies", () =>
            completeAll({
              ids: candidates.map((candidate) => candidate.id),
              what: "dependency list",
              describe,
              remedy: REMEDY,
              ask: (missing, attempt) =>
                llmDependencies(ctx, { state, anchor, candidates, missing, graph, retry: attempt > 1 }),
            }),
          );

    const targets = candidates.filter((candidate) => missingSchedule(candidate).length > 0);
    let estimates = new Map<string, ScheduleEstimate>();
    if (targets.length > 0 && isTestStub()) {
      /**
       * Test stub only: fixed, labelled values so Vitest and Playwright can lay
       * out a timeline without a provider. The rationale says no model ran.
       */
      estimates = new Map(
        targets.map((candidate) => [
          candidate.id,
          {
            start_offset_months: 0,
            duration_months: 6,
            readout_lag_months: 1,
            rationale: "Test stub: no model was called.",
          },
        ]),
      );
    } else if (targets.length > 0) {
      estimates = await ctx.run.step("estimates", () =>
        completeAll({
          ids: targets.map((candidate) => candidate.id),
          what: "schedule estimate",
          describe,
          remedy: REMEDY,
          ask: (missing, attempt) =>
            llmEstimates(ctx, {
              state,
              anchor,
              targets: targets.filter((candidate) => missing.includes(candidate.id)),
              all: candidates,
              dependencies,
              retry: attempt > 1,
            }),
        }),
      );
    }

    const model = buildTimeline({ state, placements, designs, overrides, estimates, dependencies, anchor });
    if (model.pending.length > 0) {
      throw new Error(
        `The timeline could not date ${model.pending.map((row) => row.tactic_name).join(", ")}. Nothing was saved; ${REMEDY}`,
      );
    }
    if (input.persist) {
      for (const activity of model.activities) {
        const values = {
          id: activity.id,
          tactic_id: activity.tactic_id,
          gap_ids: activity.gap_ids,
          lane: activity.lane,
          start_date: activity.start_date,
          end_date: activity.end_date,
          readout_date: activity.readout_date,
          depends_on: activity.depends_on,
          band: activity.band,
          meta: activity.meta,
          updated_by: ctx.actor.name,
          updated_at: nowIso(),
        };
        await db()
          .insert(t.timelineActivities)
          .values(values)
          .onConflictDoUpdate({
            target: t.timelineActivities.id,
            // A saved row's dates survive a rebuild; derived fields refresh. The
            // lane follows the validated band unless a user moved it by hand.
            set: {
              tactic_id: values.tactic_id,
              gap_ids: values.gap_ids,
              lane: values.lane,
              band: values.band,
              meta: values.meta,
              depends_on: values.depends_on,
              updated_at: values.updated_at,
            },
          });
      }
    }
    ctx.run.note("timeline", {
      activities: model.activities.length,
      months: model.window.months,
      unscheduled: model.unscheduled.length,
      estimated: estimates.size,
    });
    return {
      output: model,
      summary: `${model.activities.length} activity(ies) across ${model.window.months} month(s); ${estimates.size} dated by the model; ${model.unscheduled.length} open gap(s) unscheduled`,
      evals: [
        { name: "activities", value: model.activities.length, unit: "count" },
        {
          name: "open_gaps_scheduled",
          value:
            model.activities.length + model.unscheduled.length === 0
              ? 0
              : Number(
                  (
                    model.activities.length /
                    (model.activities.length + model.unscheduled.length)
                  ).toFixed(3),
                ),
          unit: "ratio",
          target: 0.8,
        },
        {
          name: "activities_with_dependencies",
          value: model.activities.filter((activity) => activity.depends_on.length > 0).length,
          unit: "count",
        },
      ],
    };
  },
};

timelineModule.evals = {
  async cases() {
    // End-to-end gold case: the timeline the validated state currently implies.
    return [{ name: "validated-state", input: { persist: false, anchor: "2026-01-01" } }];
  },
  score({ output }) {
    const activities = output.activities;
    const scheduled = activities.length;
    const unscheduled = output.unscheduled.length;
    const dated = activities.filter((activity) => activity.end_date >= activity.start_date).length;
    const gated = activities
      .filter((activity) => activity.depends_on.length > 0)
      .filter((activity) =>
        activity.depends_on.every((upstreamId) => {
          const upstream = activities.find((candidate) => candidate.id === upstreamId);
          if (!upstream) return false;
          return activity.start_date >= (upstream.readout_date ?? upstream.end_date);
        }),
      ).length;
    const withDependencies = activities.filter((activity) => activity.depends_on.length > 0).length;
    return [
      {
        name: "open_gaps_scheduled",
        value:
          scheduled + unscheduled === 0 ? 0 : Number((scheduled / (scheduled + unscheduled)).toFixed(3)),
        unit: "ratio",
        target: 0.8,
      },
      {
        name: "dates_coherent",
        value: scheduled === 0 ? 0 : Number((dated / scheduled).toFixed(3)),
        unit: "ratio",
        target: 1,
      },
      {
        name: "dependencies_respect_readouts",
        value: withDependencies === 0 ? 1 : Number((gated / withDependencies).toFixed(3)),
        unit: "ratio",
        target: 1,
      },
      {
        name: "every_activity_carries_a_gap",
        value:
          scheduled === 0
            ? 0
            : Number(
                (activities.filter((activity) => activity.gap_ids.length > 0).length / scheduled).toFixed(3),
              ),
        unit: "ratio",
        target: 1,
      },
    ];
  },
};

registerModule(timelineModule);

/** A user moving an activity is an edit, so it needs a rationale like any other. */
export async function updateTimelineActivity(args: {
  id: string;
  start_date?: string;
  end_date?: string;
  readout_date?: string | null;
  lane?: string;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  await ensurePlatformSchema();
  const rationale = requireRationale(args.rationale);
  const rows = await db()
    .select()
    .from(t.timelineActivities)
    .where(eq(t.timelineActivities.id, args.id))
    .limit(1);
  const current = rows[0];
  if (!current) throw new Error(`Unknown activity ${args.id}. Rebuild the timeline first.`);
  const next = {
    start_date: args.start_date ?? current.start_date,
    end_date: args.end_date ?? current.end_date,
    readout_date: args.readout_date === undefined ? current.readout_date : args.readout_date,
    lane: args.lane ?? current.lane,
    updated_by: args.actor.name,
    updated_at: nowIso(),
  };
  if (next.end_date < next.start_date) throw new Error("An activity cannot end before it starts.");
  // The dates are now the user's own; a lane they chose is kept across rebuilds.
  const meta = { ...((current.meta as Record<string, unknown>) ?? {}) };
  const basis = (meta.schedule_basis as TimelineActivity["meta"]["schedule_basis"] | undefined) ?? {
    start: "saved",
    end: "saved",
    readout: current.readout_date ? "saved" : null,
  };
  meta.schedule_basis = {
    start: args.start_date ? "saved" : basis.start,
    end: args.end_date ? "saved" : basis.end,
    readout: args.readout_date === undefined ? basis.readout : args.readout_date ? "saved" : null,
  };
  if (args.lane) meta.lane_locked = true;
  await db()
    .update(t.timelineActivities)
    .set({ ...next, meta })
    .where(eq(t.timelineActivities.id, args.id));
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "timeline_activity",
    entity_id: args.id,
    field: "schedule",
    action: "edit",
    before: `${current.start_date} → ${current.end_date} (readout ${current.readout_date ?? "—"})`,
    after: `${next.start_date} → ${next.end_date} (readout ${next.readout_date ?? "—"})`,
    rationale,
    actor: args.actor,
  });
  return next;
}

export type IegpPlanRecord = {
  id: string;
  version: number;
  status: "draft" | "final";
  note: string | null;
  saved_by: string;
  saved_at: string;
  snapshot: {
    activities: TimelineActivity[];
    window: TimelineModel["window"];
    lanes: TimelineModel["lanes"];
    unscheduled: TimelineModel["unscheduled"];
    /** Absent on snapshots saved before activities could be pending. */
    pending?: TimelineModel["pending"];
    counts: { gaps: number; tactics: number; open: number; addressed: number };
  };
};

export async function latestPlan(): Promise<IegpPlanRecord | null> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.iegpPlans).orderBy(desc(t.iegpPlans.version)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    status: row.status as IegpPlanRecord["status"],
    note: row.note,
    saved_by: row.saved_by,
    saved_at: row.saved_at,
    snapshot: row.snapshot as IegpPlanRecord["snapshot"],
  };
}

export async function planHistory(limit = 20): Promise<IegpPlanRecord[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.iegpPlans).orderBy(desc(t.iegpPlans.version)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    status: row.status as IegpPlanRecord["status"],
    note: row.note,
    saved_by: row.saved_by,
    saved_at: row.saved_at,
    snapshot: row.snapshot as IegpPlanRecord["snapshot"],
  }));
}

/** Saving as final freezes a snapshot; the plan the user stands behind is versioned. */
export async function savePlan(args: {
  status: "draft" | "final";
  note: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<IegpPlanRecord> {
  const note = requireRationale(args.note);
  const [model, state] = await Promise.all([timelineModel(), loadState()]);
  if (args.status === "final" && model.pending.length > 0) {
    throw new Error(
      `${model.pending.length} activity(ies) have no schedule yet (${model.pending
        .map((row) => row.tactic_name)
        .join(", ")}). Rebuild the timeline before saving it as final.`,
    );
  }
  const previous = await latestPlan();
  const version = (previous?.version ?? 0) + 1;
  const snapshot: IegpPlanRecord["snapshot"] = {
    activities: model.activities,
    window: model.window,
    lanes: model.lanes,
    unscheduled: model.unscheduled,
    pending: model.pending,
    counts: {
      gaps: state.gaps.filter((gap) => !gap.retired).length,
      tactics: state.tactics.length,
      open: model.lanes.filter((lane) => lane.id !== "addressed").reduce((sum, lane) => sum + lane.count, 0),
      addressed: model.lanes.find((lane) => lane.id === "addressed")?.count ?? 0,
    },
  };
  const record = {
    id: newId("plan"),
    version,
    status: args.status,
    snapshot,
    note,
    saved_by: args.actor.name,
    saved_function: args.actor.function,
    saved_at: nowIso(),
  };
  await db().insert(t.iegpPlans).values(record);
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "iegp_plan",
    entity_id: record.id,
    field: "status",
    action: "validate",
    before: previous ? `v${previous.version} ${previous.status}` : "none",
    after: `v${version} ${args.status}`,
    rationale: note,
    actor: args.actor,
  });
  return {
    id: record.id,
    version,
    status: args.status,
    note: record.note,
    saved_by: record.saved_by,
    saved_at: record.saved_at,
    snapshot,
  };
}
