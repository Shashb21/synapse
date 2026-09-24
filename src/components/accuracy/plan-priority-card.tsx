"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { resolveGapStatus, resolvePriorityBand } from "@/accuracy/domain/iegp-semantics";
import { TACTIC_TYPES, TACTIC_TYPE_LABELS } from "@/lib/iegp/enums";

type IdeateResponse = {
  ok?: boolean;
  error?: string;
  mode?: string;
  stub?: boolean;
  tactic_id?: string;
  tactic_ids?: string[];
  tactics_inserted?: number;
  summary?: string;
};

async function postIdeate(body: Record<string, unknown>): Promise<{
  ok: boolean;
  status: number;
  json: IdeateResponse;
}> {
  const res = await fetch("/api/accuracy/ideate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as IdeateResponse;
  return { ok: res.ok && Boolean(json.ok), status: res.status, json };
}

function outcomeMessage(json: IdeateResponse): string {
  if (json.mode === "manual" && json.tactic_id) {
    return `Proposed tactic ${json.tactic_id}`;
  }
  const inserted = json.tactics_inserted ?? json.tactic_ids?.length ?? 0;
  const stubNote = json.stub
    ? " (stub LLM — connect a provider or unset SYNAPSE_TEST_STUB_LLM for live ideate)"
    : "";
  if (inserted === 0) {
    return `${json.summary ?? "No proposed tactics"}${stubNote}`;
  }
  return `Proposed ${inserted} tactic(s)${stubNote}`;
}

export function PlanIdeateAllButton({
  workspaceId,
  eligibleCount,
}: {
  workspaceId: string;
  eligibleCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (eligibleCount < 1) return null;

  function run() {
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const { ok, json } = await postIdeate({ workspace_id: workspaceId });
      if (!ok) {
        setError(json.error ?? "Ideate failed");
        return;
      }
      setMsg(outcomeMessage(json));
      router.refresh();
    });
  }

  return (
    <div className="mb-3 grid gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={run}
        className="w-fit border border-foreground bg-foreground px-3 py-1.5 text-[11px] text-background disabled:opacity-50"
      >
        {pending ? "Ideating…" : `Run LLM ideate (${eligibleCount} high open gap${eligibleCount === 1 ? "" : "s"})`}
      </button>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      {msg ? <p className="text-[12px] text-muted-foreground">{msg}</p> : null}
    </div>
  );
}

