import Link from "next/link";
import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { ADMIN_SECTIONS, ADMIN_WORKSPACE_PICKER } from "@/components/admin/admin-nav";
import { aiSwitch } from "@/modules/kernel/ai-switch";
import { stageHealth } from "@/modules/kernel/observability";
import { requireOwnerPage } from "@/modules/auth/owner";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminOverviewPage() {
  const access = await requireOwnerPage();
  const [{ name: workspaceName, health }, ai] = await Promise.all([
    withAdminWorkspace(async (workspace) => ({ name: workspace.name, health: await stageHealth().catch(() => []) })),
    aiSwitch().catch(() => null),
  ]);
  const runs = health.reduce((sum, row) => sum + row.runs, 0);
  const errors = health.reduce((sum, row) => sum + row.errors, 0);

  return (
    <AdminMain>
      <PageIntro kicker={`Owner console · ${access.reason}`} title="Synapse Admin">
        The owner&apos;s control panel for testing and running the platform. Customers never see it. It
        shares the same database and stages as the app: pipeline, runs and evals read the workspace you
        choose with Switch workspace, which can be any customer workspace.
      </PageIntro>

      <dl className="mb-8 grid gap-3 sm:grid-cols-3">
        <div className="border border-border bg-card p-3 rounded-lg">
          <dt className="text-[11px] text-muted-foreground">AI</dt>
          <dd className="mt-1 text-[15px] text-foreground" data-testid="admin-ai-state">
            {ai === null ? "unknown" : ai.enabled ? "On" : "Off"}
          </dd>
          <dd className="mt-1 text-[11px]">
            <Link href="/admin/control" className="text-muted-foreground underline-offset-2 hover:underline">
              Switch it in AI &amp; routing
            </Link>
          </dd>
        </div>
        <div className="border border-border bg-card p-3 rounded-lg">
          <dt className="text-[11px] text-muted-foreground">Workspace</dt>
          <dd className="mt-1 truncate text-[15px] text-foreground">{workspaceName}</dd>
          <dd className="mt-1 text-[11px]">
            <Link href={ADMIN_WORKSPACE_PICKER} className="text-muted-foreground underline-offset-2 hover:underline">
              Switch workspace
            </Link>
          </dd>
        </div>
        <div className="border border-border bg-card p-3 rounded-lg">
          <dt className="text-[11px] text-muted-foreground">Stage runs in this workspace</dt>
          <dd className="mt-1 text-[15px] text-foreground">
            {runs} {errors > 0 ? <span className="text-[12px] text-destructive">· {errors} errors</span> : null}
          </dd>
          <dd className="mt-1 text-[11px]">
            <Link href="/admin/runs" className="text-muted-foreground underline-offset-2 hover:underline">
              Open runs &amp; traces
            </Link>
          </dd>
        </div>
      </dl>

      <ul className="grid gap-2 md:grid-cols-2">
        {ADMIN_SECTIONS.filter((section) => section.id !== "overview").map((section) => (
          <li key={section.id} className="border border-border bg-card p-3 rounded-lg">
            <Link href={section.href} className="text-[12px] font-semibold text-foreground no-underline hover:underline">
              {section.label}
            </Link>
            <p className="mt-1 text-[12px] text-muted-foreground">{section.summary}</p>
          </li>
        ))}
      </ul>
    </AdminMain>
  );
}
