import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { AccuracyGanttBoard } from "@/components/accuracy/accuracy-gantt-board";
import { registerAccuracyStack } from "@/accuracy";
import {
  auditBundleFromPlan,
  projectWorkspaceGantt,
  snapshotHashForPlan,
  workspaceLatestPlan,
} from "@/accuracy/modules/gantt-project/save-final";
import { listWorkspaces } from "@/accuracy/store/tenant";
import { claimFieldSnapshot } from "@/accuracy/domain/claim-fields";
import { isActiveLedgerClaim, listClaims, tacticsForGantt } from "@/accuracy/store/claim-store";
import type { GanttTacticSchedule } from "@/components/accuracy/gantt-schedule-editor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyTimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let activities: Awaited<ReturnType<typeof projectWorkspaceGantt>>["activities"] = [];
  let catalog: Awaited<ReturnType<typeof projectWorkspaceGantt>>["catalog"] = [];
  let plan: Awaited<ReturnType<typeof workspaceLatestPlan>> = null;
  let loadError: string | null = null;
  let tactics: GanttTacticSchedule[] = [];

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const projected = await projectWorkspaceGantt(workspaceId);
      activities = projected.activities;
      catalog = projected.catalog;
      plan = await workspaceLatestPlan(workspaceId);
      const claims = (await listClaims(workspaceId, { limit: 500 })).filter(
        (row) => row.claim_type === "tactic" && isActiveLedgerClaim(row),
      );
      const lockById = new Map(tacticsForGantt(claims).map((row) => [row.id, row.dates_locked]));
      tactics = claims.map((row) => {
        const fields = claimFieldSnapshot(row);
        return {
          id: row.id,
          statement: row.statement,
          validated: row.validated,
          start: fields.start,
          end: fields.end,
          readout: fields.readout,
          depends_on: fields.depends_on,
          dates_locked: lockById.get(row.id) ?? false,
        };
      });
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load timeline";
  }

  const activeWorkspace = workspaces.find((row) => row.id === workspaceId);

  return (
    <AccuracyAppShell active="timeline">
      <PageIntro kicker="Final truth · validated tactics only" title="Timeline">
        Interactive Gantt projection from validated tactics. Click a bar for gap, tactic, and
        interdependencies. Export PNG or save as final to freeze a snapshot hash with an audit
        bundle link — no invented studies.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <section className="grid gap-2" aria-labelledby="timeline-empty">
          <h2 id="timeline-empty" className="text-[15px] font-medium text-foreground">
            Choose a workspace
          </h2>
          <p className="text-[12px] text-muted-foreground">
            No workspace selected. Open a workspace from{" "}
            <Link href="/accuracy" className="text-foreground underline-offset-2 hover:underline">
              Workspaces
            </Link>{" "}
            or append <code className="text-[11px]">?workspace_id=</code> to this URL.
          </p>
          {workspaces.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/accuracy/timeline?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="inline-flex rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground no-underline hover:text-foreground"
                  >
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <>
          <section className="mb-6 grid gap-2" aria-labelledby="workspace-picker">
            <h2 id="workspace-picker" className="text-[15px] font-medium text-foreground">
              Workspace
              {activeWorkspace ? (
                <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                  · {activeWorkspace.name}
                </span>
              ) : null}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/accuracy/timeline?workspace_id=${encodeURIComponent(workspace.id)}`}
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
            <p className="text-[12px] text-muted-foreground">
              Review claims on the{" "}
              <Link
                href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
                className="text-foreground underline-offset-2 hover:underline"
              >
                Ledger
              </Link>
              .
            </p>
          </section>

          <AccuracyGanttBoard
            workspaceId={workspaceId}
            activities={activities}
            catalog={catalog}
            planVersion={plan?.version ?? null}
            planStatus={plan?.status ?? null}
            planId={plan?.id ?? null}
            snapshotHash={plan ? snapshotHashForPlan(plan) : null}
            auditBundleHref={plan ? auditBundleFromPlan(plan).href : null}
            tactics={tactics}
          />
        </>
      )}
    </AccuracyAppShell>
  );
}
