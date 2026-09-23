"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type CoveragePairCardModel = {
  id: string;
  gap_id: string;
  gap_statement: string;
  tactic_id: string;
  tactic_statement: string;
  overall: string | null;
  rationale: string | null;
  validated: boolean;
  tactic_start?: string | null;
  tactic_end?: string | null;
};

export function CoveragePairCard({
  workspaceId,
  pair,
}: {
  workspaceId: string;
  pair: CoveragePairCardModel;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rationale, setRationale] = useState(pair.rationale ?? "");
  const [overall, setOverall] = useState(pair.overall ?? "unknown");
  const [start, setStart] = useState(pair.tactic_start ?? "");
  const [end, setEnd] = useState(pair.tactic_end ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit(next: "covers" | "partial" | "none" | "unknown") {
    setError(null);
    const startTrim = start.trim();
    const endTrim = end.trim();
    if ((startTrim && !endTrim) || (!startTrim && endTrim)) {
      setError("Provide both start and end as YYYY-MM-DD, or leave both blank.");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/accuracy/coverage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          gap_id: pair.gap_id,
          tactic_id: pair.tactic_id,
          overall: next,
          rationale,
          ...(startTrim && endTrim ? { start: startTrim, end: endTrim } : {}),
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Save failed");
        return;
      }
      setOverall(next);
      router.refresh();
    });
  }

  return (
    <article className="grid gap-3 border border-border bg-card/40 p-3">
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Gap</p>
          <p className="text-[13px] text-foreground">{pair.gap_statement}</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{pair.gap_id}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Tactic</p>
          <p className="text-[13px] text-foreground">{pair.tactic_statement}</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{pair.tactic_id}</p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Status: {pair.validated ? `decided · ${overall}` : "undecided"}
      </p>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Rationale (required)</span>
        <textarea
          className="min-h-16 border border-border bg-background px-2 py-1.5 text-[12px]"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why this coverage overall?"
        />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[12px]">
          <span className="text-muted-foreground">Tactic start (Gantt)</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="border border-border bg-background px-2 py-1.5 text-[12px]"
          />
        </label>
        <label className="grid gap-1 text-[12px]">
          <span className="text-muted-foreground">Tactic end (Gantt)</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="border border-border bg-background px-2 py-1.5 text-[12px]"
          />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Dates are optional on decide; when set they write onto the tactic and project into Timeline.
      </p>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {(["covers", "partial", "none", "unknown"] as const).map((value) => (
          <button
            key={value}
            type="button"
            disabled={pending || rationale.trim().length < 3}
            onClick={() => submit(value)}
            className="border border-border px-2 py-1 text-[11px] capitalize text-foreground disabled:opacity-40 hover:bg-muted/40"
          >
            {value}
          </button>
        ))}
      </div>
    </article>
  );
}
