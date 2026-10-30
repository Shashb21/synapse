"use client";

import { useAiSwitchSave } from "@/components/platform/use-ai-switch-save";

/** One click flips the platform master switch for every workspace. No dialog and no reason to type. */
export function AiToggle({ enabled, actorName }: { enabled: boolean; actorName: string }) {
  const save = useAiSwitchSave({
    enabled,
    scope: "all workspaces",
    body: { action: "set_ai_enabled", actor_name: actorName },
    readEnabled: json => (json as { ai?: { enabled?: unknown } } | null)?.ai?.enabled,
  });

  const status = save.status.endsWith("Saved.")
    ? `${save.status} ${save.enabled
      ? "Saved section preferences still apply; availability depends on configured providers."
      : "All customers can continue manual flows. Use this switch to turn AI back on."}`
    : save.status;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={save.enabled}
        aria-describedby={`${save.feedbackId}-status ${save.feedbackId}-error`}
        aria-busy={save.pending}
        aria-label="AI for all workspaces (master switch)"
        disabled={save.pending}
        onClick={save.flip}
        data-testid="ai-toggle"
        className="inline-flex h-11 w-11 shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
      >
        <span aria-hidden className={`inline-flex h-6 w-11 items-center rounded-full border border-input transition-colors ${save.enabled ? "bg-foreground" : "bg-muted"}`}>
          <span className={`inline-block size-4 rounded-full bg-background transition-transform motion-reduce:transition-none ${save.enabled ? "translate-x-6" : "translate-x-1"}`} />
        </span>
      </button>
      <p id={`${save.feedbackId}-status`} role="status" aria-live="polite" aria-atomic="true" className="max-w-64 text-right text-xs text-muted-foreground">{status}</p>
      <p id={`${save.feedbackId}-error`} role="alert" aria-atomic="true" className="max-w-64 text-right text-sm text-destructive">{save.error}</p>
    </div>
  );
}
