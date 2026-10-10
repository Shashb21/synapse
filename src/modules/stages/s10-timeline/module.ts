import { expansionScopeSchema } from "@/lib/iegp/tactic-expansions";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { enteredAssetDetails } from "@/lib/iegp/asset";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import { createProposedTactic, loadState } from "@/lib/iegp/store";
import type { IegpState, Tactic } from "@/lib/iegp/types";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import {
  acceptedDependencies,
  activityId,
  buildTimeline,
  estimatedFields,
  inputsKey,
  missingSchedule,
  savedProposals,
  TIMELINE_LANES,
  timelineCandidates,
  type TimelineBand,
  type ActivityDesign,
  type DependencyAnswer,
  type SavedActivity,
  type ScheduleEstimate,
  type ScheduleField,
  type TimelineActivity,
  type TimelineCandidate,
  type TimelineModel,
} from "./build";
import { plural } from "@/lib/plural";
import { finalSaveRefusal, planIssues } from "./plan-checks";
import { fingerprintCode, planFingerprint } from "./plan-fingerprint";
import { currentSchemaName, withWorkspaceTransaction } from "@/lib/iegp/db";
import { loadAxes } from "@/modules/stages/s8-prioritization/axes";
import {
  buildFinalPackage,
  FINAL_PACKAGE_SCHEMA,
  finalPackageBlockers,
  findGapOrphans,
  foreignReferences,
  packageFingerprint,
  packageRefusal,
  type FinalPackage,
  type PackageBlocker,
} from "./final-package";

const inputSchema = z.object({
  /** What the model's start offsets count from. Defaults to today. */
  anchor: z.string().optional(),
  persist: z.boolean().default(true),
});

const sourceSchema = z.enum(["human", "saved", "tactic", "design", "model"]);

