import { requireOwnerPage } from "@/modules/auth/owner";
import { AdminMain, AdminWorkspaceBar, PageIntro } from "@/components/admin/admin-page";
import { loadState } from "@/lib/iegp/store";
import { coverageEval, needEvalMetrics, pairNeeds } from "@/lib/iegp/engine";
import { listEvalRuns } from "@/modules/kernel/evals";
import { listHistoricalObservations } from "@/modules/kernel/baselines";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";

export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  await requireOwnerPage();
  // The console's workspace (KAN-62), not whatever the app happens to have selected.
  const { workspace, state, summaries, history } = await withAdminWorkspace(async workspace => {
    const [state, harness, sweep, history] = await Promise.all([loadState(), listEvalRuns({ kind: "harness_summary", limit: 6 }),
      listEvalRuns({ kind: "sweep_summary", limit: 6 }), listHistoricalObservations()]);
    return { workspace, state, summaries: [...harness, ...sweep].sort((a,b) => b.at.localeCompare(a.at)).slice(0,6), history };
  });
  // Scores what the S2 stage actually committed, not a local keyword extractor.
  const extracted = state.needs.map((n) => ({
    id: n.id,
    statement: n.statement,
    source_id: n.source_id,
  }));
  const pairs = pairNeeds(extracted, state.gold_needs);
  const metrics = needEvalMetrics(pairs, state.gold_needs, extracted.length);
  const cov = coverageEval(
    state.coverages.map((c) => ({
      gap_id: c.gap_id,
      tactic_id: c.tactic_id,
      overall: c.overall,
    })),
    state.gold_coverages,
  );
  const noGold = state.gold_needs.length === 0;
  const autoClose = state.gaps.filter(
    (g) => g.status === "validated_addressed" && !g.status_lock.locked,
  );

  return (
    <AdminMain>
      <PageIntro kicker="View-only tape" title="Eval tape">
        Workspace gold measures how well committed needs and coverage match the reference set.
        Need precision and recall both give a partial match half credit.
      </PageIntro>
      <AdminWorkspaceBar workspace={workspace} path="/admin/evals" />
      {state.sources.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No sources ingested in this workspace.
        </p>
      ) : (
      <>
      {noGold ? (
        <p className="mb-4 border border-border bg-card p-3 text-[13px] text-muted-foreground rounded-lg" data-testid="evals-no-gold">
          There is no gold set to score against in this workspace, so need recall, precision and F1
          are not scored. Add gold needs to score what S2 committed.
        </p>
      ) : metrics.scored ? null : (
        <p className="mb-4 border border-border bg-card p-3 text-[13px] text-muted-foreground rounded-lg" data-testid="evals-no-must-find">
          No gold need is marked must-find, so need recall and F1 are not scored.
        </p>
      )}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Metric label="Need recall" value={noGold ? "no gold set" : score(metrics.recall)} />
        <Metric label="Need precision" value={noGold ? "no gold set" : score(metrics.precision)} />
        <Metric label="Need F1" value={noGold ? "no gold set" : score(metrics.f1)} />
        <Metric label="Exact / partial / missed / wrong" value={`${metrics.exact} / ${metrics.partial} / ${metrics.missed} / ${metrics.wrong}`} />
        <Metric label="Coverage gold exact" value={state.gold_coverages.length ? `${cov.exact}/${state.gold_coverages.length}` : "no gold set"} />
        <Metric label="Computed addressed (no override)" value={String(autoClose.length)} />
      </div>
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Committed needs (S2 gap extraction)</h2>
      <div className="grid gap-2">
        {extracted.map((row) => {
          const pair = pairs.find((p) => p.extract_id === row.id);
          return (
            <p key={row.id} className="border border-border bg-card p-3 text-[12px] rounded-lg">
              <span className="text-muted-foreground">{pair?.kind ?? "—"} · {row.source_id}</span>
              <br />
              {row.statement}
            </p>
          );
        })}
      </div>
      </>
      )}
      <h2 className="mt-6 font-semibold">Recent diagnostic summaries</h2>
      {summaries.length ? <ul>{summaries.map(row => <li key={row.id}>
        {row.at} · {row.stage} · {row.kind === "sweep_summary" ? "Prompt sweep" : "Stage harness"} · {row.lineage.execution} · {row.note} · {row.passed === null ? "unscored" : row.passed ? "curated target met" : "below curated target"}
      </li>)}</ul> : <p>No diagnostic summaries recorded in this workspace.</p>}
      <h2 className="mt-6 font-semibold">Historical sweep scores</h2>
      {history.length ? <ul>{history.map(row => <li key={row.id}>
        {row.recorded_at} · {row.stage} · {row.prompt_version} · {Number(row.composite).toFixed(3)}
      </li>)}</ul> : <p>No comparable routed sweep observations recorded.</p>}
    </AdminMain>
  );
}

/** A score to three places; an unscored one (null) says so rather than inventing a number. */
function score(value: number | null): string {
  return value === null ? "not scored" : value.toFixed(3);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-card p-4 rounded-lg">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg text-foreground">{value}</p>
    </div>
  );
}
