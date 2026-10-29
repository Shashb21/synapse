"use client";

/** Accessible server refresh feedback; refresh merges confirmed data without remounting forms. */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Retry unavailable reads and announce only a new server response as successful recovery. */
export function ConfigurationRecovery({ loadId, unavailable }: { loadId: string; unavailable: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requestedFrom, setRequestedFrom] = useState<string | null>(null);
  const failed = unavailable.length > 0;
  const notice = requestedFrom === null ? "" : pending
    ? "Reloading saved configuration…"
    : requestedFrom !== loadId && !failed
      ? "Configuration refreshed. Saved settings are available."
      : "Configuration is still unavailable. Your unsaved route edits have been kept. Retry again.";

  function retry() {
    setRequestedFrom(loadId);
    startTransition(() => router.refresh());
  }

  return (
    <div className="grid gap-2" aria-label="Configuration recovery">
      {failed ? <p className="text-sm text-[var(--unknown-foreground)]">
        Configuration unavailable: {unavailable.join(", ")}. Confirmed settings remain visible. Affected changes are disabled until the saved settings can be read.
      </p> : null}
      <div><Button variant="outline" className="min-h-11" disabled={pending} onClick={retry}>
        {pending ? "Retrying…" : failed ? "Retry configuration" : "Refresh configuration"}
      </Button></div>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">{notice}</p>
    </div>
  );
}
