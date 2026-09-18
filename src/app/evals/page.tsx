import { AppShell, PageIntro } from "@/components/app-shell";
import { loadState } from "@/lib/iegp/store";
import { coverageEval, extractCandidateNeeds, needEvalMetrics, pairNeeds } from "@/lib/iegp/engine";
import { engineMaySetStatus } from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  const state = await loadState();
  const extracted = extractCandidateNeeds(
    state.blocks.map((b) => ({
      id: b.id,
      source_id: b.source_id,
      text: b.text,
      heading: b.heading,
    })),
  );
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
  const autoClose = state.gaps.filter(
    (g) => g.status === "validated_addressed" && !g.status_lock.locked,
  );

  return (
    <AppShell active="evals">
      <PageIntro kicker="View-only tape" title="Eval tape">
        Gold scores candidate-need recovery from sources and gap–tactic overall coverage.
        Gap status is computed by the engine (Open / Partially Addressed / Addressed). Human
        override requires a reason and is marked stale on ingest or coverage refresh — never
        silent-clobbered.
      </PageIntro>
      {state.sources.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No sources ingested. engineMaySetStatus(addressed) = {String(engineMaySetStatus("validated_addressed"))}{" "}
          (must be true — the engine computes Addressed when evidence fully closes).
        </p>
      ) : (
      <>
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Metric label="Need recall" value={metrics.recall.toFixed(3)} />
        <Metric label="Need precision" value={metrics.precision.toFixed(3)} />
        <Metric label="Need composite" value={metrics.composite.toFixed(3)} />
        <Metric label="Exact / partial / missed / wrong" value={`${metrics.exact} / ${metrics.partial} / ${metrics.missed} / ${metrics.wrong}`} />
        <Metric label="Coverage gold exact" value={`${cov.exact}/${state.gold_coverages.length}`} />
        <Metric label="Computed addressed (no override)" value={String(autoClose.length)} />
      </div>
      <p className="mb-4 text-[13px] text-muted-foreground">
        engineMaySetStatus(addressed) = {String(engineMaySetStatus("validated_addressed"))} (must be
        true). Computed addressed without override: {autoClose.length === 0 ? "none" : autoClose.map((g) => g.id).join(", ")}.
      </p>
      <h2 className="mb-2 text-[13px] text-muted-foreground">Extracted candidate needs (local cues)</h2>
      <div className="grid gap-2">
        {extracted.map((row) => {
          const pair = pairs.find((p) => p.extract_id === row.id);
          return (
            <p key={row.id} className="border border-border bg-card p-3 text-[12px]">
              <span className="text-muted-foreground">{pair?.kind ?? "—"} · {row.source_id}</span>
              <br />
              {row.statement}
            </p>
          );
        })}
      </div>
      </>
      )}
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-card p-4">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg text-foreground">{value}</p>
    </div>
  );
}