const activitySchema = z.object({
  id: z.string(),
  tactic_id: z.string(),
  expansion_id: z.string().optional(),
  parent_activity_id: z.string().optional(),
  parent_tactic_name: z.string().optional(),
  expansion_version: z.string().optional(),
  expansion_scope: expansionScopeSchema.optional(),
  tactic_name: z.string(),
  tactic_type: z.string(),
  tactic_custom_type: z.object({ label: z.string(), color: z.string() }).nullable().optional(),
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
    depends_locked: z.boolean(),
    rationale_locked: z.boolean(),
    manual: z.boolean(),
    objective: z.string().optional(),
    outputs: z.string().optional(),
    inclusion: z.enum(["committed", "completed", "proposed"]).optional(),
    proposed_dependencies: z.array(z.object({ id: z.string(), reason: z.string() })).optional(),
    rejected_dependencies: z.array(z.string()).optional(),
    inputs_key: z.string().optional(),
    estimate_stale: z.boolean().optional(),
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
      expansion_id: z.string().optional(),
      parent_activity_id: z.string().optional(),
      parent_tactic_name: z.string().optional(),
      expansion_version: z.string().optional(),
      expansion_scope: expansionScopeSchema.optional(),
      tactic_name: z.string(),
      missing: z.array(z.enum(["start", "duration", "readout_lag"])),
      reason: z.string(),
    }),
  ),
  removed: z.array(
    z.object({ activity_id: z.string(), tactic_id: z.string(), expansion_id: z.string().optional(), parent_activity_id: z.string().optional(), parent_tactic_name: z.string().optional(), tactic_name: z.string(), reason: z.string() }),
  ),
  cancelled: z.array(z.object({ tactic_id: z.string(), tactic_name: z.string() })).default([]),
  problems: z
    .array(z.object({ kind: z.enum(["cycle", "dangling"]), activity_id: z.string(), upstream_id: z.string(), message: z.string() }))
    .default([]),
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
    designs.set(proposal.expansion_id ? activityId(proposal.tactic_id, proposal.expansion_id) : proposal.tactic_id, {
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

const REMEDY = "rebuild the timeline or switch the S10 route in /admin/control.";

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
    // Only what setup has entered: a blank plan sends no asset rather than empty strings.
    asset: enteredAssetDetails(state.asset),
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
    version: "2.2.0",
    title: "Interactive Gantt timeline",
    summary:
      "Lays out the final IEGP as dated activities. Dates a user set and durations the tactic's design carries are kept; a model infers the dependencies between activities and estimates any start, duration or readout lag nobody supplied. Only validated bands place an activity. A user can date, add, remove, re-lane and re-sequence any activity by hand; those values are marked human and survive every rebuild. Needs a connected LLM only while something is left for it to estimate.",
    contract: 1,
    agentic: true,
    // With AI off it still lays out every human or designed date; the rest wait
    // in "Not dated yet" for a person.
    ai_optional: true,
    capabilities: ["gantt", "llm-dependencies", "llm-schedule", "save-final", "image-export"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
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

    // Dependencies a person set or accepted are theirs: seeded into the graph so
    // the model's proposals cannot close a loop through them (KAN-85).
    const graph = new Map<string, string[]>();
    const accepted = new Map<string, DependencyAnswer>();
    for (const candidate of candidates) {
      const saved = candidate.saved;
      const upstream = acceptedDependencies(saved).filter((id) => id !== candidate.id && byId.has(id));
      if (upstream.length === 0) continue;
      graph.set(candidate.id, upstream);
      accepted.set(candidate.id, {
        upstream: upstream.map((id) => ({ id, reason: saved?.meta?.dependency_reasons?.[id] ?? "Set by hand." })),
      });
    }
    // The model is asked only about activities that are new or whose inputs
    // changed since it was last asked, and never about ones a person set by hand.
    const askFor = candidates
      .filter(
        (candidate) =>
          candidate.saved?.meta?.depends_locked !== true &&
          (!candidate.saved || candidate.saved.meta?.inputs_key !== inputsKey(candidate)),
      )
      .map((candidate) => candidate.id);
    const targets = candidates.filter((candidate) => missingSchedule(candidate).length > 0);

    // A lone activity has nothing to wait on, so there is nothing to ask. When
    // every date and dependency is already a human's (or a design's), the
    // rebuild needs no model at all.
    const needsDependencies = candidates.length >= 2 && askFor.length > 0;
    const ai = ctx.ai !== false;
    if (ai && (needsDependencies || targets.length > 0)) requireLlm(ctx, "The timeline");

    // With AI off nothing is asked, so every saved dependency and proposal stays
    // as it is. Test stub only: no model runs, so nothing is proposed.
    const asked: Map<string, DependencyAnswer> = !ai
      ? new Map()
      : isTestStub() || !needsDependencies
        ? new Map(askFor.map((id) => [id, { upstream: [] }]))
        : await ctx.run.step("dependencies", () =>
            completeAll({
              ids: askFor,
              what: "dependency list",
              describe,
              remedy: REMEDY,
              ask: (missing, attempt) =>
                llmDependencies(ctx, { state, anchor, candidates, missing, graph, retry: attempt > 1 }),
            }),
          );
    // What the estimate prompt is told each activity waits on: accepted, else proposed.
    const dependencies = new Map<string, DependencyAnswer>([...asked, ...accepted]);

    let estimates = new Map<string, ScheduleEstimate>();
    if (!ai) {
      // AI is off: nothing is estimated. Undated activities stay pending.
    } else if (targets.length > 0 && isTestStub()) {
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

    const model = buildTimeline({ state, placements, designs, overrides, estimates, dependencies: asked, anchor });
    // With AI off, undated activities simply wait for a person; the dated ones are saved.
    if (ai && model.pending.length > 0) {
      throw new Error(
        `The timeline could not date ${model.pending.map((row) => row.tactic_name).join(", ")}. Nothing was saved; ${REMEDY}`,
      );
    }
    if (input.persist) {
      for (const activity of model.activities) {
        // A user's per-dependency reasons live only on the row; keep them.
        const saved = byId.get(activity.id)?.saved;
        const reasons = saved?.meta?.dependency_reasons;
        const values = {
          id: activity.id,
          tactic_id: activity.tactic_id,
          gap_ids: activity.gap_ids,
          lane: activity.lane,
          start_date: activity.start_date,
          end_date: activity.end_date,
          readout_date: activity.readout_date,
          // Accepted and hand-set dependencies are stored as they were, even one
          // whose upstream is off the timeline for now. A model's are proposals (meta).
          depends_on: saved ? acceptedDependencies(saved) : activity.depends_on,
          band: activity.band,
          meta: reasons ? { ...activity.meta, dependency_reasons: reasons } : activity.meta,
          updated_by: ctx.actor.name,
          updated_at: nowIso(),
        };
        await db()
          .insert(t.timelineActivities)
          .values(values)
          .onConflictDoUpdate({
            target: t.timelineActivities.id,
            // A saved row's dates survive a rebuild; derived fields refresh. The
            // lane follows the validated band unless a user moved it by hand,
            // and dependencies a user set (depends_locked) come back unchanged.
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
      asked_dependencies: asked.size,
      proposed_dependencies: model.activities.reduce((sum, row) => sum + row.meta.proposed_dependencies.length, 0),
      problems: model.problems.length,
    });
    return {
      output: model,
      summary: `${plural(model.activities.length, "activity", "activities")} across ${plural(model.window.months, "month")}; ${estimates.size} dated by the model; ${plural(model.unscheduled.length, "open gap")} unscheduled`,
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

type ActivityRow = typeof t.timelineActivities.$inferSelect;
type RowMeta = NonNullable<SavedActivity["meta"]> & Record<string, unknown>;

async function activityRow(id: string): Promise<ActivityRow | undefined> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.timelineActivities).where(eq(t.timelineActivities.id, id)).limit(1);
  return rows[0];
}

const rowMeta = (row: ActivityRow): RowMeta => ({ ...((row.meta as RowMeta | null) ?? {}) });

const asSaved = (row: ActivityRow): SavedActivity => ({
  id: row.id,
  start_date: row.start_date,
  end_date: row.end_date,
  readout_date: row.readout_date,
  lane: row.lane,
  depends_on: (row.depends_on as string[] | null) ?? [],
  meta: (row.meta as SavedActivity["meta"]) ?? null,
});

/** A row a user took off the timeline cannot be edited until it is added back. */
function assertOnTimeline(row: ActivityRow | undefined, id: string): ActivityRow {
  if (!row) throw new Error(`Unknown activity ${id}. Date it by hand or rebuild the timeline first.`);
  if (rowMeta(row).removed === true) throw new Error(`${id} was removed from the timeline. Add it back first.`);
  return row;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Moves an ISO day by the gap between two other ISO days, so a readout keeps its offset from the start. */
function shiftBy(iso: string, from: string, to: string): string {
  const delta = Date.parse(to) - Date.parse(from);
  return new Date(Date.parse(iso) + Math.round(delta / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** Dates are ISO days; the end is not before the start, and a readout is not before the start. */
function assertWindow(start: string, end: string, readout?: string | null) {
  for (const [label, value] of [["start", start], ["end", end], ["readout", readout]] as const) {
    if (value && (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value)))) {
      throw new Error(`The ${label} date is not a valid date (use YYYY-MM-DD).`);
    }
  }
  if (end < start) throw new Error("An activity cannot end before it starts.");
  if (readout && readout < start) throw new Error("The readout cannot be before the activity starts.");
}

/**
 * A user moving an activity is an edit, so it needs a rationale like any other.
 * Every value they set is marked human and survives every rebuild: dates
 * (schedule_basis "human"), the lane (lane_locked; "band" hands it back to the
 * validated band) and the schedule rationale (rationale_locked).
 */
export async function updateTimelineActivity(args: {
  id: string;
  start_date?: string;
  end_date?: string;
  readout_date?: string | null;
  /** A lane, or "band" to let the validated band place it again. */
  lane?: string;
  /** The "why these dates" text shown on the activity; empty clears it. */
  schedule_rationale?: string | null;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  const rationale = requireRationale(args.rationale);
  if (args.lane && args.lane !== "band" && !TIMELINE_LANES.includes(args.lane as TimelineBand)) {
    throw new Error(`Unknown lane ${args.lane}.`);
  }
  const current = assertOnTimeline(await activityRow(args.id), args.id);
  const meta = rowMeta(current);
  const releaseLane = args.lane === "band";
  const start_date = args.start_date ?? current.start_date;
  // A readout the user did not touch moves with the start (a dragged bar keeps it in step).
  const readoutUntouched = args.readout_date === undefined;
  const readout_date = readoutUntouched
    ? current.readout_date && ISO_DATE.test(start_date) && start_date !== current.start_date
      ? shiftBy(current.readout_date, current.start_date, start_date)
      : current.readout_date
    : args.readout_date;
  const next = {
    start_date,
    end_date: args.end_date ?? current.end_date,
    readout_date,
    lane: args.lane && !releaseLane ? args.lane : releaseLane ? (current.band ?? current.lane) : current.lane,
    updated_by: args.actor.name,
    updated_at: nowIso(),
  };
  assertWindow(next.start_date, next.end_date, readoutUntouched ? null : next.readout_date);
  const basis = (meta.schedule_basis as TimelineActivity["meta"]["schedule_basis"] | undefined) ?? {
    start: "saved",
    end: "saved",
    readout: current.readout_date ? "saved" : null,
  };
  // Only a value the user actually changed becomes theirs; the dialog resends
  // unchanged dates when only the lane or rationale was edited.
  const startChanged = next.start_date !== current.start_date;
  const endChanged = next.end_date !== current.end_date;
  const readoutChanged = next.readout_date !== current.readout_date;
  meta.schedule_basis = {
    start: startChanged ? "human" : basis.start,
    end: endChanged ? "human" : basis.end,
    readout: !next.readout_date ? null : readoutChanged ? "human" : (basis.readout ?? "saved"),
  };
  if (args.lane) meta.lane_locked = !releaseLane;
  // A date a person set is no longer an estimate; once none is left, nothing is stale.
  if (estimatedFields(meta.schedule_basis as TimelineActivity["meta"]["schedule_basis"]).length === 0) {
    meta.estimate_stale = false;
  }
  const rationaleChanged =
    args.schedule_rationale !== undefined &&
    (args.schedule_rationale?.trim() || null) !== ((meta.schedule_rationale as string | null | undefined) ?? null);
  if (rationaleChanged) {
    meta.schedule_rationale = args.schedule_rationale?.trim() || null;
    meta.rationale_locked = true;
  }
  await db()
    .update(t.timelineActivities)
    .set({ ...next, meta })
    .where(eq(t.timelineActivities.id, args.id));

  const datesTouched = startChanged || endChanged || readoutChanged;
  const edit = (field: string, before: string | null, after: string | null) =>
    recordEdit({
      workspace_id: args.workspace_id,
      stage: "S10",
      entity_type: "timeline_activity",
      entity_id: args.id,
      field,
      action: "edit",
      before,
      after,
      rationale,
      actor: args.actor,
    });
  if (datesTouched || (!args.lane && !rationaleChanged)) {
    await edit(
      "schedule",
      `${current.start_date} → ${current.end_date} (readout ${current.readout_date ?? "—"})`,
      `${next.start_date} → ${next.end_date} (readout ${next.readout_date ?? "—"})`,
    );
  }
  if (args.lane) await edit("lane", current.lane, releaseLane ? `${next.lane} (follows band)` : next.lane);
  if (rationaleChanged) {
    await edit(
      "schedule_rationale",
      ((current.meta as RowMeta | null)?.schedule_rationale as string | null | undefined) ?? null,
      (meta.schedule_rationale as string | null) ?? null,
    );
  }
  return { ...next, meta };
}

/**
 * A user sets (or clears) what an activity waits on. The list is theirs: it is
 * marked depends_locked, rebuilds keep it as written and never ask the model
 * for it. Every upstream must be a dated activity; self-references and cycles
 * are refused.
 */
export async function setTimelineDependencies(args: {
  id: string;
  depends_on: string[];
  /** Optional reason per upstream id. */
  reasons?: Record<string, string>;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  const rationale = requireRationale(args.rationale);
  const current = assertOnTimeline(await activityRow(args.id), args.id);
  const model = await timelineModel();
  const byId = new Map(model.activities.map((activity) => [activity.id, activity]));
  const upstream = [...new Set(args.depends_on.map((id) => id.trim()).filter(Boolean))];
  for (const id of upstream) {
    if (id === args.id) throw new Error("An activity cannot depend on itself.");
    if (!byId.has(id)) throw new Error(`Unknown activity ${id}: an activity can only wait on a dated activity.`);
  }
  const graph = new Map(model.activities.map((activity) => [activity.id, activity.depends_on]));
  graph.delete(args.id);
  if (wouldCycle(graph, args.id, upstream)) {
    throw new Error("That dependency would create a cycle: an upstream activity already waits on this one.");
  }
  const reasons: Record<string, string> = {};
  for (const id of upstream) {
    const reason = args.reasons?.[id]?.trim();
    if (reason) reasons[id] = reason;
  }
  const meta = rowMeta(current);
  const pendingProposals = savedProposals(asSaved(current)).filter((row) => !upstream.includes(row.id));
  meta.proposed_dependencies = pendingProposals;
  meta.depends_locked = true;
  meta.dependency_reasons = reasons;
  meta.dependency_note =
    Object.keys(reasons).length > 0
      ? upstream
          .filter((id) => reasons[id])
          .map((id) => `${byId.get(id)?.tactic_name ?? id}: ${reasons[id]}`)
          .join(" ")
      : null;
  const before = (current.depends_on as string[] | null) ?? [];
  await db()
    .update(t.timelineActivities)
    .set({ depends_on: upstream, meta, updated_by: args.actor.name, updated_at: nowIso() })
    .where(eq(t.timelineActivities.id, args.id));
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "timeline_activity",
    entity_id: args.id,
    field: "depends_on",
    action: "edit",
    before: before.join(", ") || "none",
    after: upstream.join(", ") || "none",
    rationale,
    actor: args.actor,
  });
  return { id: args.id, depends_on: upstream, meta };
}

/**
 * A user dates an activity by hand, with no model: a pending (undated) one, a
 * tactic not mapped to any gap, or one they removed earlier and now add back.
 * Every date they enter is marked human.
 */
export async function addTimelineActivity(args: {
  tactic_id: string;
  expansion_id?: string;
  activity_id?: string;
  start_date?: string;
  end_date?: string;
  readout_date?: string | null;
  lane?: string;
  schedule_rationale?: string | null;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  const rationale = requireRationale(args.rationale);
  if (args.lane && !TIMELINE_LANES.includes(args.lane as TimelineBand)) throw new Error(`Unknown lane ${args.lane}.`);
  const [state, placements, overrides] = await Promise.all([loadState(), listPlacements(), storedActivities()]);
  const selectedExpansion = args.activity_id ? state.expansions.find(child => activityId(child.tactic_id, child.id) === args.activity_id) : undefined;
  const selectedTactic = args.activity_id ? state.tactics.find(row => activityId(row.id) === args.activity_id) : undefined;
  if (args.activity_id && !selectedExpansion && !selectedTactic) throw new Error("Unknown timeline activity.");
  const tacticId = selectedExpansion?.tactic_id ?? selectedTactic?.id ?? args.tactic_id;
  if (args.tactic_id && args.tactic_id !== tacticId) throw new Error("Activity does not belong to this tactic.");
  const tactic = state.tactics.find((row) => row.id === tacticId);
  if (!tactic) throw new Error(`Unknown tactic ${args.tactic_id}.`);
  const expansion = selectedExpansion ?? (args.expansion_id ? state.expansions.find(child => child.id === args.expansion_id && child.tactic_id === tactic.id) : undefined);
  if (args.expansion_id && expansion?.id !== args.expansion_id) throw new Error("Activity does not match this expansion.");
  if (args.expansion_id && !expansion) throw new Error("Expansion not found under this tactic.");
  if ((expansion?.status ?? tactic.status) === "cancelled" || (!expansion && tactic.review_status === "rejected")) {
    throw new Error(`${tactic.name} is cancelled or rejected, so it cannot go on the timeline.`);
  }
  const id = activityId(tactic.id, expansion?.id);
  const existing = await activityRow(id);
  const restoring = existing && rowMeta(existing).removed === true;
  if (existing && !restoring) {
    throw new Error(`${tactic.name} is already on the timeline. Reschedule it instead.`);
  }
  const start = args.start_date ?? (restoring && existing.start_date ? existing.start_date : undefined);
  const end = args.end_date ?? (restoring && existing.end_date ? existing.end_date : undefined);
  if (!start || !end) throw new Error("A start and an end date are required.");
  const readout =
    args.readout_date !== undefined ? args.readout_date : restoring ? (existing.readout_date ?? null) : null;
  assertWindow(start, end, readout);

  // Mapped tactics keep their gaps and band; an unmapped one is a manual activity.
  const others = overrides.filter((row) => row.id !== id);
  const candidate = timelineCandidates({ state, placements, overrides: others }).find((row) => row.id === id);
  const band: TimelineBand = candidate?.band ?? "unprioritized";
  const previous = restoring ? rowMeta(existing) : ({} as RowMeta);
  const note = args.schedule_rationale?.trim() || null;
  const meta: RowMeta = {
    ...previous,
    removed: false,
    manual: !candidate,
    schedule_basis: {
      start: args.start_date || !restoring ? "human" : (previous.schedule_basis?.start ?? "human"),
      end: args.end_date || !restoring ? "human" : (previous.schedule_basis?.end ?? "human"),
      readout: readout
        ? args.readout_date || !restoring
          ? "human"
          : (previous.schedule_basis?.readout ?? "human")
        : null,
    },
    schedule_rationale: note ?? previous.schedule_rationale ?? null,
    rationale_locked: Boolean(note) || previous.rationale_locked === true,
    lane_locked: Boolean(args.lane) || previous.lane_locked === true,
  };
  delete meta.removed_reason;
  const values = {
    id,
    tactic_id: tactic.id,
    gap_ids: candidate?.gap_ids ?? [],
    lane: args.lane ?? (previous.lane_locked && existing ? existing.lane : band),
    start_date: start,
    end_date: end,
    readout_date: readout,
    depends_on: restoring ? ((existing.depends_on as string[]) ?? []) : [],
    band,
    meta,
    updated_by: args.actor.name,
    updated_at: nowIso(),
  };
  await db()
    .insert(t.timelineActivities)
    .values(values)
    .onConflictDoUpdate({ target: t.timelineActivities.id, set: values });
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "timeline_activity",
    entity_id: id,
    field: "schedule",
    action: "add",
    before: restoring ? "removed" : "not dated",
    after: `${start} → ${end} (readout ${readout ?? "—"})`,
    rationale,
    actor: args.actor,
  });
  return values;
}

/**
 * A user adds a new activity under a gap straight from the timeline (KAN-25):
 * a proposed tactic mapped to that gap, plus its dates when they give them.
 * With no dates it shows under the gap as "Unscheduled" until someone dates it.
 * No model is involved; the tactic and every date are the person's.
 */
export async function createTimelineActivity(args: {
  gap_id: string;
  name: string;
  type: string;
  evidence_question: string;
  start_date?: string;
  end_date?: string;
  readout_date?: string | null;
  schedule_rationale?: string | null;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  const rationale = requireRationale(args.rationale);
  if (!args.name.trim()) throw new Error("A name is required.");
  if (!args.evidence_question.trim()) throw new Error("An evidence question is required.");
  if (Boolean(args.start_date) !== Boolean(args.end_date)) {
    throw new Error("Give both a start and an end date, or neither to leave it unscheduled.");
  }
  if (args.start_date && args.end_date) assertWindow(args.start_date, args.end_date, args.readout_date);
  const state = await loadState();
  const gap = state.gaps.find((row) => row.id === args.gap_id);
  if (!gap) throw new Error(`Unknown gap ${args.gap_id}.`);
  const tacticId = await createProposedTactic({
    name: args.name.trim(),
    type: args.type as Tactic["type"],
    description: args.name.trim(),
    evidence_question: args.evidence_question.trim(),
    population: "",
    intervention: "",
    comparator: "",
    outcomes: "",
    owner: args.actor.name,
    function: args.actor.function,
    residual_ids: [],
    gap_id: gap.id,
    actor_name: args.actor.name,
    actor_function: args.actor.function,
  });
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "tactic",
    entity_id: tacticId,
    field: "created",
    action: "add",
    before: null,
    after: `${args.name.trim()} → ${gap.id}`,
    rationale,
    actor: args.actor,
  });
  if (!args.start_date || !args.end_date) {
    return { tactic_id: tacticId, activity_id: activityId(tacticId), scheduled: false };
  }
  await addTimelineActivity({
    tactic_id: tacticId,
    start_date: args.start_date,
    end_date: args.end_date,
    readout_date: args.readout_date ?? null,
    schedule_rationale: args.schedule_rationale ?? null,
    rationale,
    actor: args.actor,
    workspace_id: args.workspace_id,
  });
  return { tactic_id: tacticId, activity_id: activityId(tacticId), scheduled: true };
}

/**
 * A user takes an activity off the timeline. The row is kept, marked removed,
 * so no rebuild puts it back; adding it again restores it.
 */
export async function removeTimelineActivity(args: {
  id: string;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  const rationale = requireRationale(args.rationale);
  const existing = await activityRow(args.id);
  if (existing && rowMeta(existing).removed === true) throw new Error(`${args.id} is already off the timeline.`);
  if (!existing) {
    // A pending activity has no row yet: keep an undated one that says it was removed.
    const [state, placements, overrides] = await Promise.all([loadState(), listPlacements(), storedActivities()]);
    const candidate = timelineCandidates({ state, placements, overrides }).find((row) => row.id === args.id);
    if (!candidate) throw new Error(`Unknown activity ${args.id}.`);
    await db()
      .insert(t.timelineActivities)
      .values({
        id: args.id,
        tactic_id: candidate.tactic.id,
        gap_ids: candidate.gap_ids,
        lane: candidate.band,
        start_date: "",
        end_date: "",
        readout_date: null,
        depends_on: [],
        band: candidate.band,
        meta: { removed: true, removed_reason: rationale },
        updated_by: args.actor.name,
        updated_at: nowIso(),
      });
  } else {
    const meta = { ...rowMeta(existing), removed: true, removed_reason: rationale };
    await db()
      .update(t.timelineActivities)
      .set({ meta, updated_by: args.actor.name, updated_at: nowIso() })
      .where(eq(t.timelineActivities.id, args.id));
  }
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "timeline_activity",
    entity_id: args.id,
    field: "on_timeline",
    action: "edit",
    before: existing ? `${existing.start_date} → ${existing.end_date}` : "not dated",
    after: "removed",
    rationale,
    actor: args.actor,
  });
  return { id: args.id, removed: true };
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
    /** Absent on snapshots saved before activities could be removed by hand. */
    removed?: TimelineModel["removed"];
    /** Absent on snapshots saved before KAN-85. */
    cancelled?: TimelineModel["cancelled"];
    problems?: TimelineModel["problems"];
    /** planFingerprint of the frozen activities, and its short code stamped on exports (KAN-85). */
    fingerprint?: string;
    fingerprint_code?: string;
    counts: { gaps: number; tactics: number; open: number; addressed: number };
    /**
     * The complete frozen IEGP (KAN-86): gap inventory, tactics, priority,
     * roadmap, open items and lineage. Absent on drafts and on finals saved
     * before KAN-86, which are read as legacy timeline-only packages.
     */
    package?: FinalPackage;
    /** sha256 of the canonical package JSON. */
    package_fingerprint?: string;
    schema_version?: typeof FINAL_PACKAGE_SCHEMA;
  };
};

function toPlanRecord(row: typeof t.iegpPlans.$inferSelect): IegpPlanRecord {
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

/** One saved version, read only from what was frozen; null when there is none. */
export async function planVersion(version: number): Promise<IegpPlanRecord | null> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.iegpPlans).where(eq(t.iegpPlans.version, version)).limit(1);
  return rows[0] ? toPlanRecord(rows[0]) : null;
}

export async function latestPlan(): Promise<IegpPlanRecord | null> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.iegpPlans).orderBy(desc(t.iegpPlans.version)).limit(1);
  return rows[0] ? toPlanRecord(rows[0]) : null;
}

