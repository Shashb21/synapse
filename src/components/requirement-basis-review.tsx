/** Whole-basis review in the gap assessment flow, with original source context. */
import { LockForm } from "@/components/lock-form";
import { COVERAGE_DIMENSIONS, DIMENSION_LABELS } from "@/lib/iegp/enums";
import type { getRequirementBasisReview } from "@/lib/iegp/requirement-basis";

const CONTROL = "rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground";

/** Shows the sourced proposal and collects one human confirmation for the basis. */
export function RequirementBasisReview({ gapId, review, onRefresh }: {
  gapId: string;
  onRefresh?: () => void;
  review: ReturnType<typeof getRequirementBasisReview>;
}) {
  const { basis } = review;
  return (
    <div className="mb-4">
      <p className="mb-2 text-sm text-muted-foreground">
        Requirement basis: {basis.confirmation.locked ? `confirmed by ${basis.confirmation.actor_name}` : "needs human review"}.
        {review.source_changed ? " Sources changed since the previous review." : ""}
      </p>
      <LockForm onSuccess={onRefresh} label="Review requirement basis" action="review_requirement_basis"
        extra={{ gap_id: gapId, expected_version: review.version }} size="lg"
        confirmLabel="Confirm requirement basis"
        description="Review the linked needs and gap context together. Unresolved requirements can be saved, but prevent confirmed Full coverage. Unknown means the information is missing, not that the tactic fails it.">
        {COVERAGE_DIMENSIONS.map(dim => {
          const requirement = basis.dimensions[dim];
          const label = DIMENSION_LABELS[dim];
          return (
            <fieldset key={dim} className="grid gap-2 border-t border-border pt-3">
              <legend className="text-sm font-medium">{label}</legend>
              {requirement.sources.length ? (
                <ul className="grid gap-1 text-xs text-muted-foreground">
                  {requirement.sources.map((source, index) => (
                    <li key={index}>
                      <span className="font-medium">{source.kind === "gap" ? "Gap context" : `Evidence need ${source.need_id} · source ${source.source_id}${source.block_id ? ` · block ${source.block_id}` : ""}`}:</span>{" "}
                      {source.value}{source.quote !== source.value ? ` — “${source.quote}”` : ""}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-muted-foreground">No sourced requirement recorded. Choose applicability explicitly.</p>}
              {requirement.conflicts.length ? <p className="text-sm text-unknown-foreground">Source disagreement: {requirement.conflicts.join(" / ")}. Record how this decision resolves it.</p> : null}
              <label className="grid gap-1 text-xs">
                {label} applicability
                <select name={`req_${dim}_applicability`} defaultValue={requirement.applicability} className={CONTROL}>
                  <option value="required">Required</option>
                  <option value="not_applicable">Not applicable</option>
                  <option value="undetermined">Not yet determined</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs">
                {label} requirement
                <textarea name={`req_${dim}_requirement`} defaultValue={requirement.requirement} className={CONTROL} />
              </label>
              <label className="grid gap-1 text-xs">
                {label} justification (required for Not applicable)
                <textarea name={`req_${dim}_rationale`} defaultValue={requirement.rationale} className={CONTROL} />
              </label>
              {requirement.conflicts.length ? <label className="grid gap-1 text-xs">
                {label} conflict resolution
                <textarea name={`req_${dim}_resolution`} defaultValue={requirement.resolution} className={CONTROL} />
              </label> : null}
            </fieldset>
          );
        })}
        <label className="grid gap-1 text-xs">
          Review rationale
          <textarea name="rationale" required minLength={3} defaultValue={basis.rationale} className={CONTROL} />
        </label>
      </LockForm>
    </div>
  );
}
