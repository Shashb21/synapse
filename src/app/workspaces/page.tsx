import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WorkspacesFrame } from "@/components/workspaces/workspaces-frame";
import { WorkspacesView } from "@/components/workspaces/workspaces-view";
import { safeNext } from "@/modules/auth/redirect";
import { selectedWorkspaceId } from "@/modules/workspaces/context";
import { myWorkspaces } from "@/modules/workspaces/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Workspaces · Synapse IEGP" };

/** After sign-in: create your first workspace, or open one you already have. */
export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; next?: string }>;
}) {
  const params = await searchParams;
  const mine = await myWorkspaces();
  if (!mine) redirect("/login?next=/workspaces");
  const selected = await selectedWorkspaceId().catch(() => null);

  return (
    <WorkspacesFrame person={{ name: mine.session.actor.name, email: mine.session.email }}>
      <div className="mb-6">
        <h1 className="text-lg font-medium text-foreground">Workspaces</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Each workspace holds one plan — its sources, gaps, tactics and timeline — shared with the people you invite.
        </p>
      </div>
      <WorkspacesView
        workspaces={mine.workspaces.map(({ id, name, role, created_at }) => ({ id, name, role, created_at }))}
        currentId={mine.workspaces.some((ws) => ws.id === selected) ? selected : null}
        startCreating={params.new === "1"}
        next={safeNext(params.next)}
      />
    </WorkspacesFrame>
  );
}
