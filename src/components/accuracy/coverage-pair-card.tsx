"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { sendJson } from "./claim-api";

export type CoverageSuggestion = {
  overall: string; rationale: string | null; evidence: string[];
  run_id: string | null; freshness: string;
  mode?: string; confidence?: number;
};

export type CoveragePairCardModel = {
  id: string;
  gap_id: string;
  gap_statement: string;
  tactic_id: string;
  tactic_statement: string;
  suggestion?: CoverageSuggestion;
  overall: string | null;
  rationale: string | null;
  validated: boolean;
  gap_revision?: string; tactic_revision?: string; freshness?: string; validation_freshness?: string;
  assessment_state?: string; failure_reason?: string | null; pending_reason?: string | null; evidence?: string[]; protected?: boolean;
};

export function CoveragePairCard({
  workspaceId,
  pair, snapshot,
}: {
  workspaceId: string;
  pair: CoveragePairCardModel;
  snapshot?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rationale, setRationale] = useState(pair.rationale ?? "");
  const [rationaleEdited, setRationaleEdited] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seenRationale, setSeenRationale] = useState(pair.rationale);
  // Refresh untouched server text without replacing an in-progress human draft.
  if (seenRationale !== pair.rationale) {
    setSeenRationale(pair.rationale);
    if (!rationaleEdited && selectedSuggestion === null) setRationale(pair.rationale ?? "");
  }
  const suggestion = pair.suggestion;
  const suggestionKey = JSON.stringify([workspaceId, pair.gap_id, pair.tactic_id, pair.gap_revision, pair.tactic_revision, snapshot, suggestion]);
  const canUseSuggestion = Boolean(suggestion?.freshness === "current" && !pair.protected && !pair.validated);
  const usingSuggestion = selectedSuggestion === suggestionKey && canUseSuggestion;
  const suggestionChanged = selectedSuggestion !== null && !usingSuggestion;

  function useSuggestion() {
    if (!canUseSuggestion || !suggestion) return;
    setSelectedSuggestion(suggestionKey);
    if (!rationaleEdited) setRationale(suggestion.rationale ?? "");
  }
  function useManualDecision() {
    setSelectedSuggestion(null);
    if (!rationaleEdited) setRationale(pair.rationale ?? "");
  }
  function submit(next: "full" | "partial" | "limited" | "not_relevant" | "pending", reject = false) {
    if (suggestionChanged) return;
    setError(null);
    startTransition(async () => {
      const result = await sendJson("/api/accuracy/coverage", "POST", {
          workspace_id: workspaceId,
          gap_id: pair.gap_id,
          tactic_id: pair.tactic_id,
          overall: next,
          rationale, action: reject ? "reject" : "decide",
          expected_gap_revision: pair.gap_revision, expected_tactic_revision: pair.tactic_revision,
          evidence: reject || next === "pending" ? [] : usingSuggestion ? suggestion!.evidence : pair.evidence ?? [],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.json.awaiting_approval) setMessage("Successor awaiting assembly approval. Review the exact pair in the ledger’s Complete proposals.");
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
        Assessment: {pair.assessment_state ?? "pending"} · {pair.overall ?? "pending"} · {pair.freshness ?? "unknown"}. Validation: {pair.validated ? "current" : pair.validation_freshness ?? "unvalidated"}
      </p>
      {pair.failure_reason ? <p className="text-[12px] text-destructive">{pair.failure_reason}</p> : null}
      {pair.pending_reason === "missing_provenance" ? <p className="text-[12px] text-destructive">Missing factual source provenance. Supporting coverage remains pending.</p> : null}
      <p className="text-[11px] text-muted-foreground">{pair.evidence?.length ? <>Cited evidence: {pair.evidence.map((id, index) => <span key={id}>{index ? ", " : ""}<Link className="underline" href={`/admin/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId)}&block_id=${encodeURIComponent(id)}#${encodeURIComponent(id)}`}>{id}</Link></span>)}</> : "No cited evidence attached to this decision."}</p>
      {suggestion ? <div className="grid gap-2 border-t border-border pt-2 text-[12px]">
        <p>Model suggestion: {suggestion.overall} · {suggestion.freshness}</p>
        <p>{suggestion.rationale}</p>
        {suggestion.mode ? <p className="text-muted-foreground">Assist ({suggestion.mode}){suggestion.confidence !== undefined ? ` · confidence ${suggestion.confidence.toFixed(2)}` : ""}</p> : null}
        <p>Suggested evidence: {suggestion.evidence.length ? suggestion.evidence.map((id, index) => <span key={id}>{index ? ", " : ""}<Link className="underline" href={`/admin/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId)}&block_id=${encodeURIComponent(id)}#${encodeURIComponent(id)}`}>{id}</Link></span>) : "None cited"}</p>
        {suggestion.freshness !== "current" ? <p className="text-destructive">This suggestion is stale. Reassess before using its rationale or evidence.</p> : null}
        <button type="button" disabled={!canUseSuggestion || pending} onClick={useSuggestion}
          className="justify-self-start border border-border px-2 py-1 text-[11px] disabled:opacity-40 hover:bg-muted/40">Use suggestion</button>
      </div> : null}
      {usingSuggestion ? <p className="text-[12px] text-muted-foreground">Suggestion evidence selected. Review the rationale and choose a decision below.</p> : null}
      {suggestionChanged ? <p role="alert" className="text-[12px] text-destructive">The selected suggestion changed. Review a current suggestion or continue with a manual decision.</p> : null}
      {selectedSuggestion !== null ? <button type="button" onClick={useManualDecision}
        className="justify-self-start text-[11px] underline">Use manual decision</button> : null}
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Rationale (required)</span>
        <textarea
          className="min-h-16 border border-border bg-background px-2 py-1.5 text-[12px]"
          value={rationale}
          onChange={(e) => { setRationale(e.target.value); setRationaleEdited(true); }}
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
            disabled={pending || suggestionChanged || rationale.trim().length < 3}
            onClick={() => submit(value)}
            className="border border-border px-2 py-1 text-[11px] capitalize text-foreground disabled:opacity-40 hover:bg-muted/40"
          >
            {value.replaceAll("_", " ")}
          </button>
        ))}
        <button type="button" disabled={pending || suggestionChanged || rationale.trim().length < 3} onClick={() => submit("pending", true)}
          className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-40 hover:bg-muted/40">
          Reject pair
        </button>
      </div>
    </article>
  );
}
