import { requireOwnerPage } from "@/modules/auth/owner";
import { AdminMain, AdminWorkspaceBar, PageIntro } from "@/components/admin/admin-page";
import { loadState } from "@/lib/iegp/store";
import { coverageEval, needEvalMetrics, pairNeeds } from "@/lib/iegp/engine";
import { engineMaySetStatus } from "@/lib/iegp/engine";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";

export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  await requireOwnerPage();
  // The console's workspace (KAN-62), not whatever the app happens to have selected.
  const { workspace, state } = await withAdminWorkspace(async (workspace) => ({ workspace, state: await loadState() }));
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
        Gold scores candidate-need recovery from sources and gap–tactic overall coverage.
        Gap status is computed by the engine (Open / Partially Addressed / Addressed). Human
        override requires a reason and is marked stale on ingest or coverage refresh — never
        silent-clobbered.
      </PageIntro>
      <AdminWorkspaceBar workspace={workspace} path="/admin/evals" />
      {state.sources.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No sources ingested. engineMaySetStatus(addressed) = {String(engineMaySetStatus("validated_addressed"))}{" "}
          (must be true — the engine computes Addressed when evidence fully closes).
        </p>
      ) : (
      <>
      {noGold ? (
        <p className="mb-4 border border-border bg-card p-3 text-[13px] text-muted-foreground rounded-lg" data-testid="evals-no-gold">
          There is no gold set to score against in this workspace, so need recall, precision and the composite
          are not scored. Add gold needs to score what S2 committed.
        </p>
      ) : metrics.scored ? null : (
        <p className="mb-4 border border-border bg-card p-3 text-[13px] text-muted-foreground rounded-lg" data-testid="evals-no-must-find">
          No gold need is marked must-find, so need recall and the composite are not scored.
        </p>
      )}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Metric label="Need recall" value={noGold ? "no gold set" : score(metrics.recall)} />
        <Metric label="Need precision" value={noGold ? "no gold set" : score(metrics.precision)} />
        <Metric label="Need composite" value={noGold ? "no gold set" : score(metrics.composite)} />
        <Metric label="Exact / partial / missed / wrong" value={`${metrics.exact} / ${metrics.partial} / ${metrics.missed} / ${metrics.wrong}`} />
        <Metric label="Coverage gold exact" value={`${cov.exact}/${state.gold_coverages.length}`} />
        <Metric label="Computed addressed (no override)" value={String(autoClose.length)} />
      </div>
      <p className="mb-4 text-[13px] text-muted-foreground">
        engineMaySetStatus(addressed) = {String(engineMaySetStatus("validated_addressed"))} (must be
        true). Computed addressed without override: {autoClose.length === 0 ? "none" : autoClose.map((g) => g.id).join(", ")}.
      </p>
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
