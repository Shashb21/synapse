import { requireOwnerPage } from "@/modules/auth/owner";
/** Read-only entry point for source-scoped experiment results. */
import { AccuracyAppShell } from "@/components/accuracy-app-shell";
import { ExperimentResults } from "@/components/accuracy/experiment-results";

/** Show an explicit source workspace selector and its authorized results report. */
export default async function AccuracyExperimentsPage({ searchParams }: {
  searchParams: Promise<{ workspace_id?: string | string[] }>;
}) {
  await requireOwnerPage();
  const params = await searchParams;
  const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id.trim() : "";
  return <AccuracyAppShell active="experiments">
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Experiment results</h1>
      <form action="/admin/accuracy/experiments" method="get" className="flex flex-wrap items-end gap-2">
        <label htmlFor="experiment-workspace" className="grid gap-1 text-sm">Source workspace ID
          <input id="experiment-workspace" name="workspace_id" required defaultValue={workspaceId} className="min-w-64 rounded-md border border-border bg-background px-2 py-1.5 text-foreground" />
        </label>
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card">View results</button>
      </form>
      <ExperimentResults workspaceId={workspaceId} />
    </div>
  </AccuracyAppShell>;
}
