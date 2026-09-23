import { gapsForGantt, isActiveLedgerClaim, listClaims, tacticsForGantt } from "@/accuracy/store/claim-store";
import { listCoverageJoins } from "@/accuracy/store/coverage-store";
import {
  latestAccuracyPlan,
  saveAccuracyPlan,
  type AccuracyPlanRecord,
  type AccuracyPlanStatus,
} from "@/accuracy/store/plan-store";
import type { Actor } from "@/accuracy/kernel/contracts";
import {
  assertSaveFinalActivities,
  projectGanttFromTactics,
  type GanttActivity,
} from "./engine";

export async function projectWorkspaceGantt(workspace_id: string): Promise<{
  workspace_id: string;
  activities: GanttActivity[];
  validated_tactic_count: number;
  tactic_count: number;
}> {
  const claims = (await listClaims(workspace_id, { limit: 500 })).filter(isActiveLedgerClaim);
  const tactics = tacticsForGantt(claims);
  const gaps = gapsForGantt(claims);
  const coverages = (await listCoverageJoins(workspace_id)).map((row) => ({
    gap_id: row.gap_id,
    tactic_id: row.tactic_id,
    overall: row.overall,
    validated: row.validated,
  }));
  const activities = projectGanttFromTactics({ tactics, gaps, coverages });
  return {
    workspace_id,
    activities,
    validated_tactic_count: tactics.filter((t) => t.validated).length,
    tactic_count: tactics.length,
  };
}

/**
 * Persist a draft/final snapshot from validated tactics only.
 * Invented bars (no validated tactic binding) are rejected.
 */
export async function saveFinalGanttPlan(args: {
  workspace_id: string;
  status?: AccuracyPlanStatus;
  note: string;
  actor: Actor;
}): Promise<{ plan: AccuracyPlanRecord; activities: GanttActivity[] }> {
  const status = args.status ?? "final";
  const projected = await projectWorkspaceGantt(args.workspace_id);
  const validatedIds = new Set(
    (await listClaims(args.workspace_id, { claim_type: "tactic" }))
      .filter((c) => c.validated && isActiveLedgerClaim(c))
      .map((c) => c.id),
  );
  assertSaveFinalActivities(projected.activities, validatedIds);

  const plan = await saveAccuracyPlan({
    workspace_id: args.workspace_id,
    status,
    note: args.note,
    actor: args.actor,
    snapshot: {
      activities: projected.activities,
      tactic_ids: [...validatedIds].sort(),
      counts: {
        activities: projected.activities.length,
        validated_tactics: validatedIds.size,
      },
    },
  });

  return { plan, activities: projected.activities };
}

export async function workspaceLatestPlan(workspace_id: string) {
  return latestAccuracyPlan(workspace_id);
}
