/** Whole-snapshot extraction selection from production evidence; no reference answers. */
import { isAdmissibleSnapshot, type RetainedCandidate, type SnapshotSelection } from "../kernel/agentic";
import type { SnapshotCompletenessAssessment } from "./completeness-audit/snapshot-inspector";

/** Successful inspection of the chosen source scope; omission review remains an independent gate. */
export function sourceAssessmentChecked(assessment: SnapshotCompletenessAssessment, missingIds: string[]): boolean {
  return (assessment.risk_level !== "check_failed" && assessment.risk_level !== "not_applicable")
    && assessment.checked_block_ids.length > 0 && assessment.unchecked_block_ids.length === 0 && missingIds.length === 0;
}

/** Rank available coverage, unresolved source omissions, then structural quality. */
function quality<T>(candidate: RetainedCandidate<T>): number[] {
  const { completeness, score } = candidate.assessment;
  return [
    -completeness.unchecked_block_ids.length,
    -completeness.suspected_omissions.filter(issue => issue.importance === "important").length,
    -completeness.suspected_omissions.filter(issue => issue.importance === "advisory").length,
    completeness.checked_block_ids.length,
    score!,
    candidate.iteration, // Equal observed quality uses the most recent admissible version.
  ];
}

/** Final normalization/page validation must accept the entire snapshot before judgment. */
export function selectExtractionSnapshot<T>(candidates: readonly RetainedCandidate<T>[],
  validate: (draft: T) => boolean): SnapshotSelection {
  const eligible = candidates.filter(candidate => isAdmissibleSnapshot(candidate) && validate(candidate.draft));
  if (!eligible.length) throw new Error("No admissible extraction snapshot: source evidence or validation failed");
  eligible.sort((a, b) => {
    const left = quality(a), right = quality(b);
    for (let i = 0; i < left.length; i++) {
      const difference = right[i] - left[i];
      if (difference) return difference;
    }
    return 0;
  });
  const selected = eligible[0];
  const { completeness } = selected.assessment;
  return { selected_iteration: selected.iteration,
    reason: `Selected V${selected.iteration} from ${eligible.length}/${candidates.length} admissible source-backed snapshots: `
      + `${selected.signals.quote_validity.valid_count} validated quotes; ${completeness.checked_block_ids.length} checked blocks; `
      + `${completeness.unchecked_block_ids.length} unchecked blocks; `
      + `${completeness.suspected_omissions.filter(issue => issue.importance === "important").length} important omissions. `
      + "Compared source coverage, important/advisory omissions and structural score; equal quality prefers the most recent version. "
      + "Omission findings remain subject to review." };
}
