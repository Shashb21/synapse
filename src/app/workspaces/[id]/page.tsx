import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { WorkspaceSettings } from "@/components/workspaces/workspace-settings";
import { WorkspacesFrame } from "@/components/workspaces/workspaces-frame";
import { currentSession } from "@/modules/auth/session";
import { principalOf } from "@/modules/workspaces/session";
import { getWorkspace, listMembers, memberRole } from "@/modules/workspaces/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Workspace settings · Synapse IEGP" };

export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?next=/workspaces`);
  const me = principalOf(session);
  const [workspace, role] = await Promise.all([getWorkspace(id), memberRole(id, me)]);
  if (!workspace || !role) notFound();
  const members = await listMembers(id);

  return (
    <WorkspacesFrame person={{ name: session.actor.name, email: session.email }}>
      <Link href="/workspaces" className="text-[12px] text-muted-foreground no-underline hover:text-foreground">
        ← All workspaces
      </Link>
      <h1 className="mb-6 mt-2 text-lg font-medium text-foreground">{workspace.name}</h1>
      <WorkspaceSettings
        workspace={{ id: workspace.id, name: workspace.name, role, created_at: workspace.created_at }}
        members={members}
        me={me.includes("@") ? me.toLowerCase() : me}
      />
    </WorkspacesFrame>
  );
}
