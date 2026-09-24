import Link from "next/link";
import { notFound } from "next/navigation";
import "@/modules";
import { AppShell, PageIntro } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { STAGES, type StageId } from "@/modules/kernel/contracts";
import { getRun } from "@/modules/kernel/observability";
import type { AgenticRound } from "@/modules/kernel/agentic";

export const dynamic = "force-dynamic";

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto border border-border bg-background p-2 text-[11px] leading-4 text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();
  const exchanges =
    (run.steps.find((step) => step.name === "exchanges")?.data as AgenticRound[] | undefined) ?? [];

  return (
    <AppShell active="runs">
      <PageIntro
        kicker={`${run.stage} · ${STAGES[run.stage as StageId]?.title ?? ""}`}
        title={run.module_id}
      >
        {run.summary ?? run.error ?? "No summary recorded."}
      </PageIntro>

      <Link href="/runs" className="text-[12px] text-muted-foreground no-underline hover:text-foreground">
        ← All runs
      </Link>

      <section className="mt-4 grid gap-3 md:grid-cols-2">
        <article className="border border-border bg-card/40 p-3">
          <h2 className="text-[13px] font-medium text-foreground">Run</h2>
          <dl className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
            <div className="flex justify-between gap-2">
              <dt>Status</dt>
              <dd className={run.status === "error" ? "text-destructive" : "text-foreground"}>{run.status}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Module version</dt>
              <dd className="text-foreground">v{run.module_version}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Started</dt>
              <dd className="text-foreground">{run.started_at.replace("T", " ").slice(0, 19)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Duration</dt>
              <dd className="text-foreground">{run.duration_ms === null ? "—" : `${run.duration_ms} ms`}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Actor</dt>
              <dd className="text-foreground">
                {run.actor.name} · {run.actor.function.replaceAll("_", " ")}
              </dd>
            </div>
          </dl>
          {run.error ? <p className="mt-2 text-[12px] text-destructive">{run.error}</p> : null}
        </article>

        <article className="border border-border bg-card/40 p-3">
          <h2 className="text-[13px] font-medium text-foreground">Route</h2>
          {run.route ? (
            <dl className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
              <div className="flex justify-between gap-2">
                <dt>Provider</dt>
                <dd className="text-foreground">{run.route.provider_label}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Model</dt>
                <dd className="text-foreground">{run.route.model}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Auth</dt>
                <dd className="text-foreground">
                  {run.route.auth === "oauth" ? (run.route.connected ? "OAuth, connected" : "OAuth, not connected") : "none"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Temperature</dt>
                <dd className="text-foreground">{run.route.params.temperature}</dd>
              </div>
              {run.route.degraded ? (
                <p className="mt-1 text-[11px] text-[var(--unknown)]">{run.route.reason}</p>
              ) : null}
            </dl>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">No route recorded.</p>
          )}
          {run.evals.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-2">
              {run.evals.map((score) => (
                <Badge key={score.name} variant="secondary" className="text-[10px]">
                  {score.name} {score.value}
                  {score.target === undefined ? "" : ` / ${score.target}`}
                </Badge>
              ))}
            </div>
          ) : null}
        </article>
      </section>

      {exchanges.length > 0 ? (
        <section className="mt-6 grid gap-2">
          <h2 className="text-[15px] font-medium text-foreground">
            Proposer ↔ critic exchanges
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Locked: three exchanges before the judge sees anything. Each row is one critic response and
            the revision the proposer made in answer to it.
          </p>
          <div className="overflow-x-auto border border-border bg-card/40">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-2 py-1.5 text-left font-normal">Exchange</th>
                  <th className="px-2 py-1.5 text-left font-normal">Proposer</th>
                  <th className="px-2 py-1.5 text-right font-normal">In</th>
                  <th className="px-2 py-1.5 text-right font-normal">Keep</th>
                  <th className="px-2 py-1.5 text-right font-normal">Revise</th>
                  <th className="px-2 py-1.5 text-right font-normal">Drop</th>
                  <th className="px-2 py-1.5 text-right font-normal">Out</th>
                  <th className="px-2 py-1.5 text-right font-normal">Avg critic score</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {exchanges.map((round) => (
                  <tr key={round.round} className="border-b border-border/60 last:border-0">
                    <td className="px-2 py-1.5">Round {round.round}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {round.proposer === "llm" ? "model" : "test stub"}
                    </td>
                    <td className="px-2 py-1.5 text-right">{round.in}</td>
                    <td className="px-2 py-1.5 text-right">{round.kept}</td>
                    <td className="px-2 py-1.5 text-right">{round.to_revise}</td>
                    <td className="px-2 py-1.5 text-right">{round.dropped}</td>
                    <td className="px-2 py-1.5 text-right">{round.out}</td>
                    <td className="px-2 py-1.5 text-right">{round.avg_score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="mt-6 grid gap-2">
        <h2 className="text-[15px] font-medium text-foreground">Steps</h2>
        {run.steps.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No steps recorded.</p>
        ) : (
          <ol className="grid gap-2">
            {run.steps.map((step, index) => (
              <li key={`${step.name}-${index}`} className="border border-border bg-card/40 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-[13px] text-foreground">{step.name}</h3>
                  <span className="text-[11px] text-muted-foreground">
                    {step.duration_ms === null ? step.at.slice(11, 19) : `${step.duration_ms} ms`}
                  </span>
                </div>
                {step.detail ? <p className="mt-1 text-[11px] text-muted-foreground">{step.detail}</p> : null}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground">Payload</summary>
                  <div className="mt-2">
                    <Json value={step.data} />
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-[15px] font-medium text-foreground">Input</h2>
          <Json value={run.input} />
        </div>
        <div>
          <h2 className="mb-2 text-[15px] font-medium text-foreground">Output</h2>
          <Json value={run.output} />
        </div>
      </section>
    </AppShell>
  );
}
