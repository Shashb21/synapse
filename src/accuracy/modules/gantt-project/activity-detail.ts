import type { GanttActivity } from "./engine";
import type { GanttCatalogEntry } from "./snapshot-hash";

export type ResolvedActivityGap = {
  id: string;
  statement: string;
};

export type ResolvedActivityDetail = {
  activity: GanttActivity;
  tactic: GanttCatalogEntry | null;
  gaps: ResolvedActivityGap[];
  depends_on: Array<{ id: string; tactic_id: string; statement: string }>;
  dependents: Array<{ id: string; tactic_id: string; statement: string }>;
};

function catalogById(catalog: GanttCatalogEntry[]): Map<string, GanttCatalogEntry> {
  return new Map(catalog.map((row) => [row.id, row]));
}

function activityStatement(
  activity: GanttActivity | undefined,
  catalog: Map<string, GanttCatalogEntry>,
): string {
  if (!activity) return "";
  return catalog.get(activity.tactic_id)?.statement ?? activity.tactic_id;
}

/** Screen-reader label: tactic, gaps, timing, and interdependencies. */
export function ganttBarAriaLabel(
  activity: GanttActivity,
  catalog: GanttCatalogEntry[] = [],
): string {
  const byId = catalogById(catalog);
  const tactic = byId.get(activity.tactic_id)?.statement ?? activity.tactic_id;
  const gaps =
    activity.gap_ids.length === 0
      ? "no linked gaps"
      : `covers ${activity.gap_ids
          .map((id) => byId.get(id)?.statement ?? id)
          .join(", ")}`;
  const deps =
    activity.depends_on.length === 0
      ? "no upstream dependencies"
      : `depends on ${activity.depends_on.join(", ")}`;
  const readout = activity.readout ? ` readout ${activity.readout.slice(0, 10)}` : "";
  return `${tactic}, ${activity.start.slice(0, 10)} to ${activity.end.slice(0, 10)}${readout}, ${gaps}, ${deps}`;
}

export function resolveActivityDetail(args: {
  activity: GanttActivity;
  activities: GanttActivity[];
  catalog: GanttCatalogEntry[];
}): ResolvedActivityDetail {
  const byId = catalogById(args.catalog);
  const activityById = new Map(args.activities.map((row) => [row.id, row]));
  const tactic = byId.get(args.activity.tactic_id) ?? null;
  const gaps = args.activity.gap_ids.map((id) => ({
    id,
    statement: byId.get(id)?.statement ?? id,
  }));
  const depends_on = args.activity.depends_on.map((id) => {
    const upstream = activityById.get(id);
    const tacticId = upstream?.tactic_id ?? id;
    return {
      id,
      tactic_id: tacticId,
      statement: activityStatement(upstream, byId) || tacticId,
    };
  });
  const dependents = args.activities
    .filter((row) => row.id !== args.activity.id && row.depends_on.includes(args.activity.id))
    .map((row) => ({
      id: row.id,
      tactic_id: row.tactic_id,
      statement: activityStatement(row, byId),
    }));
  return { activity: args.activity, tactic, gaps, depends_on, dependents };
}
