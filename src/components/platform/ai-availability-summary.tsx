/** Compact read-only overview of saved AI settings and their customer consequences. */
import { buildAiSummary, type AiSummaryInput } from "./ai-availability";

/** Render the known platform state with one priority link to its existing control. */
export function AiAvailabilitySummary({ input }: { input: AiSummaryInput }) {
  const summary = buildAiSummary(input);
  return (
    <section aria-labelledby="ai-availability" className="min-w-0 border border-border bg-card p-4 rounded-lg" data-testid="ai-availability-summary">
      <h2 id="ai-availability" className="text-base font-semibold text-foreground">AI availability</h2>
      <dl className="mt-2 grid gap-2 text-[12px] sm:grid-cols-[7rem_minmax(0,1fr)] [&_dd]:min-w-0 [&_dd]:break-words">
        <dt className="text-muted-foreground">Master switch</dt><dd>{summary.master}</dd>
        <dt className="text-muted-foreground">AI sections</dt><dd>{summary.sections}</dd>
        <dt className="text-muted-foreground">Customer access</dt><dd>{summary.customer}</dd>
        <dt className="text-muted-foreground">Saved routing</dt><dd>{summary.routing}</dd>
        <dt className="text-muted-foreground">Credentials</dt><dd>{summary.credentials}</dd>
      </dl>
      <a href={summary.action.href} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">{summary.action.label}</a>
    </section>
  );
}
