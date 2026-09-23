"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function SourceExtractActions({
  workspaceId,
  sourceFileId,
  blockCount,
}: {
  workspaceId: string;
  sourceFileId: string;
  blockCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  function runExtract(kinds: Array<"need" | "inventory">) {
    setError(null);
    setSummary(null);
    startTransition(async () => {
      const res = await fetch("/api/accuracy/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          source_file_id: sourceFileId,
          kinds,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        gaps_inserted?: number;
        tactics_inserted?: number;
        stub?: boolean;
        runs?: Array<{ summary: string }>;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Extract failed");
        return;
      }
      const parts = [
        `${json.gaps_inserted ?? 0} gap(s)`,
        `${json.tactics_inserted ?? 0} tactic(s)`,
      ];
      const note = json.stub
        ? " (stub LLM — connect a provider or unset SYNAPSE_TEST_STUB_LLM for live extract)"
        : "";
      setSummary(`Extracted ${parts.join(" · ")}${note}`);
      router.refresh();
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
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => runExtract(["need", "inventory"])}
          className="border border-foreground bg-foreground px-2 py-1 text-[11px] text-background disabled:opacity-50"
        >
          {pending ? "Extracting…" : "Extract needs + inventory"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => runExtract(["need"])}
          className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-50 hover:bg-muted/40"
        >
          Needs only
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => runExtract(["inventory"])}
          className="border border-border px-2 py-1 text-[11px] text-foreground disabled:opacity-50 hover:bg-muted/40"
        >
          Inventory only
        </button>
        <Link
          href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
          className="px-1 text-[11px] text-foreground underline-offset-2 hover:underline"
        >
          Ledger →
        </Link>
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      {summary ? <p className="text-[11px] text-muted-foreground">{summary}</p> : null}
    </div>
  );
}
