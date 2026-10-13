import { estimatedFields, type TimelineModel } from "./build";
import { dependencyConflicts } from "./gap-view";

export type PlanIssueKind =
  | "pending"
  | "conflict"
  | "cycle"
  | "dangling"
  | "invalid_date"
  | "estimate"
  | "stale_estimate"
  | "proposed_dependency";

export type PlanIssue = { kind: PlanIssueKind; activity_id: string; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string) => ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));

/**
 * Everything that must be resolved before the plan is saved as final
 * (KAN-85, docs/sdlc/14-roadmap-policy.md). A draft can be saved with any of
 * these open; a final cannot. Each message names the activity and what to do.
 */
export function planIssues(model: TimelineModel): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const row of model.pending) {
    issues.push({
      kind: "pending",
      activity_id: row.activity_id,
      message: `${row.tactic_name} has no schedule yet. Set its dates, or remove it from the timeline.`,
    });
  }
  for (const activity of model.activities) {
    const name = activity.tactic_name;
    const bad = [
      ["start", activity.start_date],
      ["end", activity.end_date],
      ["readout", activity.readout_date],
    ].filter(([, value]) => value && !validDay(value));
    if (bad.length > 0) {
      issues.push({
        kind: "invalid_date",
        activity_id: activity.id,
        message: `${name} has an invalid ${bad.map(([label]) => label).join(" and ")} date. Set it as YYYY-MM-DD.`,
      });
    } else if (activity.end_date < activity.start_date) {
      issues.push({ kind: "invalid_date", activity_id: activity.id, message: `${name} ends before it starts. Fix its dates.` });
    } else if (activity.readout_date && activity.readout_date < activity.start_date) {
      issues.push({
        kind: "invalid_date",
        activity_id: activity.id,
        message: `${name} has its readout before it starts. Fix its readout date.`,
      });
    }
    const estimated = estimatedFields(activity.meta.schedule_basis);
    if (activity.meta.estimate_stale) {
      issues.push({
        kind: "stale_estimate",
        activity_id: activity.id,
        message: `${name} has model-estimated dates made before its tactic or design changed. Check them, then accept or edit them.`,
      });
    } else if (estimated.length > 0) {
      issues.push({
        kind: "estimate",
        activity_id: activity.id,
        message: `${name} has a model-estimated ${estimated.join(", ")} date nobody has reviewed. Accept the estimate or edit the dates.`,
      });
    }
    const proposed = activity.meta.proposed_dependencies ?? [];
    if (proposed.length > 0) {
      const names = new Map(model.activities.map((row) => [row.id, row.tactic_name]));
      issues.push({
        kind: "proposed_dependency",
        activity_id: activity.id,
        message: `${name} has ${proposed.length === 1 ? "a proposed dependency" : `${proposed.length} proposed dependencies`} (on ${proposed
          .map((row) => names.get(row.id) ?? row.id)
          .join(", ")}) nobody has reviewed. Accept or reject ${proposed.length === 1 ? "it" : "each"}.`,
      });
    }
  }
  for (const problem of model.problems) {
    issues.push({ kind: problem.kind, activity_id: problem.activity_id, message: problem.message });
  }
  for (const conflict of dependencyConflicts(model.activities)) {
    issues.push({
      kind: "conflict",
      activity_id: conflict.successor_id,
      message: `${conflict.successor_name} starts ${conflict.successor_start}, before ${conflict.predecessor_name} ends (${conflict.predecessor_end}). Move one of them or change the dependency.`,
    });
  }
  return issues;
}

/** The refusal text for a final save: every open issue, one per line. */
export function finalSaveRefusal(issues: PlanIssue[]): string {
  const lines = issues.slice(0, 12).map((issue) => `• ${issue.message}`);
  const more = issues.length > 12 ? `\n…and ${issues.length - 12} more.` : "";
  return `The plan cannot be saved as final yet (${issues.length === 1 ? "1 thing" : `${issues.length} things`} to resolve):\n${lines.join("\n")}${more}\nYou can still save a draft.`;
}
