import { createHash } from "node:crypto";
import type { GanttActivity } from "./engine";

export type GanttCatalogEntry = {
  id: string;
  claim_type: "gap" | "tactic";
  statement: string;
};

export type GanttSnapshotPayload = {
  workspace_id: string;
  activities: GanttActivity[];
  tactic_ids: string[];
  counts: { activities: number; validated_tactics: number };
  labels?: GanttCatalogEntry[];
};

export type GanttAuditBundle = {
  href: string;
  plan_id: string;
  workspace_id: string;
  snapshot_hash: string;
};

function dateKey(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return value.trim().slice(0, 10);
}

function sortedIds(ids: string[]): string[] {
  return [...ids].map((id) => id.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function canonicalActivities(activities: GanttActivity[]) {
  return [...activities]
    .map((activity) => ({
      id: activity.id,
      tactic_id: activity.tactic_id,
      start: dateKey(activity.start),
      end: dateKey(activity.end),
      readout: dateKey(activity.readout),
      depends_on: sortedIds(activity.depends_on),
      gap_ids: sortedIds(activity.gap_ids),
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.tactic_id.localeCompare(b.tactic_id));
}

function canonicalLabels(labels: GanttCatalogEntry[] | undefined) {
  return [...(labels ?? [])]
    .map((row) => ({
      id: row.id,
      claim_type: row.claim_type,
      statement: row.statement.trim(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Stable JSON for a save-final Gantt snapshot. Excludes version, note, actor, and hash. */
export function canonicalizeGanttSnapshot(payload: GanttSnapshotPayload): string {
  return JSON.stringify({
    workspace_id: payload.workspace_id,
    activities: canonicalActivities(payload.activities),
    tactic_ids: sortedIds(payload.tactic_ids),
    counts: {
      activities: payload.counts.activities,
      validated_tactics: payload.counts.validated_tactics,
    },
    labels: canonicalLabels(payload.labels),
  });
}

/** SHA-256 hex of the canonical IEGP Gantt payload (bars from validated tactics only). */
export function hashGanttSnapshot(payload: GanttSnapshotPayload): string {
  return createHash("sha256").update(canonicalizeGanttSnapshot(payload)).digest("hex");
}

export function auditBundleHref(args: {
  workspace_id: string;
  plan_id: string;
  snapshot_hash: string;
}): string {
  const query = new URLSearchParams({
    workspace_id: args.workspace_id,
    plan_id: args.plan_id,
    snapshot_hash: args.snapshot_hash,
  });
  return `/accuracy/audit?${query.toString()}`;
}

export function auditBundleForPlan(args: {
  workspace_id: string;
  plan_id: string;
  snapshot_hash: string;
}): GanttAuditBundle {
  return {
    href: auditBundleHref(args),
    plan_id: args.plan_id,
    workspace_id: args.workspace_id,
    snapshot_hash: args.snapshot_hash,
  };
}
