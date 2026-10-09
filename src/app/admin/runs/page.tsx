import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import "@/modules";
import { AdminMain, AdminWorkspaceBar, PageIntro } from "@/components/admin/admin-page";
import { runTraceHref } from "@/components/admin/admin-nav";
import { Badge } from "@/components/ui/badge";
import { STAGES, type StageId } from "@/modules/kernel/contracts";
import { listRuns, stageHealth } from "@/modules/kernel/observability";
import { llmTotalsByStage } from "@/modules/kernel/llm-calls";
import { formatCost } from "@/components/admin/llm-calls";
import { listEdits } from "@/modules/kernel/edit-records";
import { listSignals } from "@/modules/kernel/hillclimb";
import { listEvalRuns } from "@/modules/kernel/evals";
import { HillclimbSweepButton } from "@/components/platform/hillclimb-sweep-button";
import { HILLCLIMB_STAGES } from "@/modules/kernel/prompt-versions";
import { aiEnabled } from "@/modules/kernel/ai-switch";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";

export const dynamic = "force-dynamic";

function statusTone(status: string): string {
  if (status === "ok") return "text-[var(--known-foreground)]";
  if (status === "error") return "text-destructive";
  return "text-[var(--unknown-foreground)]";
}

export default async function RunsPage() {
  await requireOwnerPage();
  // Runs live in each workspace's own schema: this page reads the console's workspace (KAN-62).
  const { workspace, runs, health, edits, signals, evals, ai, usage } = await withAdminWorkspace(async (workspace) => {
    const [runs, health, edits, signals, evals, ai, usage] = await Promise.all([
      listRuns({ limit: 40 }),
      stageHealth(),
      listEdits({ limit: 12 }),
      listSignals({ limit: 12 }),
      listEvalRuns({ limit: 12 }),
      aiEnabled(),
      // Tokens and estimated cost of every model call, per stage (KAN-91).
      llmTotalsByStage(workspace.id),
    ]);
    return { workspace, runs, health, edits, signals, evals, ai, usage };
  });

  return (
    <AdminMain>
      <PageIntro kicker="Observability · every module run" title="Runs">
        Inputs, outputs, steps, route, timing, errors and eval scores for every stage run. Nothing in the
        pipeline is a black box.
      </PageIntro>

      <AdminWorkspaceBar workspace={workspace} path="/admin/runs" />

      <section className="mb-8 grid gap-3" aria-labelledby="health">
        <h2 id="health" className="text-[13px] font-semibold text-foreground">
          Stage health
        </h2>
        {health.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No runs recorded yet. Start on the Pipeline page.
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {health.map((row) => (
              <article key={row.stage} className="border border-border bg-card p-3 rounded-lg">
                <h3 className="text-[12px] font-semibold text-foreground">
                  {row.stage} · {STAGES[row.stage as StageId]?.title ?? ""}
                </h3>
                <dl className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                  <div className="flex justify-between gap-2">
                    <dt>Runs</dt>
                    <dd className="text-foreground">{row.runs}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Errors</dt>
                    <dd className={row.errors > 0 ? "text-destructive" : "text-foreground"}>{row.errors}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Median duration</dt>
                    <dd className="text-foreground">{row.p50_ms === null ? "—" : `${row.p50_ms} ms`}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Model tokens</dt>
                    <dd className="text-foreground">{(usage[row.stage]?.total_tokens ?? 0).toLocaleString("en-US")}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Est. cost</dt>
                    <dd className="text-foreground">{formatCost(usage[row.stage]?.cost_usd ?? null, usage[row.stage]?.unpriced ?? 0)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Last</dt>
                    <dd className={statusTone(row.last_status ?? "")}>{row.last_status ?? "—"}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mb-8 grid gap-2" aria-labelledby="recent">
        <h2 id="recent" className="text-[13px] font-semibold text-foreground">
          Recent runs
        </h2>
        {runs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">Nothing has run yet.</p>
        ) : (
          <ul className="grid gap-2">
            {runs.map((run) => (
              <li key={run.id} className="border border-border bg-card p-3 rounded-lg">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={runTraceHref(run.id, workspace.id)} className="text-[13px] text-foreground no-underline hover:underline">
                    {run.stage} · {run.module_id} v{run.module_version}
                  </Link>
                  <span className={`text-[11px] ${statusTone(run.status)}`}>
                    {run.status}
                    {run.duration_ms === null ? "" : ` · ${run.duration_ms} ms`}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {run.summary ?? run.error ?? "no summary"}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{run.started_at.slice(0, 16).replace("T", " ")}</span>
                  <span>·</span>
                  <span>{run.actor.name}</span>
                  {run.route ? (
                    <>
                      <span>·</span>
                      <span>
                        {run.route.provider_label} · {run.route.model}
                        {run.route.degraded ? " (degraded)" : ""}
                      </span>
                    </>
                  ) : null}
                  {run.evals.map((score) => (
                    <Badge key={score.name} variant="secondary" className="text-[10px]">
                      {score.name} {score.value}
                    </Badge>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        <section className="grid gap-2" aria-labelledby="edits">
          <h2 id="edits" className="text-[13px] font-semibold text-foreground">
            Edit rationales
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Every user edit carries a rationale. These are the hillclimb inputs.
          </p>
          {edits.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No edits recorded yet.</p>
          ) : (
            <ul className="grid gap-2">
              {edits.map((edit) => (
                <li key={edit.id} className="border border-border bg-card p-2 rounded-lg">
                  <p className="text-[12px] text-foreground">{edit.rationale}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {edit.stage} · {edit.entity_type} {edit.entity_id} · {edit.field} · {edit.action} ·{" "}
                    {edit.actor.name}
                  </p>
                  {edit.before || edit.after ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {edit.before ?? "—"} → {edit.after ?? "—"}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-2" aria-labelledby="hillclimb-loop">
          <h2 id="hillclimb-loop" className="text-[13px] font-semibold text-foreground">
            Hillclimb loop
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Score registered prompt variants against curated gold, store per-version baselines, and promote
            the winning variant when it beats its baseline.
          </p>
          {ai ? (
            <div className="flex flex-wrap gap-2">
              {HILLCLIMB_STAGES.map((stage) => (
                <HillclimbSweepButton
                  key={stage}
                  stage={stage}
                  target={{ endpoint: "/api/admin/modules/hillclimb", workspace_id: workspace.id }}
                />
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground" data-testid="hillclimb-ai-off">
              AI is off, so there are no prompts to tune. Past scores stay listed here.
            </p>
          )}
        </section>

        <section className="grid gap-2" aria-labelledby="signals">
          <h2 id="signals" className="text-[13px] font-semibold text-foreground">
            Hillclimb signals
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Scored in the hillclimb sweep. Runs learn from similar past decisions as worked examples, not from these rationales as rules.
          </p>
          {signals.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No signals yet.</p>
          ) : (
            <ul className="grid gap-2">
              {signals.map((signal) => (
                <li key={signal.id} className="border border-border bg-card p-2 rounded-lg">
                  <p className="text-[12px] text-foreground">{signal.rationale}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {signal.stage} · {signal.kind.replaceAll("_", " ")} · {signal.subject}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-2" aria-labelledby="evals">
          <h2 id="evals" className="text-[13px] font-semibold text-foreground">
            Eval runs
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Per-stage scores. A stage can hillclimb without touching its neighbours.
          </p>
          {evals.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No eval runs yet.</p>
          ) : (
            <ul className="grid gap-2">
              {evals.map((run) => (
                <li key={run.id} className="border border-border bg-card p-2 rounded-lg">
                  <p className="text-[12px] text-foreground">
                    {run.stage} · {run.module_id} v{run.module_version}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {run.metrics.map((metric) => (
                      <Badge
                        key={metric.name}
                        variant="outline"
                        className={
                          metric.target !== undefined && metric.value < metric.target
                            ? "border-destructive/50 text-[10px]"
                            : "text-[10px]"
                        }
                      >
                        {metric.name} {metric.value}
                        {metric.target === undefined ? "" : ` / ${metric.target}`}
                      </Badge>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminMain>
  );
}
