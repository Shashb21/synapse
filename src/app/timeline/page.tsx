import "@/modules";
import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { TimelineBoard, type PlanView } from "@/components/timeline/timeline-board";
import { loadState } from "@/lib/iegp/store";
import { isLiveGap } from "@/lib/iegp/engine";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { latestPlan, planHistory, timelineModel } from "@/modules/stages/s10-timeline/module";

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
  const [model, plan, history, identity, state] = await Promise.all([
    timelineModel(),
    latestPlan(),
    planHistory(5),
    sessionContext(),
    loadState(),
  ]);

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
          The validated plan as one interactive Gantt. Each activity carries the gap it answers, the tactic
          that answers it, and the readout its neighbours wait on. Click an activity for its full record,
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
        today={new Date().toISOString().slice(0, 10)}
        identity={{
          signed_in: identity.signed_in,
          actor_name: identity.actor.name,
          actor_function: identity.actor.function,
        }}
        plan={asView(plan)}
        history={history.map((entry) => asView(entry)!).filter(Boolean)}
        canSaveFinal={can(identity.role, "save_final")}
        canReschedule={can(identity.role, "validate")}
        gapDomains={gapDomains}
        addable={addable}
      />
    </AppShell>
  );
}
