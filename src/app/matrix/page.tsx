import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { RunStageButton } from "@/components/platform/run-stage-button";
import { AxesEditor } from "@/components/matrix/axes-editor";
import { BandLegend, type Band } from "@/components/matrix/bands";
import { MatrixPlot } from "@/components/matrix/matrix-plot";
import type { MatrixCard } from "@/components/matrix/matrix-gap-card";
import { displayedGapStatus, isLiveGap, mappedTactics } from "@/lib/iegp/engine";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { DEFAULT_AXES, loadAxes, weightedScore } from "@/modules/stages/s8-prioritization/axes";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

export const dynamic = "force-dynamic";

export default async function MatrixPage() {
  const [state, axesConfig, placements, session] = await Promise.all([
    loadState(),
    loadAxes(),
    listPlacements(),
    sessionContext(),
  ]);

  const identity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };
  const mayPrioritize = can(session.role, "prioritize");

  const axes = axesConfig.axes.length ? axesConfig.axes : DEFAULT_AXES.axes;
  const xAxis = axes.find((axis) => axis.id === axesConfig.x_axis) ?? axes[0];
  const yAxis = axes.find((axis) => axis.id === axesConfig.y_axis) ?? axes[1] ?? axes[0];

  const openGaps = state.gaps.filter(
    (gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open",
  );

  const cards: MatrixCard[] = [];
  const unscored: { gap_id: string; gap_name: string; domain_label: string }[] = [];
  for (const gap of openGaps) {
    const placement = placements.find((row) => row.gap_id === gap.id);
    const domain_label = DOMAIN_LABELS[gap.domain];
    if (!placement) {
      unscored.push({ gap_id: gap.id, gap_name: gap.name, domain_label });
      continue;
    }
    cards.push({
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      domain_label,
      axis_scores: placement.axis_scores,
      score: weightedScore(placement.axis_scores, axes),
      band: (placement.validated && placement.band ? placement.band : placement.suggested_band) as Band,
      validated: placement.validated,
      suggested_band: placement.suggested_band,
      suggested_rationale: placement.suggested_rationale,
      rationale: placement.rationale,
      actor_name: placement.actor_name,
      at: placement.at,
      tactic_count: mappedTactics(state, gap.id).length,
    });
  }
  cards.sort((a, b) => b.score - a.score || a.gap_name.localeCompare(b.gap_name));

  const counts: Record<Band, number> = { high: 0, medium: 0, low: 0 };
  for (const card of cards) counts[card.band] += 1;
  const validatedCount = cards.filter((card) => card.validated).length;

  return (
    <AppShell active="matrix">
      <PageIntro kicker="S8 · Prioritization" title="Prioritization matrix">
        Every validated Open gap sits on the two axes you choose, scored 0–100 on each configured
        axis. The shaded regions are the High / Medium / Low thresholds on the weighted score. S8
        only suggests a band — it stays a suggestion until someone validates it with a rationale.
      </PageIntro>

      <div className="grid gap-4">
        <AxesEditor
          config={{
            axes: axesConfig.axes,
            x_axis: axesConfig.x_axis,
            y_axis: axesConfig.y_axis,
            bands: axesConfig.bands,
          }}
          updatedBy={axesConfig.updated_by}
          updatedAt={axesConfig.updated_at}
          identity={identity}
          mayPrioritize={mayPrioritize}
        />

        {cards.length === 0 ? (
          <section className="grid gap-3 rounded-md border border-border bg-card/40 p-4">
            <h2 className="text-[13px] text-foreground">No gap is on the matrix yet</h2>
            <p className="max-w-2xl text-[12px] leading-5 text-muted-foreground">
              S8 scores every validated Open gap on the configured axes and derives a suggested
              band. Run it to place cards here. If nothing appears afterwards, there is no validated
              Open gap yet — classify gaps on{" "}
              <Link href="/?place=gaps" className="text-foreground no-underline hover:underline">
                Gaps
              </Link>{" "}
              first.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <RunStageButton
                stage="S8"
                input={{}}
                label="Run S8 prioritization"
                identity={identity}
                variant="default"
              />
              <span className="text-[11px] text-muted-foreground">
                {openGaps.length} validated Open gap(s) in the plan
              </span>
            </div>
          </section>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <BandLegend counts={counts} />
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[11px] text-muted-foreground">
                  {validatedCount} of {cards.length} band(s) validated
                </span>
                <RunStageButton
                  stage="S8"
                  input={{}}
                  label="Re-run S8"
                  identity={identity}
                  variant="outline"
                />
              </div>
            </div>

            <MatrixPlot
              cards={cards}
              axes={axes}
              xAxis={xAxis}
              yAxis={yAxis}
              bands={axesConfig.bands}
              identity={identity}
              mayPrioritize={mayPrioritize}
            />

            <p className="max-w-2xl text-[11px] leading-4 text-muted-foreground">
              Click a card to expand it for the gap statement, every axis score and the suggestion
              rationale. Each card sits in the card-sized slot its two plotted scores fall into, so
              no card hides another; gaps that share a slot share one cluster card. The band
              boundary runs diagonally because the band follows the weighted score across all{" "}
              {axes.length} axes, not just the two on the edges.
            </p>
          </>
        )}

        {unscored.length > 0 ? (
          <section className="grid gap-2 rounded-md border border-border bg-card/40 p-3">
            <h2 className="text-[13px] text-foreground">
              Not scored yet ({unscored.length})
            </h2>
            <p className="text-[12px] text-muted-foreground">
              These validated Open gaps have no S8 placement. Re-run S8 to score them.
            </p>
            <ul className="flex flex-wrap gap-2">
              {unscored.map((gap) => (
                <li key={gap.gap_id} className="rounded-md border border-border bg-background p-2">
                  <Link
                    href={`/gaps/${gap.gap_id}`}
                    className="text-[12px] text-foreground no-underline hover:underline"
                  >
                    {gap.gap_name}
                  </Link>
                  <p className="text-[10px] text-muted-foreground">{gap.domain_label}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
