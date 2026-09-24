"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { rationaleError, sendJson } from "@/components/accuracy/claim-api";

type Option = { id: string; statement: string };

const OVERALLS = [
  { value: "covers", label: "Covers" },
  { value: "partial", label: "Partial" },
  { value: "none", label: "Does not cover" },
  { value: "unknown", label: "Unknown" },
] as const;

const selectClass =
  "h-8 w-full rounded-md border border-border bg-background px-2 text-[12px] text-foreground";

/** Decide coverage for ANY gap↔tactic pair — not only the queue's suggested pairs. */
export function CoverageManualPairForm({
  workspaceId,
  gaps,
  tactics,
}: {
  workspaceId: string;
  gaps: Option[];
  tactics: Option[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [gapId, setGapId] = useState("");
  const [tacticId, setTacticId] = useState("");
  const [overall, setOverall] = useState<(typeof OVERALLS)[number]["value"]>("covers");
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!gapId || !tacticId) {
      setError("Pick a gap and a tactic.");
      return;
    }
    const missing = rationaleError(rationale);
    if (missing) {
      setError(missing);
      return;
    }
    setPending(true);
    const result = await sendJson("/api/accuracy/coverage", "POST", {
      workspace_id: workspaceId,
      gap_id: gapId,
      tactic_id: tacticId,
      overall,
      rationale,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMessage(`Saved: ${gapId} ↔ ${tacticId} · ${overall}`);
    setRationale("");
    router.refresh();
  }

  if (gaps.length === 0 || tactics.length === 0) return null;

  return (
    <section className="mb-4 grid gap-2 border border-border bg-card/40 p-3" aria-labelledby="manual-pair">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="manual-pair" className="text-[13px] font-medium text-foreground">
          Decide any pair
        </h2>
        <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Pick a pair"}
        </Button>
      </div>
      {message ? <p className="text-[11px] text-[var(--known)]">{message}</p> : null}
      {open ? (
        <form onSubmit={submit} className="grid gap-2" data-testid="coverage-manual-pair">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Gap
            <select value={gapId} onChange={(e) => setGapId(e.target.value)} className={selectClass}>
              <option value="">Choose a gap…</option>
              {gaps.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.statement.slice(0, 100)} ({row.id})
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Tactic
            <select
              value={tacticId}
              onChange={(e) => setTacticId(e.target.value)}
              className={selectClass}
            >
              <option value="">Choose a tactic…</option>
              {tactics.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.statement.slice(0, 100)} ({row.id})
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-1 text-[11px] text-muted-foreground">Overall</legend>
            {OVERALLS.map((row) => (
              <Button
                key={row.value}
                type="button"
                size="sm"
                variant={overall === row.value ? "default" : "outline"}
                onClick={() => setOverall(row.value)}
              >
                {row.label}
              </Button>
            ))}
          </fieldset>
          <Textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={2}
            placeholder="Why this coverage decision (required)"
            className="text-[12px]"
          />
          {error ? (
            <p className="text-[11px] text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save decision"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
