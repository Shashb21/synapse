import type { ReactNode } from "react";
import { AppShell, PageIntro } from "@/components/app-shell";
import { IngestPanel } from "@/components/ingest-panel";
import { LockForm } from "@/components/lock-form";
import { GapStatusGuide } from "@/components/gap-status-guide";
import { GapsWorkbench } from "@/components/gaps-workbench";
import { GapPlanCard, PrioritizeQueue } from "@/components/plan-cards";
import { TacticsPlace } from "@/components/tactics-place";
import { StaleFlag } from "@/components/iegp-badges";
import { loadState } from "@/lib/iegp/store";
import {
  buildPlanWorkspace,
  defaultPlanPlace,
  gapsReadyForPrioritize,
  isPlanPlace,
  planGates,
  type PlanColumn,
  type PlanPlace,
} from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

const COLUMNS: { id: PlanColumn; title: string; hint: string }[] = [
  { id: "high", title: "High", hint: "Critical and high — staff these first" },
  { id: "medium", title: "Medium", hint: "Decision-relevant, not this cycle's blocker" },
  { id: "low", title: "Low", hint: "Keep on the inventory; do not staff first" },
];

function PlaceIntro({
  place,
  wizardComplete,
}: {
  place: PlanPlace;
  wizardComplete: boolean;
}) {
  if (place === "upload") {
    return (
      <PageIntro
        kicker={wizardComplete ? "Living plan · ingest" : "First visit · ingest"}
        title="Upload sources"
      >
        Demo files and notes extract gaps and tactics already mapped, with engine-computed status.
        After you enter Prioritize, ingest stays here.
      </PageIntro>
    );
  }
  if (place === "gaps") {
    return (
      <PageIntro kicker="Status engine · human validation" title="Gaps">
        Every extracted gap is shown with its mapped tactics and computed status. There is no
        accept/reject inbox. Add Open or Addressed gaps (Addressed needs a tactic). Partial must be
        split or rewritten before Prioritize.
      </PageIntro>
    );
  }
  if (place === "tactics") {
    return (
      <PageIntro kicker="Open gaps only" title="Tactics">
        Create and assign tactics for Open gaps after they are prioritized. Proposed tactics do not
        change gap status until they are planned, ongoing, or completed.
      </PageIntro>
    );
  }
  return (
    <PageIntro kicker={wizardComplete ? "Living plan" : "Open gaps"} title="Prioritize">
      High / Medium / Low are priority bands on Open gaps. Addressed gaps sit in their own bucket.
      Continue to Tactics when bands are set.
    </PageIntro>
  );
}

function LockedPlace({ title, body }: { title: string; body: string }) {
  return (
    <section className="border border-border bg-card/40 p-4">
      <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">{body}</p>
    </section>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ place?: string }>;
}) {
  const state = await loadState();
  const workspace = buildPlanWorkspace(state);
  const gates = planGates(state);
  const params = await searchParams;
  const requested =
    params.place === "review" || params.place === "mappings" || params.place === "library"
      ? "gaps"
      : params.place;
  const fallback = defaultPlanPlace(state, workspace);
  const place: PlanPlace = isPlanPlace(requested) ? requested : fallback;
  const stale = state.coverages.some((c) => c.stale);
  const ready = gapsReadyForPrioritize(state);

  let pane: ReactNode;
  if (place === "upload") {
    pane = <IngestPanel sources={state.sources} />;
  } else if (place === "gaps") {
    pane = gates.gapsUnlocked ? (
      <GapsWorkbench
        cards={workspace.review}
        availableTactics={workspace.availableTactics}
        readyForPrioritize={ready}
      />
    ) : (
      <LockedPlace title="Gaps is locked" body="Ingest at least one source on Upload." />
    );
  } else if (place === "tactics") {
    pane = (
      <TacticsPlace
        unlocked={gates.tacticsUnlocked}
        openGaps={workspace.openGaps}
        availableTactics={workspace.availableTactics}
      />
    );
  } else if (!gates.planUnlocked) {
    pane = (
      <LockedPlace
        title="Prioritize is locked"
        body="Validate every live gap on Gaps. Partially Addressed gaps must be split or rewritten."
      />
    );
  } else {
    pane = (
      <>
        <GapStatusGuide />
        <section className="mb-10" aria-labelledby="prioritize-gaps">
          <h2 id="prioritize-gaps" className="text-[15px] font-medium text-foreground">
            Prioritize open gaps
          </h2>
          <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
            You lock High, Medium, or Low — the engine does not assign a band.
          </p>
          <PrioritizeQueue
            cards={workspace.unprioritized}
            availableTactics={workspace.availableTactics}
          />
        </section>

        <h2 className="mb-3 text-[15px] font-medium text-foreground">Prioritized plan</h2>
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
          {workspace.addressed.length === 0 ? (
            <p className="mt-2 text-[12px] text-muted-foreground">No addressed gaps yet.</p>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
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

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {!state.asset.tactics_unlocked ? (
            <LockForm
              label="Continue to tactics"
              action="unlock_tactics"
              confirmLabel="Go to tactics"
            />
          ) : null}
          <LockForm label="Reset to blank slate" action="reset" confirmLabel="Reset" />
          {stale ? <StaleFlag stale /> : null}
        </div>
      </>
    );
  }

  return (
    <AppShell active={place}>
      <PlaceIntro place={place} wizardComplete={state.asset.wizard_complete} />
      {pane}
      {place === "upload" ? (
        <div className="mt-8">
          <LockForm label="Reset to blank slate" action="reset" confirmLabel="Reset" />
        </div>
      ) : null}
    </AppShell>
  );
}
