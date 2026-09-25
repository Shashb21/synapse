import Link from "next/link";
import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { ADMIN_SECTIONS } from "@/components/admin/admin-nav";
import { adminWorkspaceName } from "@/components/admin/admin-workspace";
import { aiSwitch } from "@/modules/kernel/ai-switch";
import { stageHealth } from "@/modules/kernel/observability";
import { requireOwnerPage } from "@/modules/auth/owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminOverviewPage() {
  const access = await requireOwnerPage();
  const [workspaceName, ai, health] = await Promise.all([
    adminWorkspaceName(),
    aiSwitch().catch(() => null),
    stageHealth().catch(() => []),
  ]);
  const runs = health.reduce((sum, row) => sum + row.runs, 0);
  const errors = health.reduce((sum, row) => sum + row.errors, 0);

  return (
    <AdminMain>
      <PageIntro kicker={`Owner console · ${access.reason}`} title="Synapse Admin">
        The owner&apos;s control panel for testing and running the platform. Customers never see it. It
        shares the same database and stages as the app: pipeline, runs and evals read the workspace you
        have selected.
      </PageIntro>

      <dl className="mb-8 grid gap-3 sm:grid-cols-3">
        <div className="border border-border bg-card/40 p-3">
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
        <div className="border border-border bg-card/40 p-3">
          <dt className="text-[11px] text-muted-foreground">Workspace</dt>
          <dd className="mt-1 truncate text-[15px] text-foreground">{workspaceName}</dd>
          <dd className="mt-1 text-[11px]">
            <Link href="/workspaces" className="text-muted-foreground underline-offset-2 hover:underline">
              Switch workspace
            </Link>
          </dd>
        </div>
        <div className="border border-border bg-card/40 p-3">
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
          <li key={section.id} className="border border-border bg-card/40 p-3">
            <Link href={section.href} className="text-[13px] font-medium text-foreground no-underline hover:underline">
              {section.label}
            </Link>
            <p className="mt-1 text-[12px] text-muted-foreground">{section.summary}</p>
          </li>
        ))}
      </ul>
    </AdminMain>
  );
}
