import { assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { claimMetadata, getClaimsByIds, gapsForGantt, isDownstreamClaim, listDownstreamClaims, tacticsForGantt } from "@/accuracy/store/claim-store";
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
import {
  auditBundleForPlan,
  hashGanttSnapshot,
  type GanttAuditBundle,
  type GanttCatalogEntry,
} from "./snapshot-hash";

export function catalogForActivities(args: {
  claims: Array<{ id: string; claim_type: string; statement: string }>;
  activities: GanttActivity[];
}): GanttCatalogEntry[] {
  const needed = new Set<string>();
  for (const activity of args.activities) {
    needed.add(activity.tactic_id);
    for (const gapId of activity.gap_ids) needed.add(gapId);
  }
  const byId = new Map(args.claims.map((row) => [row.id, row]));
  const labels: GanttCatalogEntry[] = [];
  for (const id of [...needed].sort((a, b) => a.localeCompare(b))) {
    const row = byId.get(id);
    if (!row) continue;
    if (row.claim_type !== "gap" && row.claim_type !== "tactic") continue;
    labels.push({
      id: row.id,
      claim_type: row.claim_type,
      statement: row.statement,
    });
  }
  return labels;
}

export function snapshotHashForPlan(plan: AccuracyPlanRecord): string {
  if (plan.snapshot.snapshot_hash) return plan.snapshot.snapshot_hash;
  return hashGanttSnapshot({
    workspace_id: plan.workspace_id,
    activities: plan.snapshot.activities,
    tactic_ids: plan.snapshot.tactic_ids,
    counts: plan.snapshot.counts,
    labels: plan.snapshot.labels,
  });
}

export function auditBundleFromPlan(plan: AccuracyPlanRecord): GanttAuditBundle {
  return auditBundleForPlan({
    workspace_id: plan.workspace_id,
    plan_id: plan.id,
    snapshot_hash: snapshotHashForPlan(plan),
  });
}

export async function projectWorkspaceGantt(workspace_id: string): Promise<{
  workspace_id: string;
  activities: GanttActivity[];
  validated_tactic_count: number;
  tactic_count: number;
  catalog: GanttCatalogEntry[];
}> {
  await assertAccuracyCanProgress(workspace_id, "gantt_project");
  const claims = await listDownstreamClaims(workspace_id, { limit: 500 });
  // Eligibility filtering removes review rows from inventory, so resolve stored references separately.
  // The pure helpers need known excluded rows to remove dependency/parent links as well as bars.
  const referencedIds = [...new Set(claims.flatMap(claim => {
    const meta = claimMetadata(claim);
    return [...(Array.isArray(meta.depends_on) ? meta.depends_on : []),
      ...(Array.isArray(meta.gap_ids) ? meta.gap_ids : []), meta.parent_gap_id]
      .filter((id): id is string => typeof id === "string");
  }))];
  const excludedReferences = (await getClaimsByIds(workspace_id, referencedIds)).filter(row => !isDownstreamClaim(row));
  const projectionClaims = [...claims, ...excludedReferences];
  const tactics = tacticsForGantt(projectionClaims);
  const gaps = gapsForGantt(projectionClaims);
  const eligibleIds = new Set(claims.map(claim => claim.id));
  const coverages = (await listCoverageJoins(workspace_id)).filter(row => eligibleIds.has(row.gap_id) && eligibleIds.has(row.tactic_id)).map((row) => ({
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
    catalog: catalogForActivities({ claims, activities }),
  };
}

/**
 * Persist a draft/final snapshot from validated tactics only.
 * Invented bars (no validated tactic binding) are rejected.
 * The snapshot hash is the save-final truth fingerprint; the audit bundle
 * links the frozen bars to the workspace hillclimb trail.
 */
export async function saveFinalGanttPlan(args: {
  workspace_id: string;
  status?: AccuracyPlanStatus;
  note: string;
  actor: Actor;
}): Promise<{
  plan: AccuracyPlanRecord;
  activities: GanttActivity[];
  snapshot_hash: string;
  audit_bundle: GanttAuditBundle;
}> {
  const status = args.status ?? "final";
  const projected = await projectWorkspaceGantt(args.workspace_id);
  const validatedIds = new Set(
    (await listDownstreamClaims(args.workspace_id, { claim_type: "tactic" }))
      .filter((c) => c.validated && isDownstreamClaim(c))
      .map((c) => c.id),
  );
  assertSaveFinalActivities(projected.activities, validatedIds);

  const tactic_ids = [...validatedIds].sort();
  const counts = {
    activities: projected.activities.length,
    validated_tactics: validatedIds.size,
  };
  const labels = projected.catalog;
  const snapshot_hash = hashGanttSnapshot({
    workspace_id: args.workspace_id,
    activities: projected.activities,
    tactic_ids,
    counts,
    labels,
  });

  const plan = await saveAccuracyPlan({
    workspace_id: args.workspace_id,
    status,
    note: args.note,
    actor: args.actor,
    snapshot: {
      activities: projected.activities,
      tactic_ids,
      counts,
      labels,
      snapshot_hash,
    },
  });

  return {
    plan,
    activities: projected.activities,
    snapshot_hash,
    audit_bundle: auditBundleFromPlan(plan),
  };
}

export async function workspaceLatestPlan(workspace_id: string) {
  return latestAccuracyPlan(workspace_id);
}
