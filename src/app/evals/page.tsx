import { AppShell } from "@/components/insight-card";
import { getState } from "@/lib/store";
import { formatTerminalTime } from "@/lib/briefing/theme-summary";

export const dynamic = "force-dynamic";

const KIND = {
  partial: "PARTIAL",
  wrong: "WRONG",
  missed: "MISSED",
  new: "NEW",
} as const;

export default async function EvalsPage() {
  const state = await getState();
  const runs = state.eval_runs;
  const champion =
    runs.find((r) => r.prompt_version === state.champion_prompt_version) ??
    runs[runs.length - 1];

  return (
    <AppShell active="evals">
      <div className="mb-3 border-b border-border pb-2">
        <h1 className="text-sm tracking-[0.25em] text-primary">EVAL TAPE</h1>
        <p className="mt-1 max-w-3xl text-[11px] text-muted-foreground">
          Hill-climb runs automatically on seed and on every ingest. This screen
          is view-only: critique, judge, and proposer already scored the ladder.
        </p>
      </div>

      {runs.length === 0 || !champion ? (
        <p className="text-[12px] text-muted-foreground">
          No eval tape yet. Ingest a source and the sweep will land here.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[11px] text-muted-foreground">
            CHAMPION {state.champion_prompt_version} · COMPOSITE{" "}
            {champion.metrics.composite.toFixed(3)} · GOLD {state.gold.length} ·
            LAST {formatTerminalTime(champion.ran_at)}
          </p>
          <div className="overflow-x-auto border border-border">
            <table className="w-full min-w-[720px] text-left text-[12px]">
              <thead className="border-b border-border bg-muted/40 text-[10px] tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-2 py-2">VERSION</th>
                  <th className="px-2 py-2">COMP</th>
                  <th className="px-2 py-2">F1</th>
                  <th className="px-2 py-2">PARTIAL</th>
                  <th className="px-2 py-2">WRONG</th>
                  <th className="px-2 py-2">MISSED</th>
                  <th className="px-2 py-2">NEW</th>
                  <th className="px-2 py-2">JUDGE</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const champ =
                    run.prompt_version === state.champion_prompt_version;
                  return (
                    <tr
                      key={run.id}
                      className={`border-b border-border ${champ ? "bg-muted/50 text-primary" : ""}`}
                    >
                      <td className="px-2 py-2">
                        {run.prompt_version}
                        <div className="text-[10px] text-muted-foreground">
                          {run.strategy}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        {run.metrics.composite.toFixed(3)}
                      </td>
                      <td className="px-2 py-2">{run.metrics.f1.toFixed(3)}</td>
                      <td className="px-2 py-2">{run.metrics.partial}</td>
                      <td className="px-2 py-2">{run.metrics.wrong}</td>
                      <td className="px-2 py-2">{run.metrics.missed}</td>
                      <td className="px-2 py-2">{run.metrics.novel}</td>
                      <td className="px-2 py-2">{run.judge.decision}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section className="mt-4 grid gap-0 border border-border lg:grid-cols-2">
            <div className="border-b border-border p-3 lg:border-r lg:border-b-0">
              <h2 className="text-[10px] tracking-widest text-muted-foreground">
                CRITIQUE · {champion.prompt_version}
              </h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {champion.judge.rationale}
              </p>
              <ul className="mt-3 max-h-[420px] space-y-2 overflow-auto">
                {champion.critique.slice(0, 24).map((f, idx) => (
                  <li key={`${f.kind}-${idx}`} className="border border-border p-2">
                    <div className="text-[10px] tracking-widest text-primary">
                      {KIND[f.kind]}
                      {f.gold_id ? ` · ${f.gold_id}` : ""}
                    </div>
                    <p className="mt-1 text-[12px]">{f.statement}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {f.rationale}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
            <div className="p-3">
              <h2 className="text-[10px] tracking-widest text-muted-foreground">
                PROPOSER PATCH
              </h2>
              <p className="mt-1 text-[12px]">
                NEXT {champion.proposal.recommended_prompt_version}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px]">
                {champion.proposal.rationale.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <pre className="mt-3 max-h-72 overflow-auto bg-muted p-2 text-[10px] leading-4 whitespace-pre-wrap text-muted-foreground">
                {champion.proposal.prompt_patch.slice(0, 1800)}
              </pre>
            </div>
          </section>
        </>
      )}
    </AppShell>
  );
}
