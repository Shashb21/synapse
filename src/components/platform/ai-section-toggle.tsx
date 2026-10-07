"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AiSectionId } from "@/modules/kernel/ai-sections";

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
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_ai_section", section, enabled: !enabled }),
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
        aria-label={`AI for ${label}`}
        disabled={pending || disabled}
        onClick={flip}
        data-testid={`ai-section-${section}`}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-50 ${
          enabled ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform ${
            enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      {error ? <span className="text-[10px] text-destructive">{error}</span> : null}
    </div>
  );
}