export async function planHistory(limit = 20): Promise<IegpPlanRecord[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.iegpPlans).orderBy(desc(t.iegpPlans.version)).limit(limit);
  return rows.map(toPlanRecord);
}

/**
 * What a complete final waits on in the gap inventory (KAN-86): candidates,
 * Partially Addressed or unconfirmed gaps, Open gaps without a validated band,
 * orphans and outside references. The roadmap's own checks are planIssues.
 */
export async function finalPlanBlockers(): Promise<PackageBlocker[]> {
  const [model, state, placements] = await Promise.all([timelineModel(), loadState(), listPlacements()]);
  return [
    ...finalPackageBlockers({ state, placements, orphans: await findGapOrphans(state) }),
    ...foreignReferences(state, model),
  ];
}

/** Saving as final freezes a snapshot; the plan the user stands behind is versioned. */
export async function savePlan(args: {
  status: "draft" | "final";
  note: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<IegpPlanRecord> {
  const note = requireRationale(args.note);
  // One transaction: the package is read from one revision of the workspace, the
  // version is allocated under a lock (two saves never share a number), and a
  // failure part-way writes nothing.
  return withWorkspaceTransaction(async () => {
    const schema = await currentSchemaName();
    await db().execute(sql`select pg_advisory_xact_lock(hashtext(${`iegp_plans:${schema}`}))`);
    const [model, state] = await Promise.all([timelineModel(), loadState()]);
    if (args.status === "final" && model.activities.length === 0) {
      throw new Error("There is nothing to save as final yet: date at least one activity on the timeline first.");
    }
    if (args.status === "final" && model.pending.length > 0) {
      throw new Error(
        `${model.pending.length === 1 ? "1 activity has" : `${model.pending.length} activities have`} no schedule yet (${model.pending
          .map((row) => row.tactic_name)
          .join(", ")}). Date each one with Set dates on the timeline (choose Show deferred gaps if it sits under a deferred gap), or remove it, then save the plan as final.`,
      );
    }
    // Conflicts, loops, missing references, invalid dates, unreviewed estimates and
    // proposed dependencies are explained and must be resolved first (KAN-85).
    const issues = planIssues(model).filter((issue) => issue.kind !== "pending");
    if (args.status === "final" && issues.length > 0) throw new Error(finalSaveRefusal(issues));
    const fingerprint = planFingerprint(model.activities);
    const fingerprint_code = fingerprintCode(fingerprint);
    let finalPackage: FinalPackage | undefined;
    let package_fingerprint: string | undefined;
    if (args.status === "final") {
      // The complete IEGP (KAN-86): every gap confirmed and resolved, every Open
      // gap banded, nothing pointing at a retired gap or outside the workspace.
      const placements = await listPlacements();
      const blockers = [
        ...finalPackageBlockers({ state, placements, orphans: await findGapOrphans(state) }),
        ...foreignReferences(state, model),
      ];
      if (blockers.length > 0) throw new Error(packageRefusal(blockers));
      finalPackage = await buildFinalPackage({
        state,
        model,
        placements,
        axes: await loadAxes(),
        workspace_id: args.workspace_id ?? null,
        fingerprint,
        fingerprint_code,
        built_at: nowIso(),
      });
      package_fingerprint = packageFingerprint(finalPackage);
    }
    const [{ max }] = (await db().execute(sql`select coalesce(max(version), 0)::int as max from iegp_plans`)) as unknown as { max: number }[];
    const previous = max > 0 ? await planVersion(max) : null;
    const version = max + 1;
    const snapshot: IegpPlanRecord["snapshot"] = {
      activities: model.activities,
      window: model.window,
      lanes: model.lanes,
      unscheduled: model.unscheduled,
      pending: model.pending,
      removed: model.removed,
      cancelled: model.cancelled,
      problems: model.problems,
      fingerprint,
      fingerprint_code,
      counts: {
        gaps: state.gaps.filter((gap) => !gap.retired).length,
        tactics: state.tactics.length,
        open: model.lanes.filter((lane) => lane.id !== "addressed").reduce((sum, lane) => sum + lane.count, 0),
        addressed: model.lanes.find((lane) => lane.id === "addressed")?.count ?? 0,
      },
      ...(finalPackage ? { package: finalPackage, package_fingerprint, schema_version: FINAL_PACKAGE_SCHEMA } : {}),
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
      after: package_fingerprint
        ? `v${version} final · complete package ${FINAL_PACKAGE_SCHEMA} · fingerprint ${package_fingerprint}`
        : `v${version} ${args.status}`,
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
  });
}

/**
 * A person reviews one dependency a model proposed (KAN-85). Accepting makes it
 * theirs (it now gates the schedule and the dependencies are depends_locked, so
 * no rebuild asks the model again); rejecting keeps it off for good.
 */
export async function reviewTimelineDependency(args: {
  id: string;
  upstream_id: string;
  decision: "accept" | "reject";
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  const rationale = requireRationale(args.rationale);
  const current = assertOnTimeline(await activityRow(args.id), args.id);
  const saved = asSaved(current);
  const proposals = savedProposals(saved);
  const proposal = proposals.find((row) => row.id === args.upstream_id);
  if (!proposal) throw new Error(`There is no proposed dependency of ${args.id} on ${args.upstream_id} to review.`);
  const meta = rowMeta(current);
  const before = acceptedDependencies(saved);
  let dependsOn = before;
  if (args.decision === "accept") {
    const model = await timelineModel();
    if (!model.activities.some((row) => row.id === args.upstream_id)) {
      throw new Error(`${args.upstream_id} has no dates on the timeline, so nothing can wait on it yet.`);
    }
    const graph = new Map(model.activities.map((activity) => [activity.id, activity.depends_on]));
    graph.delete(args.id);
    dependsOn = [...new Set([...before, args.upstream_id])];
    if (wouldCycle(graph, args.id, dependsOn)) {
      throw new Error("Accepting that dependency would create a cycle: the other activity already waits on this one.");
    }
    meta.depends_locked = true;
    meta.dependency_reasons = { ...((meta.dependency_reasons as Record<string, string> | undefined) ?? {}), [args.upstream_id]: proposal.reason };
  } else {
    meta.rejected_dependencies = [...new Set([...((meta.rejected_dependencies as string[] | undefined) ?? []), args.upstream_id])];
  }
  meta.proposed_dependencies = proposals.filter((row) => row.id !== args.upstream_id);
  await db()
    .update(t.timelineActivities)
    .set({ depends_on: dependsOn, meta, updated_by: args.actor.name, updated_at: nowIso() })
    .where(eq(t.timelineActivities.id, args.id));
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "timeline_activity",
    entity_id: args.id,
    field: "proposed_dependency",
    action: args.decision,
    before: `proposed: waits on ${args.upstream_id} (${proposal.reason})`,
    after: args.decision === "accept" ? `waits on ${dependsOn.join(", ")}` : `rejected: ${args.upstream_id}`,
    rationale,
    actor: args.actor,
  });
  return { id: args.id, depends_on: dependsOn, meta };
}

/**
 * A person accepts a model's date estimates as theirs (KAN-85): the dates stay,
 * their source becomes human, and the activity is no longer flagged as an
 * estimate. With no ids, every activity that still carries an estimate.
 */
export async function acceptTimelineEstimates(args: {
  ids?: string[];
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}) {
  const rationale = requireRationale(args.rationale);
  await ensurePlatformSchema();
  const rows = await db().select().from(t.timelineActivities);
  const wanted = args.ids && args.ids.length > 0 ? new Set(args.ids) : null;
  const accepted: string[] = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.id)) continue;
    const meta = rowMeta(row);
    if (meta.removed === true) continue;
    const basis = meta.schedule_basis as TimelineActivity["meta"]["schedule_basis"] | undefined;
    const fields = estimatedFields(basis);
    if (!basis || fields.length === 0) continue;
    meta.schedule_basis = {
      start: basis.start === "model" ? "human" : basis.start,
      end: basis.end === "model" ? "human" : basis.end,
      readout: basis.readout === "model" ? "human" : basis.readout,
    };
    meta.estimate_stale = false;
    await db()
      .update(t.timelineActivities)
      .set({ meta, updated_by: args.actor.name, updated_at: nowIso() })
      .where(eq(t.timelineActivities.id, row.id));
    await recordEdit({
      workspace_id: args.workspace_id,
      stage: "S10",
      entity_type: "timeline_activity",
      entity_id: row.id,
      field: "schedule_basis",
      action: "accept",
      before: `model estimate (${fields.join(", ")}): ${row.start_date} → ${row.end_date} (readout ${row.readout_date ?? "—"})`,
      after: "accepted as set by hand",
      rationale,
      actor: args.actor,
    });
    accepted.push(row.id);
  }
  if (wanted && accepted.length === 0) throw new Error("None of those activities carries a model estimate to accept.");
  return { accepted };
}