export function PlanPriorityCard({
  workspaceId,
  claimId,
  statement,
  priority,
  validated,
  status,
}: {
  workspaceId: string;
  claimId: string;
  statement: string;
  priority: string | null;
  validated: boolean;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(priority ?? "medium");
  const [error, setError] = useState<string | null>(null);
  const [ideateTitle, setIdeateTitle] = useState("");
  const [ideateRationale, setIdeateRationale] = useState("");
  const [ideateMsg, setIdeateMsg] = useState<string | null>(null);
  const [priorityRationale, setPriorityRationale] = useState("");
  const [ideateStart, setIdeateStart] = useState("");
  const [ideateEnd, setIdeateEnd] = useState("");
  const [ideateType, setIdeateType] = useState("");

  const band = resolvePriorityBand(value) ?? resolvePriorityBand(priority);
  const canIdeate = validated && band === "high" && resolveGapStatus(status) === "open";

  function save(next: string) {
    setError(null);
    setIdeateMsg(null);
    if (priorityRationale.trim().length < 3) {
      setError("Type a short rationale (min 3 characters) before changing the priority band.");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/accuracy/claims/priority", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          claim_id: claimId,
          priority: next,
          rationale: priorityRationale.trim(),
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Update failed");
        return;
      }
      setValue(next);
      setPriorityRationale("");
      router.refresh();
    });
  }

  function runLlm() {
    setError(null);
    setIdeateMsg(null);
    startTransition(async () => {
      const { ok, json } = await postIdeate({
        workspace_id: workspaceId,
        gap_id: claimId,
        hints: [ideateTitle.trim(), ideateRationale.trim()].filter(Boolean).join(" — ") || undefined,
      });
      if (!ok) {
        setError(json.error ?? "Ideate failed");
        return;
      }
      setIdeateMsg(outcomeMessage(json));
      setIdeateTitle("");
      setIdeateRationale("");
      router.refresh();
    });
  }

  function ideateManual(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIdeateMsg(null);
    startTransition(async () => {
      const { ok, json } = await postIdeate({
        workspace_id: workspaceId,
        gap_id: claimId,
        title: ideateTitle.trim(),
        rationale: ideateRationale.trim(),
        ...(ideateStart ? { start: ideateStart } : {}),
        ...(ideateEnd ? { end: ideateEnd } : {}),
        ...(ideateType ? { type: ideateType } : {}),
      });
      if (!ok) {
        setError(json.error ?? "Ideate failed");
        return;
      }
      setIdeateMsg(outcomeMessage(json));
      setIdeateTitle("");
      setIdeateRationale("");
      setIdeateStart("");
      setIdeateEnd("");
      setIdeateType("");
      router.refresh();
    });
  }

  return (
    <article className="border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-foreground">{statement}</p>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {validated ? "validated" : "unvalidated"}
        </span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">{claimId}</p>
      <input
        value={priorityRationale}
        onChange={(e) => setPriorityRationale(e.target.value)}
        placeholder="Why this priority band (required, then pick a band)"
        aria-label="Priority rationale"
        className="mt-2 w-full border border-border bg-background px-2 py-1.5 text-[12px]"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {(["high", "medium", "low"] as const).map((bandOption) => (
          <button
            key={bandOption}
            type="button"
            disabled={pending}
            onClick={() => save(bandOption)}
            className={`border px-2 py-1 text-[11px] capitalize ${
              value === bandOption
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground hover:bg-muted/40"
            }`}
          >
            {bandOption}
          </button>
        ))}
      </div>

      {canIdeate ? (
        <form onSubmit={ideateManual} className="mt-3 grid gap-2 border-t border-border pt-3">
          <p className="text-[11px] text-muted-foreground">
            High + validated + open — run live LLM ideation (origin: ideated, status: proposed until
            you validate). Inventory tactics stay on extract.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={runLlm}
            className="w-fit border border-foreground bg-foreground px-3 py-1.5 text-[11px] text-background disabled:opacity-50"
          >
            {pending ? "Working…" : "Run LLM ideate"}
          </button>
          <input
            value={ideateTitle}
            onChange={(e) => setIdeateTitle(e.target.value)}
            placeholder="Optional title hint, or submit as a manual proposal"
            minLength={8}
            className="border border-border bg-background px-2 py-1.5 text-[12px]"
          />
          <input
            value={ideateRationale}
            onChange={(e) => setIdeateRationale(e.target.value)}
            placeholder="Optional rationale (required to save a manual proposal)"
            minLength={3}
            className="border border-border bg-background px-2 py-1.5 text-[12px]"
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Type (optional)
              <select
                value={ideateType}
                onChange={(e) => setIdeateType(e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-[12px] text-foreground"
              >
                <option value="">—</option>
                {TACTIC_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TACTIC_TYPE_LABELS[type] ?? type}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Start (optional)
              <input
                type="date"
                value={ideateStart}
                onChange={(e) => setIdeateStart(e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-[12px]"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              End (optional)
              <input
                type="date"
                value={ideateEnd}
                onChange={(e) => setIdeateEnd(e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-[12px]"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={pending || ideateTitle.trim().length < 8 || ideateRationale.trim().length < 3}
            className="w-fit border border-border px-3 py-1.5 text-[11px] text-foreground disabled:opacity-50 hover:bg-muted/40"
          >
            {pending ? "Working…" : "Save manual proposal"}
          </button>
        </form>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Ideation unlocks when this gap is validated, open, and set to high.
        </p>
      )}

      {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
      {ideateMsg ? <p className="mt-2 text-[12px] text-muted-foreground">{ideateMsg}</p> : null}
    </article>
  );
}
