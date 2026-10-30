"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { postJson } from "@/lib/post-json";

type HygieneAction = "archive_workspace" | "unarchive_workspace" | "delete_workspace";

export function WorkspaceHygieneActions({
  workspaceId,
  workspaceName,
  archived,
}: {
  workspaceId: string;
  workspaceName: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [checkRequired, setCheckRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(action: HygieneAction) {
    if (pending || checkRequired) return;
    if (action === "delete_workspace") {
      const ok = window.confirm(
        `Permanently delete “${workspaceName}”? This removes sources, parse blocks, claims, miss flags, runs, and plans. The org is removed if it has no other workspaces.`,
      );
      if (!ok) return;
    }
    setError(null);
    startTransition(async () => {
      const res = await postJson("/api/accuracy/hygiene", { action, workspace_id: workspaceId });
      const body = res.json as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setCheckRequired(res.outcome === "unknown");
        setError(body.error ?? "We couldn’t confirm this workspace change. Reload the workspace list before repeating it.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {archived ? (
        <button
          type="button"
          disabled={pending || checkRequired}
          onClick={() => run("unarchive_workspace")}
          className="border border-border bg-background px-2 py-1 text-[11px] text-foreground disabled:opacity-50"
        >
          {pending ? "Working…" : "Unarchive"}
        </button>
      ) : (
        <button
          type="button"
          disabled={pending || checkRequired}
          onClick={() => run("archive_workspace")}
          className="border border-border bg-background px-2 py-1 text-[11px] text-foreground disabled:opacity-50"
        >
          {pending ? "Working…" : "Archive"}
        </button>
      )}
      <button
        type="button"
        disabled={pending || checkRequired}
        onClick={() => run("delete_workspace")}
        className="border border-destructive/40 bg-background px-2 py-1 text-[11px] text-destructive disabled:opacity-50"
      >
        Delete
      </button>
      {checkRequired ? <button type="button" className="underline text-sm" onClick={() => window.location.reload()}>Check workspace list</button> : null}
      {error ? <span role="alert" className="text-sm text-destructive">{error}</span> : null}
    </div>
  );
}
