"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function PlanPriorityCard({
  workspaceId,
  claimId,
  statement,
  priority,
}: {
  workspaceId: string;
  claimId: string;
  statement: string;
  priority: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(priority ?? "medium");
  const [error, setError] = useState<string | null>(null);

  function save(next: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/accuracy/claims/priority", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          claim_id: claimId,
          priority: next,
          rationale: `Set priority band to ${next}`,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Update failed");
        return;
      }
      setValue(next);
      router.refresh();
    });
  }

  return (
    <article className="border border-border bg-card/40 p-3">
      <p className="text-[13px] text-foreground">{statement}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">{claimId}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(["high", "medium", "low"] as const).map((band) => (
          <button
            key={band}
            type="button"
            disabled={pending}
            onClick={() => save(band)}
            className={`border px-2 py-1 text-[11px] capitalize ${
              value === band
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground hover:bg-muted/40"
            }`}
          >
            {band}
          </button>
        ))}
      </div>
      {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
    </article>
  );
}
