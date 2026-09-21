import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { recordEdit } from "@/modules/kernel/edit-records";
import type { Actor, SynapseModule } from "@/modules/kernel/contracts";
import { loadState } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { buildTimeline, type TimelineActivity, type TimelineModel } from "./build";

const inputSchema = z.object({
  /** Anchor for synthesised dates. Defaults to today. */
  anchor: z.string().optional(),
  persist: z.boolean().default(true),
});

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
  }),
});

const outputSchema = z.object({
  activities: z.array(activitySchema),
  window: z.object({ start: z.string(), end: z.string(), months: z.number() }),
  lanes: z.array(z.object({ id: z.string(), label: z.string(), count: z.number() })),
  unscheduled: z.array(z.object({ gap_id: z.string(), gap_name: z.string(), reason: z.string() })),
});

export type TimelineInput = z.infer<typeof inputSchema>;
export type TimelineOutput = z.infer<typeof outputSchema>;

async function storedActivities() {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.timelineActivities);
  return rows.map((row) => ({
    id: row.id,
    start_date: row.start_date,
    end_date: row.end_date,
    readout_date: row.readout_date,
    lane: row.lane,
    depends_on: (row.depends_on as string[]) ?? [],
  }));
}

export async function timelineModel(anchor?: string): Promise<TimelineModel> {
  const [state, placements, overrides] = await Promise.all([
    loadState(),
    listPlacements(),
    storedActivities(),
  ]);
  return buildTimeline({ state, placements, overrides, anchor });
}

export const timelineModule: SynapseModule<TimelineInput, TimelineOutput> = {
  manifest: {
    id: "s10-timeline.gantt",
    stage: "S10",
    version: "1.0.0",
    title: "Interactive Gantt timeline",
    summary:
      "Builds the final IEGP as dated activities with gap, tactic and readout interdependencies, ready to save as final and export.",
    contract: 1,
    agentic: false,
    capabilities: ["gantt", "dependencies", "save-final", "image-export"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
    const model = await timelineModel(input.anchor);
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
            // A user's dates survive a rebuild; derived fields refresh.
            set: {
              tactic_id: values.tactic_id,
              gap_ids: values.gap_ids,
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
    });
    return {
      output: model,
      summary: `${model.activities.length} activity(ies) across ${model.window.months} month(s); ${model.unscheduled.length} open gap(s) unscheduled`,
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
  await db().update(t.timelineActivities).set(next).where(eq(t.timelineActivities.id, args.id));
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S10",
    entity_type: "timeline_activity",
    entity_id: args.id,
    field: "schedule",
    action: "edit",
    before: `${current.start_date} → ${current.end_date} (readout ${current.readout_date ?? "—"})`,
    after: `${next.start_date} → ${next.end_date} (readout ${next.readout_date ?? "—"})`,
    rationale: args.rationale,
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
  const [model, state] = await Promise.all([timelineModel(), loadState()]);
  const previous = await latestPlan();
  const version = (previous?.version ?? 0) + 1;
  const snapshot: IegpPlanRecord["snapshot"] = {
    activities: model.activities,
    window: model.window,
    lanes: model.lanes,
    unscheduled: model.unscheduled,
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
    note: args.note.trim() || null,
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
    rationale: args.note,
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
