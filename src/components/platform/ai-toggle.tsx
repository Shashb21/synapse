"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** One click flips AI for everyone. No dialog and no reason to type. */
export function AiToggle({ enabled, actorName }: { enabled: boolean; actorName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip() {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_ai_enabled", enabled: !enabled, actor_name: actorName }),
      });
      if (!res.ok) {
        setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not change AI.");
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
        aria-label="AI"
        disabled={pending}
        onClick={flip}
        data-testid="ai-toggle"
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-60 ${
          enabled ? "bg-foreground" : "bg-muted"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-background transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
