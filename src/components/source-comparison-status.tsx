/** Truthful automatic-check feedback, separate from parse success and human review. */
import { LockForm } from "@/components/lock-form";
import type { SourceComparisonView } from "@/lib/ingest/comparison-types";

/** Display a current check result or an actionable reason the source is not checked. */
export function SourceComparisonStatus({ comparison, sourceId, mayRetry = false }: {
  comparison?: SourceComparisonView; sourceId: string; mayRetry?: boolean;
}) {
  const conflicts = comparison?.outcomes?.filter(outcome => outcome.judgment === "conflict").length ?? 0;
  const message = !comparison ? "Automatic comparison has not run for this source."
    : comparison.status === "completed" && comparison.basis_current
      ? conflicts > 0 ? `Check completed: ${conflicts} possible ${conflicts === 1 ? "discrepancy" : "discrepancies"} recorded for human review.`
        : "Check completed: no discrepancies detected in the compared claims."
      : comparison.status === "failed" ? "Comparison failed. The parsed source remains usable. Retry the comparison or review claims by hand."
      : comparison.status === "ai_disabled" ? "Comparison not run because AI is disabled. Manual source linking and discrepancy review remain available."
      : "Comparison pending. Refresh to see progress, or retry if the check was interrupted.";
  return <section aria-label="Automatic source comparison" className="my-3 space-y-2 text-sm">
    <p role="status">{message}</p>

    {mayRetry && comparison && (comparison.status !== "completed" || !comparison.basis_current) ? <LockForm
      label="Retry comparison" action="retry_source_comparison" extra={{ source_id: sourceId }} confirmLabel="Run comparison"
      description="Compare retained claims against current plan records. Supporting links and possible discrepancies are saved for human review." /> : null}
  </section>;
}
