"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { rationaleError, sendJson } from "@/components/accuracy/claim-api";

export type CoverageOption = { id: string; statement: string; revision: string; evidence?: { block_id: string; quote: string }[] };

const OVERALLS = [
  { value: "full", label: "Full" },
  { value: "partial", label: "Partial" },
  { value: "limited", label: "Limited" },
  { value: "not_relevant", label: "Not relevant" },
  { value: "pending", label: "Pending" },
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
  gaps: CoverageOption[];
  tactics: CoverageOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [gapId, setGapId] = useState("");
  const [tacticId, setTacticId] = useState("");
  const [overall, setOverall] = useState<(typeof OVERALLS)[number]["value"]>("full");
  const [rationale, setRationale] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const availableEvidence = [...new Map([...(gaps.find(row => row.id === gapId)?.evidence ?? []), ...(tactics.find(row => row.id === tacticId)?.evidence ?? [])].map(span => [span.block_id, span])).values()];
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
      rationale, evidence: overall === "pending" ? [] : evidence,
      expected_gap_revision: gaps.find((row) => row.id === gapId)?.revision,
      expected_tactic_revision: tactics.find((row) => row.id === tacticId)?.revision,
    });
    setPending(false);
    if (!result.ok) {
      const detail = result.json.error;
      setError(detail && typeof detail === "object" && "message" in detail ? String(detail.message) : result.error);
      return;
    }
    setMessage(result.json.awaiting_approval ? "Saved successor awaiting assembly approval. Review it in the ledger’s Complete proposals." : `Saved: ${gapId} ↔ ${tacticId} · ${overall}`);
    setRationale("");
    if (!result.json.awaiting_approval) router.refresh();
  }

  if (gaps.length === 0 || tactics.length === 0) return null;

  return (
    <section className="mb-4 grid gap-2 border border-border bg-card p-3 rounded-lg" aria-labelledby="manual-pair">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="manual-pair" className="text-[12px] font-semibold text-foreground">
          Decide any pair
        </h2>
        <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Pick a pair"}
        </Button>
      </div>
      {message ? <p className="text-[11px] text-[var(--known-foreground)]">{message}</p> : null}
      {open ? (
        <form onSubmit={submit} className="grid gap-2" data-testid="coverage-manual-pair">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Gap
            <select aria-label="Gap" value={gapId} onChange={(e) => { setGapId(e.target.value); setEvidence([]); }} className={selectClass}>
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
              aria-label="Tactic"
              value={tacticId}
              onChange={(e) => { setTacticId(e.target.value); setEvidence([]); }}
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
          {availableEvidence.length > 0 && overall !== "pending" ? <fieldset className="grid gap-2 text-[12px]">
            <legend>Supporting source evidence</legend>
            {availableEvidence.map(span => <label key={span.block_id} className="flex gap-2">
              <input type="checkbox" checked={evidence.includes(span.block_id)} onChange={event => setEvidence(event.target.checked ? [...evidence, span.block_id] : evidence.filter(id => id !== span.block_id))} />
              Evidence: {span.quote}
            </label>)}
          </fieldset> : null}
          <Textarea
            aria-label="Coverage decision rationale (required)"
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
