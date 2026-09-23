"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function ArchiveWorkspaceButton(props: {
  workspaceId: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    const nextArchived = !props.archived;
    const label = nextArchived ? "Archive" : "Restore";
    if (!window.confirm(`${label} this workspace? Data is kept; it only soft-hides from lists.`)) {
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/accuracy/workspaces", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: props.workspaceId, archived: nextArchived }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Update failed");
        return;
      }
      router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
      >
        {pending ? "Updating…" : props.archived ? "Restore" : "Archive"}
      </button>
      {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
    </span>
  );
}
