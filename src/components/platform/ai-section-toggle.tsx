"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AiSectionId } from "@/modules/kernel/ai-sections";
import { postJson } from "@/lib/post-json";

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
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip() {
    setError(null);
    startTransition(async () => {
      const res = await postJson("/api/control", { action: "set_ai_section", section, enabled: !enabled });
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
        aria-label={`AI for ${label}`}
        disabled={pending || disabled}
        onClick={flip}
        data-testid={`ai-section-${section}`}
        className="inline-flex h-11 w-11 shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
      >
        <span aria-hidden className={`inline-flex h-6 w-11 items-center rounded-full border border-input transition-colors ${enabled ? "bg-primary" : "bg-muted"}`}>
          <span className={`inline-block size-4 rounded-full bg-primary-foreground transition-transform motion-reduce:transition-none ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </span>
      </button>
      {error ? <span role="alert" className="text-sm text-destructive">{error}</span> : null}
    </div>
  );
}
