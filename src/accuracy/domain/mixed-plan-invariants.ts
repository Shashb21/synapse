/** Shared deterministic plan checks for benchmark gates and retained evaluation. */
import type { GanttActivity } from "../modules/gantt-project/engine";

export type MixedPlanFinding = {
  code: string;
  severity: "blocking";
  message: string;
  object_ids: string[];
};

/** Check structural validity without editing projection output or consulting gold labels. */
export function inspectMixedPlan(args: {
  plan: { workspace_id: string; activities: GanttActivity[] };
  workspace_id: string | null;
  tactic_ids: Iterable<string>;
  gap_ids: Iterable<string>;
}): MixedPlanFinding[] {
  const findings: MixedPlanFinding[] = [];
  const fail = (code: string, message: string, object_ids: string[] = []) => {
    findings.push({ code, severity: "blocking", message, object_ids });
  };
  const tactics = new Set(args.tactic_ids);
  const gaps = new Set(args.gap_ids);
  const activities = args.plan.activities;
  if (args.workspace_id && args.plan.workspace_id !== args.workspace_id)
    fail("invalid_plan_workspace", "plan workspace differs from copied workspace");
  const activityIds = new Set(activities.map(row => row.id));
  if (activityIds.size !== activities.length)
    fail("duplicate_plan_identity", "duplicate Gantt activity identities");
  for (const row of activities) {
    if (!tactics.has(row.tactic_id))
      fail("invalid_plan_tactic", "Gantt activity references an unknown tactic", [row.id]);
    if (row.gap_ids.some(id => !gaps.has(id)))
      fail("invalid_plan_gap", "Gantt activity references an unknown gap", [row.id]);
    if (row.depends_on.some(id => !activityIds.has(id) || id === row.id))
      fail("invalid_plan_dependency", "Gantt dependency is missing or self-referential", [row.id]);
    if (row.start > row.end)
      fail("reversed_plan_dates", "Gantt activity ends before it starts", [row.id]);
  }
  const byId = new Map(activities.map(row => [row.id, row]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const found = byId.get(id)?.depends_on.some(dependency => byId.has(dependency) && cyclic(dependency)) ?? false;
    visiting.delete(id);
    visited.add(id);
    return found;
  };
  if (activities.some(row => cyclic(row.id)))
    fail("cyclic_plan_dependencies", "Gantt dependency graph contains a cycle");
  return findings;
}
