import { AppShell, PageIntro } from "@/components/insight-card";
import { getState } from "@/lib/store";
import { formatTerminalTime } from "@/lib/briefing/theme-summary";

export const dynamic = "force-dynamic";

const KIND = {
  partial: { label: "Partial", fg: "#fbbf24", bg: "rgba(251, 191, 36, 0.16)" },
  wrong: { label: "Wrong", fg: "#fb7185", bg: "rgba(251, 113, 133, 0.16)" },
  missed: { label: "Missed", fg: "#c084fc", bg: "rgba(192, 132, 252, 0.16)" },
  new: { label: "New", fg: "#34d399", bg: "rgba(52, 211, 153, 0.16)" },
} as const;

const JUDGE = {
  promote: { fg: "#34d399", bg: "rgba(52, 211, 153, 0.16)" },
  hold: { fg: "#fbbf24", bg: "rgba(251, 191, 36, 0.16)" },
  regress: { fg: "#fb7185", bg: "rgba(251, 113, 133, 0.16)" },
} as const;

export default async function EvalsPage() {
  const state = await getState();
  const runs = state.eval_runs;
  const champion =
    runs.find((r) => r.prompt_version === state.champion_prompt_version) ??
    runs[runs.length - 1];

  return (
    <AppShell active="evals">
      <PageIntro kicker="View-only" title="Eval tape">
        Hill-climb runs automatically on seed and on every ingest. Critique,
        judge, and proposer already scored the ladder.
      </PageIntro>

      {runs.length === 0 || !champion ? (
        <p className="rounded-2xl border border-border bg-card p-6 text-muted-foreground">
          No eval tape yet. Ingest a source and the sweep will land here.
        </p>
      ) : (
        <>
          <div className="mb-8 rounded-2xl border border-primary/30 bg-primary/10 px-6 py-5">
            <p className="text-sm font-medium text-primary">Champion</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">
              {state.champion_prompt_version}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Composite {champion.metrics.composite.toFixed(3)} · gold{" "}
              {state.gold.length} · last {formatTerminalTime(champion.ran_at)}
            </p>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-5 py-3.5">Version</th>
                  <th className="px-5 py-3.5">Comp</th>
                  <th className="px-5 py-3.5">F1</th>
                  <th className="px-5 py-3.5">Partial</th>
                  <th className="px-5 py-3.5">Wrong</th>
                  <th className="px-5 py-3.5">Missed</th>
                  <th className="px-5 py-3.5">New</th>
                  <th className="px-5 py-3.5">Judge</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const champ =
                    run.prompt_version === state.champion_prompt_version;
                  const judge = JUDGE[run.judge.decision];
                  return (
                    <tr
                      key={run.id}
                      className={`border-b border-border last:border-b-0 ${
                        champ ? "bg-primary/10" : ""
                      }`}
                    >
                      <td className="px-5 py-4">
                        <div className="font-medium">{run.prompt_version}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {run.strategy}
                        </div>
                      </td>
                      <td className="px-5 py-4 tabular-nums">
                        {run.metrics.composite.toFixed(3)}
                      </td>
                      <td className="px-5 py-4 tabular-nums">
                        {run.metrics.f1.toFixed(3)}
                      </td>
                      <td className="px-5 py-4">{run.metrics.partial}</td>
                      <td className="px-5 py-4">{run.metrics.wrong}</td>
                      <td className="px-5 py-4">{run.metrics.missed}</td>
                      <td className="px-5 py-4">{run.metrics.novel}</td>
                      <td className="px-5 py-4">
                        <span
                          className="inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize"
                          style={{ color: judge.fg, backgroundColor: judge.bg }}
                        >
                          {run.judge.decision}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section className="mt-8 grid gap-5 lg:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-6">
              <h2 className="text-lg font-semibold">
                Critique · {champion.prompt_version}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {champion.judge.rationale}
              </p>
              <ul className="mt-5 max-h-[480px] space-y-3 overflow-auto pr-1">
                {champion.critique.slice(0, 24).map((f, idx) => {
                  const kind = KIND[f.kind];
                  return (
                    <li
                      key={`${f.kind}-${idx}`}
                      className="rounded-xl border border-border/80 bg-background/40 p-4"
                    >
                      <div
                        className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                        style={{ color: kind.fg, backgroundColor: kind.bg }}
                      >
                        {kind.label}
                        {f.gold_id ? ` · ${f.gold_id}` : ""}
                      </div>
                      <p className="mt-2 text-sm leading-6">{f.statement}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {f.rationale}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="rounded-2xl border border-border bg-card p-6">
              <h2 className="text-lg font-semibold">Proposer patch</h2>
              <p className="mt-2 text-sm">
                Next {champion.proposal.recommended_prompt_version}
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6">
                {champion.proposal.rationale.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-muted/60 p-4 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
                {champion.proposal.prompt_patch.slice(0, 1800)}
              </pre>
            </div>
          </section>
        </>
      )}
    </AppShell>
  );
}
