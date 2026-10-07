import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { WorkshopStage } from "@/components/accuracy/workshop-stage";
import { registerAccuracyStack } from "@/accuracy";
import { getWorkspaceBySlug } from "@/accuracy/store/tenant";
import { latestWorkshopSnapshot } from "@/accuracy/store/workshop-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracySlugWorkshopPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireOwnerPage();
  const { slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    return (
      <div className="min-h-dvh bg-background p-8 text-foreground">
        <p className="text-[13px] text-destructive">Unknown workspace slug.</p>
        <Link href="/admin/accuracy" className="mt-4 inline-block text-[13px] underline-offset-2 hover:underline">
          Workspaces
        </Link>
      </div>
    );
  }
  const snapshot = await latestWorkshopSnapshot(workspace.id);
  if (!snapshot) {
    return (
      <div className="min-h-dvh bg-background p-8 text-foreground">
        <p className="text-2xl font-medium">No workshop snapshot yet.</p>
        <p className="mt-2 max-w-xl text-[15px] text-muted-foreground">
          Save state for workshop from Coverage after validate/map.
        </p>
        <Link
          href={`/admin/accuracy/coverage?workspace_id=${encodeURIComponent(workspace.id)}`}
          className="mt-6 inline-block border border-foreground px-4 py-2 text-[13px] no-underline"
        >
          Open Coverage
        </Link>
      </div>
    );
  }
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
