import { AppShell, PageIntro } from "@/components/insight-card";
import { getState } from "@/lib/store";
import { formatTerminalTime } from "@/lib/briefing/theme-summary";

export const dynamic = "force-dynamic";

const KIND = {
  partial: { label: "Partial", fg: "#fbbf24", bg: "rgba(251, 191, 36, 0.12)" },
  wrong: { label: "Wrong", fg: "#f87171", bg: "rgba(248, 113, 113, 0.12)" },
  missed: { label: "Missed", fg: "#c084fc", bg: "rgba(192, 132, 252, 0.12)" },
  new: { label: "New", fg: "#4ade80", bg: "rgba(74, 222, 128, 0.12)" },
} as const;

const JUDGE = {
  promote: { fg: "#4ade80", bg: "rgba(74, 222, 128, 0.12)" },
  hold: { fg: "#fbbf24", bg: "rgba(251, 191, 36, 0.12)" },
  regress: { fg: "#f87171", bg: "rgba(248, 113, 113, 0.12)" },
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
        <p className="border border-border bg-card p-4 text-[13px] text-muted-foreground">
          No eval tape yet. Ingest a source and the sweep will land here.
        </p>
      ) : (
        <>
          <div className="mb-4 border border-border bg-card px-4 py-3">
            <p className="text-[11px] text-muted-foreground">Champion</p>
            <p className="mt-0.5 text-[13px] font-medium">
              {state.champion_prompt_version}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Composite {champion.metrics.composite.toFixed(3)} · gold{" "}
              {state.gold.length} · last {formatTerminalTime(champion.ran_at)}
            </p>
          </div>

          <div className="overflow-x-auto border border-border bg-card">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-border text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">Comp</th>
                  <th className="px-3 py-2 font-medium">F1</th>
                  <th className="px-3 py-2 font-medium">Partial</th>
                  <th className="px-3 py-2 font-medium">Wrong</th>
                  <th className="px-3 py-2 font-medium">Missed</th>
                  <th className="px-3 py-2 font-medium">New</th>
                  <th className="px-3 py-2 font-medium">Judge</th>
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
                        champ ? "bg-muted/50" : ""
                      }`}
                    >
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{run.prompt_version}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {run.strategy}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {run.metrics.composite.toFixed(3)}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {run.metrics.f1.toFixed(3)}
                      </td>
                      <td className="px-3 py-2.5">{run.metrics.partial}</td>
                      <td className="px-3 py-2.5">{run.metrics.wrong}</td>
                      <td className="px-3 py-2.5">{run.metrics.missed}</td>
                      <td className="px-3 py-2.5">{run.metrics.novel}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className="inline-flex rounded-md px-1.5 py-0.5 text-[11px] capitalize"
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

          <section className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="border border-border bg-card p-4">
              <h2 className="text-[13px] font-medium">
                Critique · {champion.prompt_version}
              </h2>
              <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
                {champion.judge.rationale}
              </p>
              <ul className="mt-3 max-h-[480px] space-y-2 overflow-auto">
                {champion.critique.slice(0, 24).map((f, idx) => {
                  const kind = KIND[f.kind];
                  return (
                    <li
                      key={`${f.kind}-${idx}`}
                      className="border border-border p-3"
                    >
                      <div
                        className="inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                        style={{ color: kind.fg, backgroundColor: kind.bg }}
                      >
                        {kind.label}
                        {f.gold_id ? ` · ${f.gold_id}` : ""}
                      </div>
                      <p className="mt-2 text-[13px] leading-5">{f.statement}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {f.rationale}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="border border-border bg-card p-4">
              <h2 className="text-[13px] font-medium">Proposer patch</h2>
              <p className="mt-2 text-[13px]">
                Next {champion.proposal.recommended_prompt_version}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[13px] leading-5">
                {champion.proposal.rationale.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <pre className="mt-3 max-h-80 overflow-auto bg-muted p-3 font-mono text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
                {champion.proposal.prompt_patch.slice(0, 1800)}
              </pre>
            </div>
          </section>
        </>
      )}
    </AppShell>
  );
}
