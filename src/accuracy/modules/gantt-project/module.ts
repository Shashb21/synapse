import { z } from "zod";
import { mechanicalModule } from "../_factory";
import { assertActivitiesHaveTacticId, projectGanttFromTactics } from "./engine";

const tacticSchema = z.object({
  id: z.string().min(1),
  validated: z.boolean(),
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  readout: z.string().nullable().optional(),
  depends_on: z.array(z.string()).optional(),
  tactic_type: z.string().nullable().optional(),
  gap_ids: z.array(z.string()).optional(),
  dates_locked: z.boolean().optional(),
});

const activityOverrideSchema = z.object({
  id: z.string().optional(),
  tactic_id: z.string().min(1, "activity tactic_id is required"),
  start: z.string().optional(),
  end: z.string().optional(),
  readout: z.string().nullable().optional(),
  depends_on: z.array(z.string()).optional(),
});

const coverageJoinSchema = z.object({
  gap_id: z.string().min(1),
  tactic_id: z.string().min(1),
  overall: z.string(),
  validated: z.boolean(),
});

const gapSchema = z.object({
  id: z.string().min(1),
  parent_gap_id: z.string().nullable().optional(),
  validated: z.boolean().optional(),
});

const inputSchema = z.object({
  workspace_id: z.string(),
  tactics: z.array(tacticSchema),
  activities: z.array(activityOverrideSchema).optional(),
  coverages: z.array(coverageJoinSchema).optional(),
  gaps: z.array(gapSchema).optional(),
});

const outputSchema = z.object({
  workspace_id: z.string(),
  activities: z.array(
    z.object({
      id: z.string(),
      tactic_id: z.string(),
      start: z.string(),
      end: z.string(),
      readout: z.string().nullable(),
      depends_on: z.array(z.string()),
      gap_ids: z.array(z.string()),
    }),
  ),
});

export const ganttProjectModule = mechanicalModule({
  id: "gantt-project.engine-v1",
  call_kind: "gantt_project",
  title: "Gantt projection",
  summary: "Deterministic timeline from validated tactics, coverage joins, and sourced dates — no invented bars.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    if (input.activities?.length) {
      assertActivitiesHaveTacticId(input.activities);
    }

    const activities = projectGanttFromTactics({
      tactics: input.tactics,
      activities: input.activities,
      coverages: input.coverages,
      gaps: input.gaps,
    });

    const tacticIds = new Set(input.tactics.map((t) => t.id));
    const invented = activities.filter((a) => !tacticIds.has(a.tactic_id));
    if (invented.length > 0) {
      throw new Error("Gantt projection produced bars without a validated tactic binding");
    }

    ctx.run.note("gantt:projected", { count: activities.length });
    return {
      output: { workspace_id: input.workspace_id, activities },
      summary: `${activities.length} activity(ies) from validated tactics`,
    };
  },
});

export {
  projectGanttFromTactics,
  activityIdForTactic,
  assertSaveFinalActivities,
  dependenciesRespectReadouts,
  activityGateDate,
  coverageCountsTowardGantt,
} from "./engine";
export { projectWorkspaceGantt, saveFinalGanttPlan, workspaceLatestPlan } from "./save-final";
export {
  hashGanttSnapshot,
  canonicalizeGanttSnapshot,
  auditBundleHref,
  auditBundleForPlan,
} from "./snapshot-hash";
export { ganttBarAriaLabel, resolveActivityDetail } from "./activity-detail";
export { ganttExportFileName } from "./export-svg";
