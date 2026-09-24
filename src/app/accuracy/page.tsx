import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { CreateWorkspaceForm } from "@/components/accuracy/create-workspace-form";
import { SeedFromGoldForm } from "@/components/accuracy/seed-from-gold-form";
import { WorkspaceHygieneActions } from "@/components/accuracy/workspace-hygiene-actions";
import { registerAccuracyStack } from "@/accuracy";
import { workspacePlanLabel } from "@/accuracy/domain/plan-label";
import { listWorkspaces } from "@/accuracy/store/tenant";
import { aiEnabled } from "@/modules/kernel/ai-switch";

function addHref(workspaceId: string, kind: "gap" | "tactic"): string {
  return `/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}&add=${kind}`;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ include_archived?: string }>;
}) {
  const { include_archived: includeArchivedParam } = await searchParams;
  const includeArchived = includeArchivedParam === "1";
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let loadError: string | null = null;
  try {
    workspaces = await listWorkspaces(50, { includeArchived });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load workspaces";
  }

  const archivedCount = workspaces.filter((w) => w.archived_at).length;
  // AI off (owner's decision): no upload / parse / extract, so the first screen
  // leads with hand entry of gaps and tactics.
  const aiOn = await aiEnabled();
  const openWorkspaces = workspaces.filter((w) => !w.archived_at);

  return (
    <AccuracyAppShell active="workspaces">
      <PageIntro kicker="Tenancy · org → workspace" title="Workspaces">
        {aiOn
          ? "One workspace maps to one IEP or IEGP. Seed from BeOne gold for a full demo ledger, or create an empty workspace and upload sources. Archive hides a workspace from pickers; delete removes its ledger and run history."
          : "One workspace maps to one IEP or IEGP. AI is off, so there is no upload or parsing: pick a workspace (or create one) and add its gaps and tactics by hand. Archive hides a workspace from pickers; delete removes its ledger and run history."}
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!aiOn ? (
        <section
          className="mb-6 grid gap-3 border border-border bg-card/40 p-3"
          aria-labelledby="manual-start"
          data-testid="accuracy-manual-start"
        >
          <h2 id="manual-start" className="text-[15px] font-medium text-foreground">
            Add gaps and tactics
          </h2>
          <p className="text-[12px] text-muted-foreground">
            AI is off: everything is entered by hand. Choose a workspace, add its evidence gaps and
            tactics, then validate, decide coverage, set priority and schedule dates.
          </p>
          {openWorkspaces.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No workspaces yet — create one below, then add gaps and tactics.
            </p>
          ) : (
            <ul className="grid gap-2">
              {openWorkspaces.map((workspace) => (
                <li
                  key={workspace.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0"
                >
                  <span className="text-[13px] text-foreground">{workspace.name}</span>
                  <span className="flex flex-wrap gap-2">
                    <Link
                      href={addHref(workspace.id, "gap")}
                      className="border border-foreground bg-foreground px-3 py-1 text-[12px] text-background no-underline"
                    >
                      Add gaps
                    </Link>
                    <Link
                      href={addHref(workspace.id, "tactic")}
                      className="border border-foreground bg-foreground px-3 py-1 text-[12px] text-background no-underline"
                    >
                      Add tactics
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        {aiOn ? <SeedFromGoldForm /> : <CreateWorkspaceForm />}
        {aiOn ? <CreateWorkspaceForm /> : <SeedFromGoldForm />}
      </div>

      <section className="grid gap-2" aria-labelledby="workspace-list">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="workspace-list" className="text-[15px] font-medium text-foreground">
            Registered workspaces
          </h2>
          <Link
            href={includeArchived ? "/accuracy" : "/accuracy?include_archived=1"}
            className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {includeArchived ? "Hide archived" : "Show archived"}
          </Link>
        </div>
        {workspaces.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No workspaces yet. Seed from gold or create one above.
          </p>
        ) : (
          <ul className="grid gap-2">
            {workspaces.map((workspace) => (
              <li key={workspace.id} className="border border-border bg-card/40 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] font-medium text-foreground">
                    {workspace.name}
                    {workspacePlanLabel(workspace) ? (
                      <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                        {workspacePlanLabel(workspace)}
                      </span>
                    ) : null}
                  </p>
                  <span className="text-[11px] text-muted-foreground">
                    {workspace.slug}
                    {workspace.archived_at ? " · archived" : ""}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {workspace.id} · org {workspace.org_id}
                </p>
                <p className="mt-2 flex flex-wrap gap-3">
                  {!aiOn ? (
                    <>
                      <Link
                        href={addHref(workspace.id, "gap")}
                        className="text-[12px] font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        Add gaps
                      </Link>
                      <Link
                        href={addHref(workspace.id, "tactic")}
                        className="text-[12px] font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        Add tactics
                      </Link>
                    </>
                  ) : null}
                  <Link
                    href={`/accuracy/sources?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Sources
                  </Link>
                  <Link
                    href={`/accuracy/review?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Review
                  </Link>
                  <Link
                    href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Ledger
                  </Link>
                  <Link
                    href={`/accuracy/coverage?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Coverage
                  </Link>
                  <Link
                    href={`/accuracy/workshop?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Workshop
                  </Link>
                  <Link
                    href={`/accuracy/plan?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Plan
                  </Link>
                  <Link
                    href={`/accuracy/timeline?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Timeline
                  </Link>
                  <Link
                    href={`/accuracy/audit?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Audit
                  </Link>
                  <Link
                    href={`/accuracy/runs?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Runs
                  </Link>
                </p>
                <WorkspaceHygieneActions
                  workspaceId={workspace.id}
                  workspaceName={workspace.name}
                  archived={Boolean(workspace.archived_at)}
                />
              </li>
            ))}
          </ul>
        )}
        {includeArchived && archivedCount === 0 ? (
          <p className="text-[12px] text-muted-foreground">No archived workspaces.</p>
        ) : null}
      </section>
    </AccuracyAppShell>
  );
}
