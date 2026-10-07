"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  CoveragePairCard,
  type CoveragePairCardModel,
} from "@/components/accuracy/coverage-pair-card";
import { useAiEnabled } from "@/components/platform/ai-status";

type AssistSuggestion = {
  overall: "covers" | "partial" | "none" | "unknown";
  schema_overall: string;
  rationale: string;
  confidence: number;
  quote_block_ids: string[];
};

/**
 * One-pair-at-a-time coverage queue. Undecided pairs first; optional LLM suggest
 * fills the active card without auto-saving.
 */
export function CoverageQueue({
  workspaceId,
  pairs,
}: {
  workspaceId: string;
  pairs: CoveragePairCardModel[];
}) {
  const router = useRouter();
  const undecided = useMemo(() => pairs.filter((p) => !p.validated), [pairs]);
  const decided = useMemo(() => pairs.filter((p) => p.validated), [pairs]);
  const [index, setIndex] = useState(0);
  const aiOn = useAiEnabled();
  const [assistPending, startAssist] = useTransition();
  const [assistError, setAssistError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<AssistSuggestion | null>(null);
  const [assistMode, setAssistMode] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  // Reset the cursor and any suggestion when the queue changes (adjust during
  // render rather than in an effect, so there is no cascading re-render).
  const queueKey = `${workspaceId}:${undecided.length}`;
  const [seenQueueKey, setSeenQueueKey] = useState(queueKey);
  if (seenQueueKey !== queueKey) {
    setSeenQueueKey(queueKey);
    setIndex((i) => (undecided.length === 0 ? 0 : Math.min(i, undecided.length - 1)));
    setSuggestion(null);
    setAssistError(null);
    setAssistMode(null);
  }

  const current = undecided[index] ?? null;
  const progressLabel =
    undecided.length === 0
      ? `All ${decided.length} pair(s) decided`
      : `Pair ${index + 1} of ${undecided.length} undecided · ${decided.length} decided`;

  function requestAssist() {
    if (!current) return;
    setAssistError(null);
    setSuggestion(null);
    startAssist(async () => {
      const res = await fetch("/api/accuracy/coverage/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          gap_id: current.gap_id,
          tactic_id: current.tactic_id,
        }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        mode?: string;
        suggestion?: AssistSuggestion;
      };
      if (!res.ok || !body.ok || !body.suggestion) {
        setAssistError(body.error ?? "Assist failed");
        return;
      }
      setSuggestion(body.suggestion);
      setAssistMode(body.mode ?? null);
    });
  }

  function goNext() {
    setSuggestion(null);
    setAssistError(null);
    setAssistMode(null);
    if (index + 1 < undecided.length) {
      setIndex(index + 1);
    } else {
      router.refresh();
    }
  }

  function goPrev() {
    setSuggestion(null);
    setAssistError(null);
    setAssistMode(null);
    setIndex(Math.max(0, index - 1));
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">{progressLabel}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!current || index === 0}
            onClick={goPrev}
            className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-40 hover:bg-muted/40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!current || index + 1 >= undecided.length}
            onClick={goNext}
            className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-40 hover:bg-muted/40"
          >
            Skip / next
          </button>
          {aiOn ? (
            <button
              type="button"
              disabled={!current || assistPending}
              onClick={requestAssist}
              className="border border-border bg-muted/30 px-2 py-1 text-[11px] text-foreground disabled:opacity-40 hover:bg-muted/50"
            >
              {assistPending ? "Suggesting…" : "Suggest with LLM"}
            </button>
          ) : null}
        </div>
      </div>
      {!aiOn ? (
        <p className="text-[11px] text-muted-foreground" data-testid="coverage-ai-off">
          AI is off — no suggestions. Pick an overall and write the rationale yourself below.
        </p>
      ) : null}

      {assistError ? <p className="text-[12px] text-destructive">{assistError}</p> : null}
      {suggestion && current ? (
        <p className="border border-border/60 bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
          Assist ({assistMode ?? "—"}) · {suggestion.schema_overall} → {suggestion.overall} · conf{" "}
          {suggestion.confidence.toFixed(2)}
          {suggestion.quote_block_ids.length
            ? ` · quotes ${suggestion.quote_block_ids.join(", ")}`
            : ""}
          . Review and confirm with a decide button — nothing is saved until you confirm.
        </p>
      ) : null}

      {current ? (
        <CoveragePairCard
          key={`${current.id}-${suggestion?.overall ?? "none"}-${suggestion?.rationale ?? ""}`}
          workspaceId={workspaceId}
          pair={{
            ...current,
            overall: suggestion?.overall ?? current.overall,
            rationale: suggestion?.rationale ?? current.rationale,
          }}
        />
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {aiOn
            ? "Queue clear. Revisit decided pairs below, or extract more claims on Sources / Ledger."
            : "Queue clear. Revisit decided pairs below, or add more gaps and tactics on the Ledger."}
        </p>
      )}

      {decided.length > 0 ? (
        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => setShowDecided((v) => !v)}
            className="justify-self-start text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {showDecided ? "Hide" : "Show"} {decided.length} decided pair(s)
          </button>
          {showDecided ? (
            <div className="grid gap-3 opacity-80">
              {decided.map((pair) => (
                <CoveragePairCard key={pair.id} workspaceId={workspaceId} pair={pair} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
