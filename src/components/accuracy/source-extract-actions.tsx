"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SourceProgress } from "@/accuracy/domain/source-pages";
import type { LiveExtractGate } from "@/accuracy/kernel/extract-gate";

export function ExtractKeyGateBanner({ gate }: { gate: LiveExtractGate }) {
  if (gate.ready && gate.stub) return null;
  if (gate.ready) {
    return (
      <p className="mb-3 text-[12px] text-muted-foreground" data-testid="extract-key-gate">
        Live extract will use {gate.provider_label} (server API key).
      </p>
    );
  }
  return (
    <div
      className="mb-3 border border-border bg-card p-3 rounded-lg"
      data-testid="extract-key-gate"
      role="status"
    >
      <p className="text-[13px] text-foreground">{gate.message}</p>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Grok is the default route; Claude is the one-click alternate. Parsing uses the parse route
        in the control panel.
      </p>
      <Link
        href={gate.connect_path}
        className="mt-2 inline-block text-[12px] text-foreground underline-offset-2 hover:underline"
      >
        Check provider key status in /admin/control →
      </Link>
    </div>
  );
}

export function SourceExtractActions({
  workspaceId,
  sourceFileId,
  blockCount,
  gate,
  checkpoint,
}: {
  workspaceId: string;
  sourceFileId: string;
  blockCount: number;
  gate: LiveExtractGate;
  checkpoint?: { progress: SourceProgress; kinds: Array<"need" | "inventory">; stale: boolean } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [connectPath, setConnectPath] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [reviewRuns, setReviewRuns] = useState<Array<{ run_id: string; call_kind: string }>>([]);
  const [retry, setRetry] = useState<{ cursor: string; kinds: Array<"need" | "inventory"> } | null>(null);
  const extractReady = gate.ready;
  const savedRetry = checkpoint && !checkpoint.stale && checkpoint.progress.next_cursor && checkpoint.kinds.length
    ? { cursor: checkpoint.progress.next_cursor, kinds: checkpoint.kinds } : null;
  const activeRetry = retry ?? savedRetry;

  function runExtract(kinds: Array<"need" | "inventory">, cursor?: string) {
    setRetry(null);
    setError(null);
    setConnectPath(null);
    setSummary(null);
    setReviewRuns([]);
    startTransition(async () => {
      try {
      const res = await fetch("/api/accuracy/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          source_file_id: sourceFileId,
          kinds, cursor,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        gaps_inserted?: number;
        tactics_inserted?: number;
        stub?: boolean;
        provider_label?: string | null;
        gate?: string;
        connect_path?: string;
        paused?: boolean;
        incomplete?: boolean;
        source_progress?: SourceProgress;
        runs?: Array<{ summary: string; run_id: string; call_kind: string }>;
      };
      if (json.incomplete && json.source_progress) {
        const progress = json.source_progress;
        setSummary(`Drafts saved: ${json.gaps_inserted ?? 0} gap(s) · ${json.tactics_inserted ?? 0} tactic(s). Source extraction incomplete: ${progress.processed_units}/${progress.expected_units} units complete.${progress.upstream_dropped_units?.length ? ` ${progress.upstream_dropped_units.length} excluded parse unit(s) need review.` : ""}`);
        setReviewRuns((json.runs ?? []).filter(run => run.call_kind === "need_extract" || run.call_kind === "inventory_extract"));
        if (progress.next_cursor) setRetry({ cursor: progress.next_cursor, kinds });
        router.refresh();
        return;
      }
      if (json.paused) {
        setSummary(`Drafts saved: ${json.gaps_inserted ?? 0} gap(s) · ${json.tactics_inserted ?? 0} tactic(s). Downstream work is paused for omission review.`);
        setReviewRuns((json.runs ?? []).filter(run => run.call_kind === "need_extract" || run.call_kind === "inventory_extract"));
        router.refresh();
        return;
      }
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Extract failed");
        if (json.connect_path) setConnectPath(json.connect_path);
        return;
      }
      const parts = [
        `${json.gaps_inserted ?? 0} gap(s)`,
        `${json.tactics_inserted ?? 0} tactic(s)`,
      ];
      const via = json.provider_label ? ` via ${json.provider_label}` : "";
      const note = json.stub
        ? " (stub LLM — set a provider's API key in the server environment for live extract)"
        : via;
      setSummary(`Extracted ${parts.join(" · ")}${note}`);
      router.refresh();
      } catch { setError("Extract request failed; retry extraction or continue manual work on the Ledger."); }
    });
  }

  if (blockCount < 1) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        No parse blocks — re-upload or seed before extracting.
      </p>
    );
  }

  return (
    <div className="mt-2 grid gap-1">
      {checkpoint ? <div className="text-[11px] text-muted-foreground" role="status">
        <p>Source progress: {checkpoint.progress.processed_units}/{checkpoint.progress.expected_units} units · {checkpoint.progress.failed_units} failed · Full source: {checkpoint.progress.full_source_complete ? "complete" : "incomplete"}{checkpoint.stale ? " · stale source — start a new extraction" : ""}</p>
        <details><summary>Extraction page attempts and cursor</summary>
          <p>Cursor: {checkpoint.progress.next_cursor ?? "none"} · Scope: {checkpoint.progress.selection_scope}</p>
          <ul>{checkpoint.progress.pages.map(page => <li key={page.id}>Page {page.index + 1}: {Object.entries(page.attempts).map(([kind, attempt]) => `${kind}: ${attempt.state}${attempt.error ? ` (${attempt.error})` : ""}`).join(" · ")}</li>)}</ul>
        </details>
      </div> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !extractReady}
          onClick={() => runExtract(["need", "inventory"])}
          className="border border-foreground bg-foreground px-2 py-1 text-[11px] text-background disabled:opacity-50"
        >
          {pending ? "Extracting…" : "Extract needs + inventory"}
        </button>
        <button
          type="button"
          disabled={pending || !extractReady}
          onClick={() => runExtract(["need"])}
          className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-50 hover:bg-muted/40"
        >
          Needs only
        </button>
        <button
          type="button"
          disabled={pending || !extractReady}
          onClick={() => runExtract(["inventory"])}
          className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-50 hover:bg-muted/40"
        >
          Inventory only
        </button>
        <Link
          href={`/admin/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
          className="px-1 text-[11px] text-foreground underline-offset-2 hover:underline"
        >
          Ledger →
        </Link>
      </div>
      {activeRetry ? <button type="button" disabled={pending || !extractReady} onClick={() => runExtract(activeRetry.kinds, activeRetry.cursor)}
        className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-50 hover:bg-muted/40">
        Retry remaining pages
      </button> : null}
      {error ? (
        <p className="text-[11px] text-destructive" data-testid="extract-outcome">
          {error}
          {connectPath ? (
            <>
              {" "}
              <Link href={connectPath} className="underline-offset-2 hover:underline">
                Key status in /admin/control →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {reviewRuns.map(run => (
        <Link key={run.run_id} href={`/admin/accuracy/runs/${encodeURIComponent(run.run_id)}?workspace_id=${encodeURIComponent(workspaceId)}`}
          className="text-[11px] text-foreground underline-offset-2 hover:underline">
          Review {run.call_kind === "need_extract" ? "needs" : "inventory"} omissions →
        </Link>
      ))}
      {summary ? (
        <p className="text-[11px] text-muted-foreground" data-testid="extract-outcome">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
