import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { CreateWorkspaceForm } from "@/components/accuracy/create-workspace-form";
import { SeedFromGoldForm } from "@/components/accuracy/seed-from-gold-form";
import { registerAccuracyStack } from "@/accuracy";
import { listWorkspaces } from "@/accuracy/store/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyWorkspacesPage() {
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let loadError: string | null = null;
  try {
    workspaces = await listWorkspaces();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load workspaces";
  }

  return (
    <AccuracyAppShell active="workspaces">
      <PageIntro kicker="Tenancy · org → workspace" title="Workspaces">
        One workspace maps to one IEGP. Seed from BeOne gold for a full demo ledger, or create an empty
        workspace and upload sources.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <SeedFromGoldForm />
        <CreateWorkspaceForm />
      </div>

      <section className="grid gap-2" aria-labelledby="workspace-list">
        <h2 id="workspace-list" className="text-[15px] font-medium text-foreground">
          Registered workspaces
        </h2>
        {workspaces.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No workspaces yet. Seed from gold or create one above.
          </p>
        ) : (
          <ul className="grid gap-2">
            {workspaces.map((workspace) => (
              <li key={workspace.id} className="border border-border bg-card/40 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] font-medium text-foreground">{workspace.name}</p>
                  <span className="text-[11px] text-muted-foreground">{workspace.slug}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {workspace.id} · org {workspace.org_id}
                </p>
                <p className="mt-2 flex flex-wrap gap-3">
                  <Link
                    href={`/accuracy/sources?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="text-[12px] text-foreground underline-offset-2 hover:underline"
                  >
                    Sources
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </AccuracyAppShell>
  );
}
