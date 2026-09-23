import "@/modules";
import { AppShell, PageIntro } from "@/components/app-shell";
import { PresentationView, type PresentationData } from "@/components/presentation/presentation-view";
import { buildPlanWorkspace, gapsReadyForPrioritize, reviewGapFilterCounts } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import { timelineModel } from "@/modules/stages/s10-timeline/module";

export const dynamic = "force-dynamic";

export default async function PresentationPage() {
  const [state, model] = await Promise.all([loadState(), timelineModel()]);
  const workspace = buildPlanWorkspace(state);
  const readiness = reviewGapFilterCounts(workspace.review);

  const data: PresentationData = {
    context: {
      assetName: state.asset.name,
      inn: state.asset.inn,
      indication: state.asset.indication,
      geography: state.asset.geography,
      objectives: state.objectives.map((objective) => ({
        id: objective.id,
        name: objective.name,
        description: objective.description,
      })),
      gapsCount: readiness.all,
      partialCount: readiness.partial,
      unconfirmedCount: readiness.needs_validation,
      readyForPrioritize: gapsReadyForPrioritize(state),
    },
    gaps: workspace.review,
    board: workspace.board,
    addressed: workspace.addressed,
    timelineModel: model,
    today: new Date().toISOString().slice(0, 10),
  };

  return (
    <AppShell active="presentation">
      <PageIntro kicker="Read-only · leave-behind" title="Present this plan">
        A chaptered walkthrough of the validated plan — context, gaps, tactics, timeline. Nothing
        here can be edited; it is a projection of the same state as the rest of Synapse.
      </PageIntro>
      <PresentationView data={data} />
    </AppShell>
  );
}
