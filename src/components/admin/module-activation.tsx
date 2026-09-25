"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Picks which registered module version a stage runs (owner only: /api/control activate_module). */
export function ModuleActivation({
  stage,
  activeId,
  options,
}: {
  stage: string;
  activeId: string | null;
  options: { id: string; version: string; title: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate(moduleId: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "activate_module", stage, module_id: moduleId }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Could not activate that module");
      return;
    }
    router.refresh();
  }

  if (options.length < 2) {
    return <span className="text-[11px] text-muted-foreground">Only one version registered.</span>;
  }
  return (
    <div className="grid gap-1">
      <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
        Active version
        <select
          className="h-7 rounded-md border border-border bg-background px-1 text-[12px] text-foreground"
          value={activeId ?? ""}
          disabled={busy}
          aria-label={`Active module for ${stage}`}
          onChange={(event) => void activate(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.id} v{option.version}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
