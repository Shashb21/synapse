import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { WorkshopStage } from "@/components/accuracy/workshop-stage";
import { registerAccuracyStack } from "@/accuracy";
import { getWorkspace, listWorkspaces } from "@/accuracy/store/tenant";
import { latestWorkshopSnapshot, workshopReadiness } from "@/accuracy/store/workshop-store";
import { WorkshopSaveCta } from "@/components/accuracy/workshop-save-cta";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyWorkshopPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  await requireOwnerPage();
  const { workspace_id: workspaceId = "" } = await searchParams;
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let loadError: string | null = null;
  let snapshot: Awaited<ReturnType<typeof latestWorkshopSnapshot>> = null;
  let readiness: Awaited<ReturnType<typeof workshopReadiness>>["readiness"] | null = null;
  let workspace: Awaited<ReturnType<typeof getWorkspace>> | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      workspace = await getWorkspace(workspaceId);
      if (workspace) {
        const ready = await workshopReadiness(workspaceId);
        readiness = ready.readiness;
        snapshot = await latestWorkshopSnapshot(workspaceId);
      }
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load workshop";
  }

  if (workspace && snapshot) {
    return (
      <WorkshopStage
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        workspaceSlug={workspace.slug}
        snapshot={snapshot}
        exitHref={`/admin/accuracy/plan?workspace_id=${encodeURIComponent(workspace.id)}`}
      />
    );
  }

  const workshopHref = workspaceId
    ? `/admin/accuracy/workshop?workspace_id=${encodeURIComponent(workspaceId)}`
    : "/admin/accuracy/workshop";

  return (
    <AccuracyAppShell active="workshop">
      <PageIntro kicker="Stage · facilitator tags" title="Workshop">
        Freeze inventory after validate/map, then facilitate on tagged boards. No suggested tags in
        v1. Every adapt needs a rationale.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <section className="grid gap-2" aria-labelledby="workshop-empty">
          <h2 id="workshop-empty" className="text-[15px] font-medium text-foreground">
            Choose a workspace
          </h2>
          <p className="text-[12px] text-muted-foreground">
            Open from{" "}
            <Link href="/admin/accuracy" className="underline-offset-2 hover:underline">
              Workspaces
            </Link>{" "}
            or append <code className="text-[11px]">?workspace_id=</code>.
          </p>
          {workspaces.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {workspaces.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/admin/accuracy/workshop?workspace_id=${encodeURIComponent(row.id)}`}
                    className="inline-flex rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground no-underline hover:text-foreground"
                  >
                    {row.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : !workspace ? (
        <p className="text-[12px] text-destructive">Unknown workspace.</p>
      ) : readiness ? (
        <WorkshopSaveCta
          workspaceId={workspace.id}
          ready={readiness.ready}
          blockers={readiness.blockers}
          hasSnapshot={false}
          workshopHref={workshopHref}
        />
      ) : null}
    </AccuracyAppShell>
  );
}
