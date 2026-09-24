"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LiveExtractGate } from "@/accuracy/kernel/extract-gate";

export function ExtractOauthGateBanner({ gate }: { gate: LiveExtractGate }) {
  if (gate.ready && gate.stub) return null;
  if (gate.ready) {
    return (
      <p className="mb-3 text-[12px] text-muted-foreground" data-testid="extract-oauth-gate">
        Live extract will use {gate.provider_label} ({gate.auth === "oauth" ? "OAuth" : "connected"}
        ).
      </p>
    );
  }
  return (
    <div
      className="mb-3 border border-border bg-card/40 p-3"
      data-testid="extract-oauth-gate"
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
        Connect a provider in /control →
      </Link>
    </div>
  );
}

export function SourceExtractActions({
  workspaceId,
  sourceFileId,
  blockCount,
  gate,
}: {
  workspaceId: string;
  sourceFileId: string;
  blockCount: number;
  gate: LiveExtractGate;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [connectPath, setConnectPath] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const extractReady = gate.ready;

  function runExtract(kinds: Array<"need" | "inventory">) {
    setError(null);
    setConnectPath(null);
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
        provider_label?: string | null;
        gate?: string;
        connect_path?: string;
        runs?: Array<{ summary: string }>;
      };
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
        ? " (stub LLM — connect a provider in /control for live extract)"
        : via;
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
          href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
          className="px-1 text-[11px] text-foreground underline-offset-2 hover:underline"
        >
          Ledger →
        </Link>
      </div>
      {error ? (
        <p className="text-[11px] text-destructive" data-testid="extract-outcome">
          {error}
          {connectPath ? (
            <>
              {" "}
              <Link href={connectPath} className="underline-offset-2 hover:underline">
                Connect in /control →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {summary ? (
        <p className="text-[11px] text-muted-foreground" data-testid="extract-outcome">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
