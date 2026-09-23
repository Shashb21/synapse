"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function SweepStaleRunsButton({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function sweep() {
    setMessage(null);
    startTransition(async () => {
      const res = await fetch("/api/accuracy/hygiene", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sweep_stale_runs", workspace_id: workspaceId }),
      });
      const body = (await res.json()) as { ok?: boolean; abandoned_ids?: string[]; error?: string };
      if (!res.ok || !body.ok) {
        setMessage(body.error ?? "Sweep failed");
        return;
      }
      setMessage(`${body.abandoned_ids?.length ?? 0} stale run(s) marked abandoned`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={sweep}
        className="border border-border bg-background px-2 py-1 text-[11px] text-foreground disabled:opacity-50"
      >
        {pending ? "Sweeping…" : "Sweep stale runs"}
      </button>
      {message ? <span className="text-[11px] text-muted-foreground">{message}</span> : null}
    </div>
  );
}
