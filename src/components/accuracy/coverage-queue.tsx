"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  CoveragePairCard,
  type CoveragePairCardModel,
  type CoverageSuggestion,
} from "@/components/accuracy/coverage-pair-card";
import { useAiEnabled } from "@/components/platform/ai-status";

type AssistSuggestion = {
  overall: "pending" | "full" | "partial" | "limited" | "not_relevant";
  schema_overall: string;
  rationale: string;
  confidence: number;
  quote_block_ids: string[];
};

/**
 * One-pair-at-a-time coverage queue. Undecided pairs first; optional LLM suggest
 * and saved assessments share the card’s explicit suggestion review controls.
 */
export function CoverageQueue({
  workspaceId,
  pairs, cursor, snapshot,
}: {
  workspaceId: string;
  pairs: CoveragePairCardModel[];
  cursor?: string; snapshot?: string;
}) {
  const router = useRouter();
  const undecided = useMemo(() => pairs.filter((p) => !p.validated), [pairs]);
  const decided = useMemo(() => pairs.filter((p) => p.validated), [pairs]);
  const [index, setIndex] = useState(0);
  const aiOn = useAiEnabled();
  const [assistPending, startAssist] = useTransition();
  const [assistError, setAssistError] = useState<string | null>(null);
  const [assist, setAssist] = useState<{ key: string; suggestion: CoverageSuggestion } | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  // Reset the cursor and any suggestion when the queue changes (adjust during
  // render rather than in an effect, so there is no cascading re-render).
  const queueKey = JSON.stringify([workspaceId, snapshot, pairs]);
  const [seenQueueKey, setSeenQueueKey] = useState(queueKey);
  if (seenQueueKey !== queueKey) {
    setSeenQueueKey(queueKey);
    setIndex((i) => (undecided.length === 0 ? 0 : Math.min(i, undecided.length - 1)));
    setAssist(null);
    setAssistError(null);
  }

  const current = undecided[index] ?? null;
  const currentKey = JSON.stringify([workspaceId, snapshot, current]);
  const suggestion = assist?.key === currentKey ? assist.suggestion : current?.suggestion;
  const progressLabel =
    undecided.length === 0
      ? `All ${decided.length} pair(s) decided`
      : `Pair ${index + 1} of ${undecided.length} undecided · ${decided.length} decided`;

  function requestAssist() {
    if (!current) return;
    setAssistError(null);
    setAssist(null);
    startAssist(async () => {
      try {
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
          error?: string | { message: string };
          mode?: string;
          suggestion?: AssistSuggestion;
          run_id?: string; expected_gap_revision?: string; expected_tactic_revision?: string;
        };
        if (!res.ok || !body.ok || !body.suggestion) {
          setAssistError(typeof body.error === "string" ? body.error : body.error?.message ?? "Assist failed");
          return;
        }
        if (body.expected_gap_revision !== current.gap_revision || body.expected_tactic_revision !== current.tactic_revision) {
          setAssistError("Coverage inputs changed. Refresh before requesting another suggestion.");
          return;
        }
        setAssist({ key: currentKey, suggestion: { overall: body.suggestion.overall, rationale: body.suggestion.rationale,
          evidence: body.suggestion.quote_block_ids, run_id: body.run_id ?? null, freshness: "current",
          mode: body.mode, confidence: body.suggestion.confidence } });
      } catch { setAssistError("Assist request failed; retry this pair."); }
    });
  }

  function assessPage() {
    setAssistError(null);
    startAssist(async () => {
      try {
        const res = await fetch("/api/accuracy/coverage", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "assess", workspace_id: workspaceId, cursor, snapshot, page_size: 100 }) });
        const body = await res.json();
        if (!res.ok) { setAssistError(typeof body.error === "string" ? body.error : body.error?.message ?? "Assessment failed"); return; }
        router.refresh();
      } catch { setAssistError("Assessment request failed; retry this page."); }
    });
  }

  function goNext() {
    setAssist(null);
    setAssistError(null);
    if (index + 1 < undecided.length) {
      setIndex(index + 1);
    } else {
      router.refresh();
    }
  }

  function goPrev() {
    setAssist(null);
    setAssistError(null);
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
            <>
            <button type="button" disabled={assistPending} onClick={assessPage}
              className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-40 hover:bg-muted/40">
              {assistPending ? "Assessing…" : "Assess pending pairs on this page"}
            </button>
            <button
              type="button"
              disabled={!current || current.protected || assistPending}
              onClick={requestAssist}
              className="border border-border bg-muted/30 px-2 py-1 text-[11px] text-foreground disabled:opacity-40 hover:bg-muted/50"
            >
              {assistPending ? "Suggesting…" : "Suggest with LLM"}
            </button>
            </>
          ) : null}
        </div>
      </div>
      {!aiOn ? (
        <p className="text-[11px] text-muted-foreground" data-testid="coverage-ai-off">
          AI is off — no new suggestions. Review saved suggestions or write your own rationale below.
        </p>
      ) : null}

      {assistError ? <p className="text-[12px] text-destructive">{assistError}</p> : null}
      {current ? (
        // Keep this page's drafts mounted while navigating between its pairs.
        undecided.map(pair => <div key={`${workspaceId}:${pair.gap_id}:${pair.tactic_id}`} hidden={pair !== current}>
          <CoveragePairCard workspaceId={workspaceId} snapshot={snapshot}
            pair={pair === current ? { ...pair, suggestion } : pair} />
        </div>)
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
                <CoveragePairCard key={`${workspaceId}:${pair.gap_id}:${pair.tactic_id}`} workspaceId={workspaceId} snapshot={snapshot} pair={pair} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
