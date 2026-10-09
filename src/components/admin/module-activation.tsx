"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

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
    // finally re-enables the picker even when the request itself throws (offline, aborted).
    try {
      const res = await postJson("/api/control", { action: "activate_module", stage, module_id: moduleId });
      const json = res.json as { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Could not activate that module");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? `Could not activate that module: ${err.message}` : "Could not activate that module");
    } finally {
      setBusy(false);
    }
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
      {error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
