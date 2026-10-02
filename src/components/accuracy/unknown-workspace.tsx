import Link from "next/link";
import { workspacePlanLabel } from "@/accuracy/domain/plan-label";

/** "Name · IEGP" for a lab workspace opened by URL (never its raw ID). */
export function workspaceLabel(workspace: { name: string; planning_context?: unknown }): string {
  const planLabel = workspacePlanLabel(workspace);
  return planLabel ? `${workspace.name} · ${planLabel}` : workspace.name;
}

/** Shown instead of a lab page's content when ?workspace_id= names no workspace. */
export function UnknownWorkspaceNotice({ workspaceId }: { workspaceId: string }) {
  return (
    <section
      className="grid gap-2 border border-destructive/40 bg-card p-3 rounded-lg"
      aria-labelledby="unknown-workspace"
      data-testid="accuracy-unknown-workspace"
    >
      <h2 id="unknown-workspace" className="text-[13px] font-semibold text-destructive">
        Unknown workspace
      </h2>
      <p className="text-[12px] text-muted-foreground">
        No lab workspace has the ID <code className="text-[11px]">{workspaceId}</code>. It may have been
        deleted. Choose one from{" "}
        <Link href="/admin/accuracy" className="text-foreground underline-offset-2 hover:underline">
          Workspaces
        </Link>
        .
      </p>
    </section>
  );
}
