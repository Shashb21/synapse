import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { getExtractRun } from "@/lib/iegp/extract/store";

export const dynamic = "force-dynamic";

export default async function ExtractRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const found = await getExtractRun(id);
  if (!found) notFound();
  const { run, steps } = found;
  const result = run.result as {
    gaps?: { name: string; statement: string; domain: string; source_quote: string }[];
    judge?: { rationale?: string; decisions?: { name: string; action: string; rationale: string }[] };
    persist?: { sourceId: string; createdGapIds: string[]; mergedGapIds: string[] };
    observed_in?: { created: string[]; joined_existing: string[] };
    rounds?: { round: number; critic: { summary?: string; findings: { kind: string; statement: string }[] } }[];
  } | null;

  return (
    <AppShell active="extract-runs">
      <PageIntro kicker={run.id} title={run.title}>
        {run.status} · {run.kind} · {run.prompt_version} · {run.persist ? "persisted" : "dry-run"}
      </PageIntro>
      <p className="mb-4 text-[12px] text-muted-foreground">
        <Link href="/extract-runs">All runs</Link>
        {" · "}
        <a href={`/api/extract/runs/${run.id}?download=1`}>Download JSON</a>
      </p>
      {run.error ? <p className="mb-4 text-[13px] text-destructive">{run.error}</p> : null}
      {result?.persist ? (
        <p className="mb-4 text-[13px] text-muted-foreground">
          Source {result.persist.sourceId}. New gaps: {result.persist.createdGapIds.join(", ") || "none"}.
          Joined existing: {result.persist.mergedGapIds.join(", ") || "none"}.
        </p>
      ) : null}
      {result?.judge?.rationale ? (
        <p className="mb-4 text-[13px] leading-5 text-foreground">{result.judge.rationale}</p>
      ) : null}
      <h2 className="mb-2 text-[13px] text-muted-foreground">Judged gaps</h2>
      <div className="mb-8 grid gap-2">
        {(result?.gaps ?? []).map((gap) => (
          <article key={gap.name} className="border border-border bg-card p-3">
            <p className="text-[13px] text-foreground">{gap.name}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{gap.domain}</p>
            <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{gap.statement}</p>
            <p className="mt-2 text-[11px] italic text-muted-foreground">{gap.source_quote}</p>
          </article>
        ))}
      </div>
      <h2 className="mb-2 text-[13px] text-muted-foreground">Agent steps</h2>
      <div className="grid gap-2">
        {steps.map((step) => (
          <details key={step.id} className="border border-border bg-card p-3">
            <summary className="cursor-pointer text-[13px]">
              Round {step.round} · {step.role}
              {step.latency_ms != null ? ` · ${step.latency_ms}ms` : ""}
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto text-[11px] leading-4 text-muted-foreground">
              {JSON.stringify({ request: step.request, response: step.response, error: step.error }, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </AppShell>
  );
}
