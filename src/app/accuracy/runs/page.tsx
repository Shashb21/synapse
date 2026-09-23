import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { Badge } from "@/components/ui/badge";
import { listAccuracyRuns, registerAccuracyStack } from "@/accuracy";
import { formatCostUsd, formatTokenUsage, sumRunCostsUsd } from "@/accuracy/kernel/cost";
import { listWorkspaces } from "@/accuracy/store/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

function statusTone(status: string): string {
  if (status === "ok") return "text-[var(--known)]";
  if (status === "error") return "text-destructive";
  return "text-[var(--unknown)]";
}

export default async function AccuracyRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let runs: Awaited<ReturnType<typeof listAccuracyRuns>> = [];
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      runs = await listAccuracyRuns(workspaceId, 40);
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load runs";
  }

  const activeWorkspace = workspaces.find((row) => row.id === workspaceId);
  const totalCost = formatCostUsd(sumRunCostsUsd(runs));
  const runsWithCost = runs.filter((run) => formatCostUsd(run.cost_usd)).length;

  return (
    <AccuracyAppShell active="runs">
      <PageIntro kicker="Observability · accuracy module runs" title="Runs">
        Per-workspace module runs with timing, route, cost, and eval scores. Pick a workspace to load
        recent activity.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      <section className="mb-6 grid gap-2" aria-labelledby="workspace-picker">
        <h2 id="workspace-picker" className="text-[15px] font-medium text-foreground">
          Workspace
        </h2>
        {workspaces.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No workspaces yet.{" "}
            <Link href="/accuracy" className="text-foreground underline-offset-2 hover:underline">
              See workspaces
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/accuracy/runs?workspace_id=${encodeURIComponent(workspace.id)}`}
                  className={`inline-flex rounded-md border px-2 py-1 text-[12px] no-underline ${
                    workspace.id === workspaceId
                      ? "border-foreground bg-card text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {workspace.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="recent-runs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="recent-runs" className="text-[15px] font-medium text-foreground">
            Recent runs
            {activeWorkspace ? (
              <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                · {activeWorkspace.name}
              </span>
            ) : null}
          </h2>
          {workspaceId && totalCost ? (
            <p className="text-[12px] text-muted-foreground" title="Sum of estimated costs on listed runs">
              Listed cost · <span className="font-medium text-foreground">{totalCost}</span>
              {runsWithCost < runs.length ? (
                <span className="text-muted-foreground">
                  {" "}
                  ({runsWithCost}/{runs.length} with estimate)
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        {!workspaceId ? (
          <p className="text-[12px] text-muted-foreground">Select a workspace to list runs.</p>
        ) : runs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">Nothing has run in this workspace yet.</p>
        ) : (
          <ul className="grid gap-2">
            {runs.map((run) => {
              const route =
                run.route && typeof run.route === "object"
                  ? (run.route as { provider_label?: string; model?: string; degraded?: boolean })
                  : null;
              const evals = Array.isArray(run.evals) ? run.evals : [];
              const costLabel = formatCostUsd(run.cost_usd);
              const tokensLabel = formatTokenUsage(run.token_usage);
              return (
                <li key={run.id} className="border border-border bg-card/40 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px] text-foreground">
                      {run.call_kind} · {run.module_id} v{run.module_version}
                      {run.agent_role !== "none" ? ` · ${run.agent_role}` : ""}
                    </p>
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
                    <span>{run.actor_name}</span>
                    {route?.provider_label ? (
                      <>
                        <span>·</span>
                        <span>
                          {route.provider_label} · {route.model}
                          {route.degraded ? " (degraded)" : ""}
                        </span>
                      </>
                    ) : null}
                    {costLabel ? (
                      <>
                        <span>·</span>
                        <span className="text-foreground" title="Estimated from token usage × price table">
                          {costLabel}
                        </span>
                      </>
                    ) : null}
                    {tokensLabel ? (
                      <>
                        <span>·</span>
                        <span>{tokensLabel}</span>
                      </>
                    ) : null}
                    {evals.map((score, index) => {
                      if (!score || typeof score !== "object") return null;
                      const name = "name" in score ? String(score.name) : `eval-${index}`;
                      const value = "value" in score ? String(score.value) : "—";
                      return (
                        <Badge key={`${run.id}-${name}`} variant="secondary" className="text-[10px]">
                          {name} {value}
                        </Badge>
                      );
                    })}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </AccuracyAppShell>
  );
}
