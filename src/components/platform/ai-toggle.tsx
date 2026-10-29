"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { postJson } from "@/lib/post-json";

/** One click flips the platform master switch for every workspace. No dialog and no reason to type. */
export function AiToggle({ enabled, actorName }: { enabled: boolean; actorName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip() {
    setError(null);
    startTransition(async () => {
      const res = await postJson("/api/control", { action: "set_ai_enabled", enabled: !enabled, actor_name: actorName });
      if (!res.ok) {
        setError((res.json as { error?: string }).error ?? "Could not change AI.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="AI for all workspaces (master switch)"
        disabled={pending}
        onClick={flip}
        data-testid="ai-toggle"
        className="inline-flex h-11 w-11 shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
      >
        <span aria-hidden className={`inline-flex h-6 w-11 items-center rounded-full border border-input transition-colors ${enabled ? "bg-foreground" : "bg-muted"}`}>
          <span className={`inline-block size-4 rounded-full bg-background transition-transform motion-reduce:transition-none ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </span>
      </button>
      {error ? <p role="alert" className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
