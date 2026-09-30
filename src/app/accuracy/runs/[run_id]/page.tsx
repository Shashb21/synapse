/** Authenticated view of a single accuracy agent run's recorded versions. */
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { readAgentProgression, registerAccuracyStack } from "@/accuracy";
import type { AgentEventRecord } from "@/accuracy/kernel/agent-events";
import { sessionContext } from "@/modules/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

function eventMetering(record: AgentEventRecord) {
  const { latency_ms, token_usage, cost_usd } = record.event;
  return `${latency_ms} ms · ${token_usage.total_tokens} tokens · $${cost_usd.toFixed(6)}`;
}

/** Render one run only after session and workspace checks. */
export default async function AccuracyRunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ run_id: string }>;
  searchParams: Promise<{ workspace_id?: string | string[] }>;
}) {
  const session = await sessionContext();
  const { run_id } = await params;
  const { workspace_id } = await searchParams;
  const workspaceId = typeof workspace_id === "string" ? workspace_id.trim() : "";
  const listHref = `/accuracy/runs?workspace_id=${encodeURIComponent(workspaceId)}`;

  let error: string | null = null;
  let progression: Awaited<ReturnType<typeof readAgentProgression>> = null;
  if (!session.signed_in) {
    error = "Sign in to inspect run progression.";
  } else if (!workspaceId) {
    error = "One workspace_id is required.";
  } else if (!run_id?.trim()) {
    error = "A run is required.";
  } else {
    try {
      progression = await readAgentProgression({ run_id: run_id.trim(), workspace_id: workspaceId });
      if (!progression) error = "Run not found in this workspace.";
    } catch {
      error = "Could not load this run. Try again.";
    }
  }

  const events = progression?.events ?? [];
  const judgment = events.find((record) => record.event.event_type === "judgment");
  return (
    <AccuracyAppShell active="runs">
      <PageIntro kicker="Observability · accuracy module runs" title="Run progression">
        Recorded versions and production checks for one agent run.
      </PageIntro>
      <Link href={listHref} className="mb-5 inline-block text-[12px] text-foreground underline-offset-2 hover:underline">
        Back to runs
      </Link>
      {error ? <p role="alert" className="border border-border p-3 text-[13px] text-foreground">{error}</p> : null}
      {!error && events.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No agent progression has been recorded for this run.</p>
      ) : null}
      {!error && events.length > 0 ? (
        <div className="grid gap-4">
          {events.map((record) => {
            const event = record.event;
            if (event.event_type === "snapshot") {
              const selected = judgment?.event.event_type === "judgment" && judgment.event.selected_iteration === event.iteration;
              return (
                <section key={record.id} className="border border-border bg-card/40 p-3" aria-label={`V${event.iteration}`}>
                  <h2 className="text-[15px] font-medium text-foreground">
                    V{event.iteration}{selected ? " · Selected version" : ""}
                  </h2>
                  <p className="mt-1 text-[12px] text-muted-foreground">{eventMetering(record)}</p>
                  <p className="mt-2 text-[12px] text-foreground">
                    {event.signals.quote_validity.valid_count + event.signals.quote_validity.invalid_count + event.signals.quote_validity.unchecked_count === 0
                      ? "Quote checks: No source quote spans to check."
                      : `Quote checks: ${event.signals.quote_validity.valid_count} valid, ${event.signals.quote_validity.invalid_count} invalid, ${event.signals.quote_validity.unchecked_count} unchecked.`}
                  </p>
                  <p className="text-[12px] text-foreground">
                    {event.signals.invariant_failures.length
                      ? `Invariant failures: ${event.signals.invariant_failures.join("; ")}.`
                      : "No invariant failures recorded."} Completeness: not checked.
                  </p>
                  <h3 className="mt-3 text-[13px] font-medium text-foreground">Exact output</h3>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words border border-border bg-background p-3 text-[12px] text-foreground">{JSON.stringify(event.output, null, 2)}</pre>
                </section>
              );
            }
            if (event.event_type === "critique") {
              return (
                <section key={record.id} className="border border-border bg-card/40 p-3" aria-label={`Critique of V${event.iteration}`}>
                  <h2 className="text-[15px] font-medium text-foreground">Critique of V{event.iteration}</h2>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    Critic assessment: {event.score === null ? "Structurally unassessed" : event.score} · {eventMetering(record)}.
                    {event.score === null ? "" : " This is a production signal, not gold accuracy."}
                  </p>
                  <div className="mt-3 border-t border-border pt-2 text-[12px] text-foreground">
                    <h3 className="font-medium">Production completeness risk: {event.completeness.risk_level.replaceAll("_", " ")}</h3>
                    <p className="mt-1">Checked blocks: {event.completeness.checked_block_ids.join(", ") || "none"}.
                      Unchecked blocks: {event.completeness.unchecked_block_ids.join(", ") || "none"}.</p>
                    {event.completeness.risk_level === "check_failed" ? (
                      <p>Check failed; this version has not been fully assessed for omissions.</p>
                    ) : null}
                    {event.completeness.suspected_omissions.length ? (
                      <ul className="mt-2 grid gap-2">
                        {event.completeness.suspected_omissions.map((omission) => (
                          <li key={omission.issue_id} className="border-t border-border pt-2">
                            <strong>{omission.importance === "important" ? "Important" : "Advisory"} · {omission.item_kind}</strong>: {omission.summary}
                            <p>Source file {omission.source_ref.source_file_id}, block {omission.source_ref.block_id}</p>
                            <p>Evidence quote: “{omission.evidence_quote}”</p>
                            <p>{omission.reason} Suggested action: {omission.suggested_action}</p>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {event.completeness.prior_issue_resolutions.length ? (
                      <ul className="mt-2 grid gap-2">
                        {event.completeness.prior_issue_resolutions.map((resolution) => (
                          <li key={resolution.issue_id} className="border-t border-border pt-2">
                            <strong>{resolution.outcome.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())}</strong>
                            {` · ${resolution.issue_id}: ${resolution.reason}`}
                            {resolution.matched_item_ref ? ` · Matched item ${resolution.matched_item_ref}` : ""}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  {event.issues.length ? (
                    <ul className="mt-2 grid gap-2">
                      {event.issues.map((issue) => (
                        <li key={issue.issue_id} className="border-t border-border pt-2 text-[12px] text-foreground">
                          <strong>{issue.severity} · {issue.category}</strong>: {issue.claim}
                          {issue.source_ref ? <span> · Source {issue.source_ref.source_file_id}, block {issue.source_ref.block_id}</span> : null}
                          <p>Suggested action: {issue.suggested_action}</p>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="mt-2 text-[12px] text-muted-foreground">No critic issues recorded.</p>}
                </section>
              );
            }
            return (
              <section key={record.id} className="border border-border bg-card/40 p-3" aria-label="Judgment">
                <h2 className="text-[15px] font-medium text-foreground">Judgment</h2>
                <p className="mt-1 text-[12px] text-foreground">Selected version: V{event.selected_iteration}</p>
                <p className="mt-1 text-[12px] text-foreground">Reason: {event.reason}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">{eventMetering(record)}</p>
              </section>
            );
          })}
        </div>
      ) : null}
    </AccuracyAppShell>
  );
}
