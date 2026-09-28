import "@/modules";
import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { TimelineBoard, type PlanView } from "@/components/timeline/timeline-board";
import { loadState } from "@/lib/iegp/store";
import { isLiveGap } from "@/lib/iegp/engine";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { latestPlan, planHistory, timelineModel } from "@/modules/stages/s10-timeline/module";
import { gapTimelineView } from "@/modules/stages/s10-timeline/gap-view";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

export const dynamic = "force-dynamic";

function asView(plan: Awaited<ReturnType<typeof latestPlan>>): PlanView | null {
  if (!plan) return null;
  return {
    version: plan.version,
    status: plan.status,
    note: plan.note,
    saved_by: plan.saved_by,
    saved_at: plan.saved_at,
    activities: plan.snapshot.activities.length,
  };
}

export default async function TimelinePage() {
  const [model, plan, history, identity, state, placements] = await Promise.all([
    timelineModel(),
    latestPlan(),
    planHistory(5),
    sessionContext(),
    loadState(),
    listPlacements(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const view = gapTimelineView({ model, state, placements, today });

  // Tactics not on the timeline in any form: a user can add any of them by hand.
  const onTimeline = new Set([
    ...model.activities.map((row) => row.tactic_id),
    ...model.pending.map((row) => row.tactic_id),
    ...model.removed.map((row) => row.tactic_id),
  ]);
  const addable = state.tactics
    .filter(
      (tactic) =>
        !onTimeline.has(tactic.id) && tactic.status !== "cancelled" && tactic.review_status !== "rejected",
    )
    .map((tactic) => ({ tactic_id: tactic.id, name: tactic.name }));

  const gapDomains: Record<string, string> = {};
  for (const gap of state.gaps.filter(isLiveGap)) {
    gapDomains[gap.id] = gap.domain;
  }

  return (
    <AppShell active="timeline">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-2">
        <PageIntro kicker="S10 · the truth artifact" title="IEGP timeline">
          Every prioritized gap, highest band first, with the activities that answer it beneath it. Date,
          drag, add and sequence activities by hand, no model needed; click an activity for its full record,
          export the chart as an image, and save the version you stand behind.
        </PageIntro>
        <div className="flex flex-wrap gap-3 text-[12px] text-muted-foreground">
          <Link href="/breakouts" className="no-underline hover:underline">
            Open breakouts →
          </Link>
          <Link href="/presentation" className="no-underline hover:underline">
            Present this plan →
          </Link>
        </div>
      </div>

      <TimelineBoard
        model={model}
        view={view}
        today={today}
        identity={{
          signed_in: identity.signed_in,
          actor_name: identity.actor.name,
          actor_function: identity.actor.function,
        }}
        plan={asView(plan)}
        history={history.map((entry) => asView(entry)!).filter(Boolean)}
        canSaveFinal={can(identity.role, "save_final")}
        canReschedule={can(identity.role, "validate")}
        canRun={can(identity.role, "run_stage")}
        canCreate={can(identity.role, "validate") && can(identity.role, "ideate")}
        canEditDetails={can(identity.role, "ideate")}
        gapDomains={gapDomains}
        addable={addable}
      />
    </AppShell>
  );
}
