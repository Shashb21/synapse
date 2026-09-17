import { AppShell, PageIntro } from "@/components/app-shell";
import { IngestPanel } from "@/components/ingest-panel";
import { LockForm } from "@/components/lock-form";
import { GapPlanCard, PrioritizeQueue, ReviewQueue } from "@/components/plan-cards";
import { Wizard } from "@/components/wizard";
import { StaleFlag } from "@/components/iegp-badges";
import { loadState } from "@/lib/iegp/store";
import {
  buildPlanWorkspace,
  wizardStartStep,
  type PlanColumn,
} from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

const COLUMNS: { id: PlanColumn; title: string; hint: string }[] = [
  { id: "high", title: "High", hint: "Critical and high — staff these first" },
  { id: "medium", title: "Medium", hint: "Decision-relevant, not this cycle's blocker" },
  { id: "low", title: "Low", hint: "Keep on the inventory; do not staff first" },
];

export default async function HomePage() {
  const state = await loadState();
  const workspace = buildPlanWorkspace(state);

  if (!state.asset.wizard_complete) {
    const start = wizardStartStep(state, workspace);
    return (
      <AppShell active="plan">
        <PageIntro kicker={`${state.asset.inn} · first visit`} title={`Set up the ${state.asset.name} IEGP`}>
          Wizard once, plan forever. Upload sources, accept or reject the extracted gaps and
          tactics, then lock priority yourself. After you enter the plan, this stepper goes away.
        </PageIntro>
        <Wizard
          initialStep={start}
          hasSources={state.sources.length > 0}
          upload={<IngestPanel sources={state.sources} />}
          review={
            <section>
              <h2 className="text-[15px] font-medium text-foreground">Review gaps and tactics</h2>
              <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
                Same gate for both. Accept, reject, or modify. The engine does not accept for you.
              </p>
              <ReviewQueue
                gaps={workspace.review}
                tactics={workspace.reviewTactics}
                emptyHint="Ingest a source first, then review what it extracted."
              />
            </section>
          }
          prioritize={
            <section>
              <h2 className="text-[15px] font-medium text-foreground">Prioritize</h2>
              <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
                Accepted open and partial gaps with a residual. You lock High, Medium, or Low —
                the engine does not suggest a band.
              </p>
              <PrioritizeQueue cards={workspace.unprioritized} />
            </section>
          }
          enterPlan={
            <LockForm label="Enter the plan" action="complete_wizard" confirmLabel="Go to the plan" />
          }
        />
      </AppShell>
    );
  }

  const stale = state.coverages.some((c) => c.stale);
  const inboxCount = workspace.review.length + workspace.reviewTactics.length;

  return (
    <AppShell active="plan">
      <PageIntro kicker={`${state.asset.inn} · living plan`} title={`${state.asset.name} IEGP`}>
        {state.asset.indication} · {state.asset.geography}. New ingest drops candidate gaps and
        tactics into the inbox on this page. You still lock priority. Assign only accepted tactics.
      </PageIntro>

      <section className="mb-10" aria-labelledby="inbox">
        <div className="mb-1 flex items-baseline gap-2">
          <h2 id="inbox" className="text-[15px] font-medium text-foreground">
            Inbox
          </h2>
          {inboxCount ? (
            <span className="text-[12px] text-muted-foreground">{inboxCount}</span>
          ) : null}
        </div>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Newly extracted gaps and tactics. Accept, reject, or modify before they join the plan.
        </p>
        <ReviewQueue
          gaps={workspace.review}
          tactics={workspace.reviewTactics}
          emptyHint="Inbox is empty. Ingest another source below when you have new material."
        />
      </section>

      <section className="mb-10" aria-labelledby="prioritize-gaps">
        <h2 id="prioritize-gaps" className="text-[15px] font-medium text-foreground">
          Prioritize
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Accepted gaps still missing a human-locked band.
        </p>
        <PrioritizeQueue cards={workspace.unprioritized} />
      </section>

      <h2 className="mb-3 text-[15px] font-medium text-foreground">Prioritized plan</h2>
      <p className="mb-4 text-[12px] text-muted-foreground">
        After the band is locked, create a tactic or assign an accepted one. Coverage is not
        priority.
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => (
          <section
            key={col.id}
            className="border border-border bg-card/40 p-3"
            aria-labelledby={`plan-${col.id}`}
          >
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 id={`plan-${col.id}`} className="text-[15px] font-medium text-foreground">
                {col.title}
              </h2>
              <span className="text-[11px] text-muted-foreground">
                {workspace.board[col.id].length}
              </span>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground">{col.hint}</p>
            <div className="grid gap-3">
              {workspace.board[col.id].length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No gaps in this band.</p>
              ) : (
                workspace.board[col.id].map((card) => (
                  <GapPlanCard
                    key={card.gap_id}
                    card={card}
                    availableTactics={workspace.availableTactics}
                    canAssign
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>

      <section className="mt-10" aria-labelledby="addressed-gaps">
        <h2 id="addressed-gaps" className="text-[15px] font-medium text-foreground">
          Addressed
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Closed gaps remain on the plan with the tactics that addressed them. The engine never
          writes this status.
        </p>
        {workspace.addressed.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No addressed gaps yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {workspace.addressed.map((card) => (
              <GapPlanCard
                key={card.gap_id}
                card={card}
                availableTactics={workspace.availableTactics}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="add-sources">
        <h2 id="add-sources" className="text-[15px] font-medium text-foreground">
          Add sources
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          New files extract into the inbox above. They do not restart the wizard.
        </p>
        <IngestPanel sources={state.sources} compact />
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <LockForm label="Reset to blank slate" action="reset" confirmLabel="Reset" />
        {stale ? <StaleFlag stale /> : null}
      </div>
    </AppShell>
  );
}
