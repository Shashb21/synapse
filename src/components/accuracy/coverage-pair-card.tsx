"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { sendJson } from "./claim-api";

export type CoveragePairCardModel = {
  id: string;
  gap_id: string;
  gap_statement: string;
  tactic_id: string;
  tactic_statement: string;
  overall: string | null;
  rationale: string | null;
  validated: boolean;
  gap_revision?: string; tactic_revision?: string; freshness?: string; validation_freshness?: string;
  assessment_state?: string; failure_reason?: string | null; pending_reason?: string | null; evidence?: string[]; protected?: boolean;
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
  const [overall, setOverall] = useState(pair.overall ?? "pending");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(next: "full" | "partial" | "limited" | "not_relevant" | "pending", reject = false) {
    setError(null);
    startTransition(async () => {
      const result = await sendJson("/api/accuracy/coverage", "POST", {
          workspace_id: workspaceId,
          gap_id: pair.gap_id,
          tactic_id: pair.tactic_id,
          overall: next,
          rationale, action: reject ? "reject" : "decide",
          expected_gap_revision: pair.gap_revision, expected_tactic_revision: pair.tactic_revision,
          evidence: reject ? [] : pair.evidence ?? [],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.json.awaiting_approval) setMessage("Successor awaiting assembly approval. Review the exact pair in the ledger’s Complete proposals.");
      else setOverall(next);
      if (!result.json.awaiting_approval) router.refresh();
    });
  }

  return (
    <article className="grid gap-3 border border-border bg-card p-3 rounded-lg">
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
        Assessment: {pair.assessment_state ?? "pending"} · {overall} · {pair.freshness ?? "unknown"}. Validation: {pair.validated ? "current" : pair.validation_freshness ?? "unvalidated"}
      </p>
      {pair.failure_reason ? <p className="text-[12px] text-destructive">{pair.failure_reason}</p> : null}
      {pair.pending_reason === "missing_provenance" ? <p className="text-[12px] text-destructive">Missing factual source provenance. Supporting coverage remains pending.</p> : null}
      <p className="text-[11px] text-muted-foreground">{pair.evidence?.length ? <>Cited evidence: {pair.evidence.map((id, index) => <span key={id}>{index ? ", " : ""}<Link className="underline" href={`/admin/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId)}&block_id=${encodeURIComponent(id)}#${encodeURIComponent(id)}`}>{id}</Link></span>)}</> : "No cited evidence attached to this decision."}</p>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Rationale (required)</span>
        <textarea
          className="min-h-16 border border-border bg-background px-2 py-1.5 text-[12px]"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why this coverage overall?"
        />
      </label>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert" className="text-[12px] text-destructive">{error} Retry this decision; your rationale is retained.</p> : null}
      <div className="flex flex-wrap gap-2">
        {(["full", "partial", "limited", "not_relevant", "pending"] as const).map((value) => (
          <button
            key={value}
            type="button"
            disabled={pending || rationale.trim().length < 3}
            onClick={() => submit(value)}
            className="border border-border px-2 py-1 text-[11px] capitalize text-foreground disabled:opacity-40 hover:bg-muted/40"
          >
            {value.replaceAll("_", " ")}
          </button>
        ))}
        <button type="button" disabled={pending || rationale.trim().length < 3} onClick={() => submit("pending", true)}
          className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-40 hover:bg-muted/40">
          Reject pair
        </button>
      </div>
    </article>
  );
}
