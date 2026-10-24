import { objectiveDateWarnings } from "@/lib/iegp/planning-context";
import type { StrategicObjective } from "@/lib/iegp/types";
import type { PriorityAxis } from "@/modules/stages/s8-prioritization/axis-math";
import { BAND_LABELS, type Band } from "@/components/matrix/bands";

/** Read-only context shared by priority details and the full gap record.
 * The objective deadline is supplied by its responsible loader when available;
 * it is never derived from the decision date.
 */
export type PriorityObjective = Pick<StrategicObjective, "name" | "key_decision" | "decision_date"> & {
  evidence_needed_by?: string | null;
};

export function EvidenceDecisionContext({ statement, objective }: {
  statement: string;
  objective?: PriorityObjective | null;
}) {
  return (
    <div className="grid gap-2">
      <dl className="grid min-w-0 gap-3 text-body sm:grid-cols-2">
        {[
          ["Evidence needed", statement],
          ["Objective", objective?.name],
          ["Affected decision", objective?.key_decision],
          ["Evidence needed by", objective?.evidence_needed_by],
          ["Decision date", objective?.decision_date],
        ].map(([label, value]) => (
          <div key={label} className={label === "Evidence needed" ? "min-w-0 sm:col-span-2" : "min-w-0"}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 break-words text-foreground">{value?.trim() || "Unknown"}</dd>
          </div>
        ))}
      </dl>
      {objective ? objectiveDateWarnings(objective).map(warning => <p key={warning} role="status" className="text-callout text-unknown-foreground">{warning}</p>) : null}
    </div>
  );
}

export type PriorityJudgement = {
  band: Band | null;
  validated: boolean;
  needs_review?: boolean;
  review_reason?: string | null;
  axis_scores: Record<string, number> | null;
  human_axes?: string[];
  rationale: string | null;
  actor_name: string | null;
  at: string | null;
};

/** Next action for the current judgement, including changed context. */
export function priorityNextAction({ band, validated, needs_review, tacticsUnlocked, open = true }: {
  band: Band | null;
  validated: boolean;
  tacticsUnlocked: boolean;
  needs_review?: boolean;
  open?: boolean;
}): string {
  if (!band) return "Set priority";
  if (needs_review) return "Review changed context and revalidate priority";
  if (!validated) return "Validate priority";
  if (band === "high" && open && tacticsUnlocked) return "Continue to tactics";
  return "Priority validated";
}

export function PriorityJudgementDetails({ priority, axes }: {
  priority: PriorityJudgement | null;
  axes: PriorityAxis[];
}) {
  return (
    <div className="grid gap-2 text-body">
      <p>Priority applies across all settings</p>
      {priority?.needs_review ? <p role="status">Needs priority review · Review changed context and revalidate priority{priority.review_reason ? `: ${priority.review_reason}` : ""}</p> : null}
      <p>
        <span className="font-medium">{priority?.band ? BAND_LABELS[priority.band] : "No band yet"}</span>
        {" · "}{priority?.validated ? "Priority validated" : "Priority not validated"}
        {priority?.validated && priority.actor_name ? ` by ${priority.actor_name}` : ""}
        {priority?.at ? ` · ${priority.at.slice(0, 10)}` : ""}
      </p>
      <dl className="grid gap-2 sm:grid-cols-2">
        {axes.map((axis) => (
          <div key={axis.id} className="min-w-0">
            <dt className="text-muted-foreground">{axis.label}</dt>
            <dd>
              {typeof priority?.axis_scores?.[axis.id] === "number" ? `${priority.axis_scores[axis.id]} / 100` : "Unscored"}
              {priority?.human_axes?.includes(axis.id) ? " · set by hand" : ""}
            </dd>
          </div>
        ))}
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground">Priority rationale</dt>
          <dd className="break-words">{priority?.rationale?.trim() || "Reason not recorded"}</dd>
        </div>
      </dl>
      <p className="text-callout text-muted-foreground">
        Priority validation accepts this judgement. Evidence coverage review and Open, Partial or Addressed evidence status are separate.
        {" "}Unknown context does not block priority validation.
      </p>
    </div>
  );
}
