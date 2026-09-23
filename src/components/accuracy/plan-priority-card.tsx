"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function PlanPriorityCard({
  workspaceId,
  claimId,
  statement,
  priority,
  validated,
}: {
  workspaceId: string;
  claimId: string;
  statement: string;
  priority: string | null;
  validated: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(priority ?? "medium");
  const [error, setError] = useState<string | null>(null);
  const [ideateTitle, setIdeateTitle] = useState("");
  const [ideateRationale, setIdeateRationale] = useState("");
  const [ideateMsg, setIdeateMsg] = useState<string | null>(null);

  const canIdeate =
    validated && (value === "high" || value === "critical" || priority === "high" || priority === "critical");

  function save(next: string) {
    setError(null);
    setIdeateMsg(null);
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

  function ideate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIdeateMsg(null);
    startTransition(async () => {
      const res = await fetch("/api/accuracy/ideate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          gap_id: claimId,
          title: ideateTitle.trim(),
          rationale: ideateRationale.trim(),
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; tactic_id?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Ideate failed");
        return;
      }
      setIdeateMsg(`Proposed tactic ${body.tactic_id}`);
      setIdeateTitle("");
      setIdeateRationale("");
      router.refresh();
    });
  }

  return (
    <article className="border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-foreground">{statement}</p>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {validated ? "validated" : "unvalidated"}
        </span>
      </div>
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

      {canIdeate ? (
        <form onSubmit={ideate} className="mt-3 grid gap-2 border-t border-border pt-3">
          <p className="text-[11px] text-muted-foreground">
            High + validated — propose a net-new tactic (mechanical stub; LLM when routed).
          </p>
          <input
            value={ideateTitle}
            onChange={(e) => setIdeateTitle(e.target.value)}
            placeholder="Proposed tactic title (min 8 chars)"
            minLength={8}
            required
            className="border border-border bg-background px-2 py-1.5 text-[12px]"
          />
          <input
            value={ideateRationale}
            onChange={(e) => setIdeateRationale(e.target.value)}
            placeholder="Why invent this (min 3 chars)"
            minLength={3}
            required
            className="border border-border bg-background px-2 py-1.5 text-[12px]"
          />
          <button
            type="submit"
            disabled={pending}
            className="w-fit border border-foreground bg-foreground px-3 py-1.5 text-[11px] text-background disabled:opacity-50"
          >
            {pending ? "Working…" : "Ideate tactic"}
          </button>
        </form>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Ideation unlocks when this gap is validated and set to high.
        </p>
      )}

      {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
      {ideateMsg ? <p className="mt-2 text-[12px] text-muted-foreground">{ideateMsg}</p> : null}
    </article>
  );
}
