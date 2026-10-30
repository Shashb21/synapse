"use client";

import type { AiSectionId } from "@/modules/kernel/ai-sections";
import { useAiSwitchSave } from "@/components/platform/use-ai-switch-save";

/** One section's AI switch for every customer (KAN-53). One click, no reason to type. */
export function AiSectionToggle({
  section,
  label,
  enabled,
  disabled = false,
}: {
  section: AiSectionId;
  label: string;
  enabled: boolean;
  /** The master switch is off: the section keeps its setting but cannot run. */
  disabled?: boolean;
}) {
  const save = useAiSwitchSave({
    enabled,
    scope: label,
    body: { action: "set_ai_section", section },
    disabled,
    readEnabled: json => (json as { ai_sections?: Record<string, unknown> } | null)?.ai_sections?.[section],
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={save.enabled}
        aria-describedby={`${save.feedbackId}-status ${save.feedbackId}-error`}
        aria-busy={save.pending}
        aria-label={`AI for ${label}`}
        disabled={save.pending || disabled}
        onClick={save.flip}
        data-testid={`ai-section-${section}`}
        className="inline-flex h-11 w-11 shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
      >
        <span aria-hidden className={`inline-flex h-6 w-11 items-center rounded-full border border-input transition-colors ${save.enabled ? "bg-primary" : "bg-muted"}`}>
          <span className={`inline-block size-4 rounded-full bg-primary-foreground transition-transform motion-reduce:transition-none ${save.enabled ? "translate-x-6" : "translate-x-1"}`} />
        </span>
      </button>
      <p id={`${save.feedbackId}-status`} role="status" aria-live="polite" aria-atomic="true" className="max-w-64 text-right text-xs text-muted-foreground">{save.status}</p>
      <p id={`${save.feedbackId}-error`} role="alert" aria-atomic="true" className="max-w-64 text-right text-sm text-destructive">{save.error}</p>
    </div>
  );
}
