"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/post-json";

export type PickerWorkspace = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  demo: boolean;
  /** Client demo mode (KAN-138): AI steps replay the recorded run. */
  demo_mode?: boolean;
  member_count: number;
};

/**
 * Every customer workspace, for the owner to choose the one the console's
 * pipeline, runs and evals work in (KAN-62). Choosing returns to `next`.
 */
export function AdminWorkspacePicker({
  workspaces,
  currentId,
  next,
}: {
  workspaces: PickerWorkspace[];
  currentId: string;
  next: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setDemoMode(workspace: PickerWorkspace, enabled: boolean) {
    if (
      enabled &&
      !window.confirm(
        `Turn on client demo mode for ${workspace.name}? Its contents are replaced with the demo starting point (setup done, no sources), and every AI step replays the recorded demo run instead of calling a model.`,
      )
    )
      return;
    setBusy(`demo:${workspace.id}`);
    setError(null);
    try {
      const res = await postJson("/api/admin/workspace/demo-mode", { workspace_id: workspace.id, enabled });
      const json = res.json as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `Could not change demo mode (HTTP ${res.status}).`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change demo mode.");
    } finally {
      setBusy(null);
    }
  }

  async function choose(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson("/api/admin/workspace", { workspace_id: id, next });
      const json = res.json as { error?: string; redirect?: string };
      if (!res.ok) throw new Error(json.error ?? `Could not open that workspace (HTTP ${res.status}).`);
      router.push(json.redirect ?? "/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that workspace.");
      setBusy(null);
    }
  }

  if (workspaces.length === 0) {
    return <p className="text-body text-muted-foreground">There are no workspaces yet.</p>;
  }

  return (
    <div className="grid gap-3">
      {error ? (
        <p role="alert" data-testid="admin-workspace-error" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-callout text-destructive rounded-lg">
          {error}
        </p>
      ) : null}
      <div className="overflow-x-auto border border-border bg-card rounded-lg">
        <table className="w-full text-body" data-testid="admin-workspace-list">
          <thead className="text-caption text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-normal">Workspace</th>
              <th className="px-3 py-2 text-left font-normal">Id</th>
              <th className="px-3 py-2 text-left font-normal">Created by</th>
              <th className="px-3 py-2 text-right font-normal">Members</th>
              <th className="px-3 py-2 text-left font-normal">Client demo mode</th>
              <th className="px-3 py-2 text-right font-normal" aria-label="Choose" />
            </tr>
          </thead>
          <tbody className="text-foreground">
            {workspaces.map((workspace) => {
              const current = workspace.id === currentId;
              return (
                <tr key={workspace.id} className="border-b border-border/60 last:border-0" data-testid={`admin-workspace-${workspace.id}`}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{workspace.name}</span>
                    {workspace.demo ? (
                      <Badge variant="secondary" className="ml-2 text-caption">
                        Demo
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-callout text-muted-foreground">{workspace.id}</td>
                  <td className="px-3 py-2 text-muted-foreground">{workspace.created_by}</td>
                  <td className="px-3 py-2 text-right">{workspace.member_count}</td>
                  <td className="px-3 py-2">
                    <label className="inline-flex items-center gap-1.5 text-callout">
                      <input
                        type="checkbox"
                        data-testid={`demo-mode-${workspace.id}`}
                        aria-label={`Client demo mode for ${workspace.name}`}
                        checked={workspace.demo_mode === true}
                        disabled={busy !== null}
                        onChange={(event) => void setDemoMode(workspace, event.target.checked)}
                      />
                      {busy === `demo:${workspace.id}` ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                      {workspace.demo_mode ? "On" : "Off"}
                    </label>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {current ? (
                      <span className="inline-flex items-center gap-1 text-callout text-[var(--known-foreground)]">
                        <Check className="size-3.5" aria-hidden />
                        Working here
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void choose(workspace.id)}>
                        {busy === workspace.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                        Work in this one
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
