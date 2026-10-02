import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { Badge } from "@/components/ui/badge";
import { CostRollupPanel } from "@/components/accuracy/cost-rollup-panel";
import { SweepStaleRunsButton } from "@/components/accuracy/sweep-stale-runs-button";
import {
  listAccuracyRuns,
  registerAccuracyStack,
  summarizeAccuracyRunCost,
} from "@/accuracy";
import type { AccuracyCostRollup } from "@/accuracy/kernel/cost-rollup";
import { workspacePlanLabel } from "@/accuracy/domain/plan-label";
import { getWorkspace, listWorkspaces } from "@/accuracy/store/tenant";
import { UnknownWorkspaceNotice } from "@/components/accuracy/unknown-workspace";
import { runRouteLabel } from "@/accuracy/domain/run-route";
import { listAccuracyModules } from "@/accuracy/kernel/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

function statusTone(status: string): string {
  if (status === "ok") return "text-[var(--known-foreground)]";
  if (status === "error" || status === "abandoned") return "text-destructive";
  return "text-[var(--unknown-foreground)]";
}

export default async function AccuracyRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  await requireOwnerPage();
  const { workspace_id: workspaceId = "" } = await searchParams;

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let activeWorkspace: Awaited<ReturnType<typeof getWorkspace>> = null;
  let runs: Awaited<ReturnType<typeof listAccuracyRuns>> = [];
  let rollup: AccuracyCostRollup | null = null;
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    // Looked up directly, so a workspace past the picker's cap still shows its name.
    if (workspaceId) activeWorkspace = await getWorkspace(workspaceId);
    if (activeWorkspace) {
      [runs, rollup] = await Promise.all([
        listAccuracyRuns(workspaceId, 40),
        summarizeAccuracyRunCost(workspaceId),
      ]);
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load runs";
  }

  const unknownWorkspace = Boolean(workspaceId) && !activeWorkspace && !loadError;
  const planLabel = workspacePlanLabel(activeWorkspace);
  // Only agentic modules call a model; mechanical runs read "No model" whatever route was noted.
  const modelModules = new Set(
    listAccuracyModules()
      .filter((implementation) => implementation.manifest.agentic)
      .map((implementation) => implementation.manifest.id),
  );

  return (
    <AccuracyAppShell active="runs" planLabel={planLabel}>
      <PageIntro kicker="Observability · accuracy module runs" title="Runs">
        Per-workspace module runs with timing, route, cost rollup, and eval scores. Stale{" "}
        <code>running</code> rows older than 30 minutes are marked abandoned.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card p-2 text-[12px] text-destructive rounded-lg">
          {loadError}
        </p>
      ) : null}

      <section className="mb-6 grid gap-2" aria-labelledby="workspace-picker">
        <h2 id="workspace-picker" className="text-[13px] font-semibold text-foreground">
          Workspace
        </h2>
        {workspaces.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No workspaces yet.{" "}
            <Link href="/admin/accuracy" className="text-foreground underline-offset-2 hover:underline">
              See workspaces
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/admin/accuracy/runs?workspace_id=${encodeURIComponent(workspace.id)}`}
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

      {unknownWorkspace ? <UnknownWorkspaceNotice workspaceId={workspaceId} /> : null}

      {activeWorkspace && rollup ? (
        <CostRollupPanel rollup={rollup} workspaceName={activeWorkspace?.name} />
      ) : null}

      <section className="grid gap-2" aria-labelledby="recent-runs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="recent-runs" className="text-[13px] font-semibold text-foreground">
            Recent runs
            {activeWorkspace ? (
              <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                · {activeWorkspace.name}
                {planLabel ? ` · ${planLabel}` : ""}
              </span>
            ) : null}
          </h2>
          {activeWorkspace ? <SweepStaleRunsButton workspaceId={workspaceId} /> : null}
        </div>
        {!workspaceId ? (
          <p className="text-[12px] text-muted-foreground">Select a workspace to list runs.</p>
        ) : unknownWorkspace ? null : runs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">Nothing has run in this workspace yet.</p>
        ) : (
          <ul className="grid gap-2">
            {runs.map((run) => {
              const evals = Array.isArray(run.evals) ? run.evals : [];
              return (
                <li key={run.id} className="border border-border bg-card p-3 rounded-lg">
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
                    <span>·</span>
                    <span data-testid="run-route">
                      {runRouteLabel(run.route, modelModules.has(run.module_id))}
                    </span>
                    {run.cost_usd ? (
                      <>
                        <span>·</span>
                        <span>${run.cost_usd}</span>
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
