"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type MissFlagCardModel = {
  block_id: string;
  source_file_id: string;
  source_filename?: string;
  suggested: "gap" | "tactic";
  reason: string;
  excerpt: string;
  kind: string;
  index: number;
};

/**
 * Completeness-audit inbox: promote miss flags to draft ledger claims or dismiss with rationale.
 */
export function MissFlagInbox({
  workspaceId,
  flags,
}: {
  workspaceId: string;
  flags: MissFlagCardModel[];
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [rationale, setRationale] = useState("");
  const [suggested, setSuggested] = useState<"gap" | "tactic" | null>(null);
  const [pending, setPending] = useState<"promote" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Reviewer's wording per flag (block id) for the promoted claim; absent = block excerpt. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [syncKey, setSyncKey] = useState(`${flags.length}::${workspaceId}`);

  // Reset when the flag list or workspace changes (derived-state pattern, no effect).
  const nextSyncKey = `${flags.length}::${workspaceId}`;
  if (nextSyncKey !== syncKey) {
    setSyncKey(nextSyncKey);
    setIndex((i) => (flags.length === 0 ? 0 : Math.min(i, flags.length - 1)));
    setSuggested(null);
    setError(null);
  }

  const current = flags[index] ?? null;
  const statementDraft = current ? (drafts[current.block_id] ?? null) : null;
  const setStatementDraft = (value: string | null) => {
    if (!current) return;
    setDrafts((prev) => {
      const next = { ...prev };
      if (value === null) delete next[current.block_id];
      else next[current.block_id] = value;
      return next;
    });
  };
  const progress =
    flags.length === 0
      ? "No open miss flags"
      : `Flag ${index + 1} of ${flags.length}`;

  async function act(action: "promote" | "dismiss") {
    if (!current) return;
    setError(null);
    if (rationale.trim().length < 3) {
      setError("A short rationale is required (hillclimb).");
      return;
    }
    setPending(action);
    try {
      const res = await fetch("/api/accuracy/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          block_id: current.block_id,
          action,
          suggested: suggested ?? current.suggested,
          rationale,
          ...(action === "promote" && statementDraft?.trim()
            ? { statement: statementDraft.trim() }
            : {}),
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; claim_id?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Action failed");
        return;
      }
      setRationale("");
      setSuggested(null);
      setStatementDraft(null);
      // Keep index; after refresh the resolved flag drops out and the next slides into place.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(null);
    }
  }

  if (!current) {
    return (
      <p className="text-[12px] text-muted-foreground">
        Inbox clear — every auditable parse block is cited, overlaps a claim, or was resolved.{" "}
        <Link
          href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
          className="text-foreground underline-offset-2 hover:underline"
        >
          Open Ledger
        </Link>
      </p>
    );
  }

  const promoteAs = suggested ?? current.suggested;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">{progress}</p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={index === 0 || pending !== null}
            onClick={() => {
              setError(null);
              setSuggested(null);
              setIndex((i) => Math.max(0, i - 1));
            }}
          >
            Previous
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={index + 1 >= flags.length || pending !== null}
            onClick={() => {
              setError(null);
              setSuggested(null);
              setIndex((i) => Math.min(flags.length - 1, i + 1));
            }}
          >
            Skip
          </Button>
        </div>
      </div>

      <article className="border border-border bg-card/40 p-4" aria-labelledby="miss-flag-title">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 id="miss-flag-title" className="text-[15px] font-medium text-foreground">
            Miss flag
          </h2>
          <Badge variant="outline" className="text-[11px]">
            Suggest {promoteAs}
          </Badge>
          <Badge variant="secondary" className="text-[11px]">
            {current.kind} · #{current.index}
          </Badge>
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          Block <code className="text-[10px]">{current.block_id}</code>
          {" · "}
          {current.source_filename ?? current.source_file_id}
        </p>
        <p className="mb-3 text-[13px] leading-relaxed text-foreground">{current.excerpt}</p>
        <p className="mb-4 text-[12px] text-muted-foreground">{current.reason}</p>

        <fieldset className="mb-3 grid gap-2">
          <legend className="text-[12px] text-muted-foreground">Promote as</legend>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={promoteAs === "gap" ? "default" : "outline"}
              disabled={pending !== null}
              onClick={() => setSuggested("gap")}
            >
              Gap
            </Button>
            <Button
              type="button"
              size="sm"
              variant={promoteAs === "tactic" ? "default" : "outline"}
              disabled={pending !== null}
              onClick={() => setSuggested("tactic")}
            >
              Tactic
            </Button>
          </div>
        </fieldset>

        <label className="mb-3 grid gap-1">
          <span className="text-[12px] text-muted-foreground">
            Claim statement (edit before promoting — defaults to the block excerpt)
          </span>
          <Textarea
            value={statementDraft ?? current.excerpt}
            onChange={(e) => setStatementDraft(e.target.value)}
            rows={3}
            className="text-[13px]"
            disabled={pending !== null}
            data-testid="miss-flag-statement"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-[12px] text-muted-foreground">Rationale (required)</span>
          <Textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why promote this block, or why dismiss it?"
            rows={3}
            className="text-[13px]"
            disabled={pending !== null}
          />
        </label>

        {error ? (
          <p className="mt-2 text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending !== null}
            onClick={() => void act("promote")}
          >
            {pending === "promote" ? "Promoting…" : `Promote to draft ${promoteAs}`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void act("dismiss")}
          >
            {pending === "dismiss" ? "Dismissing…" : "Dismiss"}
          </Button>
          <Link
            href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
            className="inline-flex h-8 items-center px-2 text-[12px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Ledger
          </Link>
        </div>
      </article>
    </div>
  );
}
