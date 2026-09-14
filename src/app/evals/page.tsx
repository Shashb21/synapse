"use client";

import { AppShell } from "@/components/insight-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CritiqueFinding, EvalRun } from "@/lib/schema";
import { useEffect, useState } from "react";

type Payload = {
  champion_prompt_version: string;
  eval_runs: EvalRun[];
  gold_count: number;
};

const KIND_COPY: Record<CritiqueFinding["kind"], string> = {
  partial: "Partial",
  wrong: "Wrong",
  missed: "Missed",
  new: "New",
};

export default function EvalsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/evals");
    if (!res.ok) throw new Error("Could not load evals");
    setData(await res.json());
  }

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/evals", { method: "POST" });
      if (!res.ok) throw new Error("Eval sweep failed");
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Eval sweep failed");
    } finally {
      setBusy(false);
    }
  }

  const runs = data?.eval_runs ?? [];
  const selected =
    runs.find((r) => r.prompt_version === openRun) ??
    runs.find((r) => r.prompt_version === data?.champion_prompt_version) ??
    runs[0];

  return (
    <AppShell active="evals">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-heading text-3xl text-primary">Eval lab</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Three-model loop: the proposer extracts CIR insights, the critique
            tags partial / wrong / missed / new, and the judge decides whether
            the candidate prompt may become champion. Hill-climb is gated so
            wrong-rate cannot rise more than 5 points.
          </p>
        </div>
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? "Scoring versions…" : "Run hill-climb sweep"}
        </Button>
      </div>

      {error ? (
        <p className="mb-4 text-sm text-destructive">{error}</p>
      ) : null}

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading gold set and runs…</p>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap gap-2 text-sm">
            <Badge>Champion {data.champion_prompt_version}</Badge>
            <Badge variant="secondary">{data.gold_count} gold insights</Badge>
            <Badge variant="outline">{runs.length} prompt versions scored</Badge>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b bg-muted/50 text-[11px] tracking-wider text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2">Version</th>
                  <th className="px-3 py-2">Composite</th>
                  <th className="px-3 py-2">F1</th>
                  <th className="px-3 py-2">Partial</th>
                  <th className="px-3 py-2">Wrong</th>
                  <th className="px-3 py-2">Missed</th>
                  <th className="px-3 py-2">New</th>
                  <th className="px-3 py-2">Judge</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const champ =
                    run.prompt_version === data.champion_prompt_version;
                  return (
                    <tr
                      key={run.id}
                      className={`cursor-pointer border-b border-border/60 ${champ ? "bg-accent/40" : ""}`}
                      onClick={() => setOpenRun(run.prompt_version)}
                    >
                      <td className="px-3 py-2 font-medium">
                        {run.prompt_version}
                        <div className="text-[11px] font-normal text-muted-foreground">
                          {run.strategy}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {run.metrics.composite.toFixed(3)}
                      </td>
                      <td className="px-3 py-2">{run.metrics.f1.toFixed(3)}</td>
                      <td className="px-3 py-2">{run.metrics.partial}</td>
                      <td className="px-3 py-2">{run.metrics.wrong}</td>
                      <td className="px-3 py-2">{run.metrics.missed}</td>
                      <td className="px-3 py-2">{run.metrics.novel}</td>
                      <td className="px-3 py-2">{run.judge.decision}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selected ? (
            <section className="mt-8 grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border/80 bg-card p-4">
                <h3 className="font-heading text-xl text-primary">
                  Critique · {selected.prompt_version}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selected.judge.rationale}
                </p>
                <ul className="mt-3 max-h-[420px] space-y-2 overflow-auto">
                  {selected.critique.length === 0 ? (
                    <li className="text-sm text-muted-foreground">
                      No critique findings for this version.
                    </li>
                  ) : (
                    selected.critique.slice(0, 24).map((f, idx) => (
                      <li
                        key={`${f.kind}-${idx}`}
                        className="rounded-md border border-border/70 p-2.5"
                      >
                        <div className="text-[10px] font-semibold tracking-wide uppercase">
                          {KIND_COPY[f.kind]}
                          {f.gold_id ? ` · ${f.gold_id}` : ""}
                        </div>
                        <p className="mt-1 text-sm">{f.statement}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {f.rationale}
                        </p>
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div className="rounded-xl border border-border/80 bg-card p-4">
                <h3 className="font-heading text-xl text-primary">
                  Proposer patch
                </h3>
                <p className="mt-1 text-sm">
                  Next version:{" "}
                  <span className="font-medium">
                    {selected.proposal.recommended_prompt_version}
                  </span>
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                  {selected.proposal.rationale.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <pre className="mt-4 max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-4 whitespace-pre-wrap">
                  {selected.proposal.prompt_patch.slice(0, 1800)}
                </pre>
              </div>
            </section>
          ) : null}
        </>
      )}
    </AppShell>
  );
}
