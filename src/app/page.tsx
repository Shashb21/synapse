import type { ReactNode } from "react";
import { AppShell, PageIntro } from "@/components/app-shell";
import { IngestPanel } from "@/components/ingest-panel";
import { LockForm } from "@/components/lock-form";
import {
  GapPlanCard,
  OpenGapsQueue,
  PrioritizeQueue,
  ReviewQueue,
  SuggestedMappings,
  TacticLibrary,
} from "@/components/plan-cards";
import { StaleFlag } from "@/components/iegp-badges";
import { loadState } from "@/lib/iegp/store";
import {
  buildPlanWorkspace,
  defaultPlanPlace,
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
        Demo files and your own notes extract candidate gaps and tactics into Review. After you
        enter the plan, ingest stays here — it does not restart a wizard.
      </PageIntro>
    );
  }
  if (place === "review") {
    return (
      <PageIntro kicker="Accept, reject, or modify" title="Review">
        Step 1 after ingest: validate extracted gaps and tactics. Create gap and Create tactic live
        here. Leftover evidence need is not dumped onto the parent — it is suggested as a new gap on
        Mappings after a pressure-test.
      </PageIntro>
    );
  }
  if (place === "mappings") {
    return (
      <PageIntro kicker="Inventory joins" title="Mappings">
        Step 2: a scored engine suggests gap–tactic pairs after both are accepted. When overall
        coverage is locked partial or limited, leftover is suggested as a new gap. Accept creates the
        child (parent preserved). Reject persists and does not spam.
      </PageIntro>
    );
  }
  if (place === "library") {
    return (
      <PageIntro kicker="Accepted inventory" title="Tactic library">
        Extracted tactics enter after you accept them. Create gap and Create tactic live here.
        Creating a tactic adds it as accepted. Tag the same tactic onto as many gaps as you need.
      </PageIntro>
    );
  }
  return (
    <PageIntro kicker={wizardComplete ? "Living plan" : "Ready for the plan"} title="Plan">
      High / Medium / Low lists prioritized leftovers after a tactic only partially fills a gap.
      Open accepted gaps with no residual wait on Mappings for tactics and coverage.
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
  const requested = (await searchParams).place;
  const fallback = defaultPlanPlace(state, workspace);
  const place: PlanPlace = isPlanPlace(requested) ? requested : fallback;
  const stale = state.coverages.some((c) => c.stale);

  let pane: ReactNode;
  if (place === "upload") {
    pane = <IngestPanel sources={state.sources} />;
  } else if (place === "review") {
    pane = gates.reviewUnlocked ? (
      <ReviewQueue
        gaps={workspace.review}
        tactics={workspace.reviewTactics}
        residuals={workspace.residualGapSuggestions}
        availableTactics={workspace.availableTactics}
        emptyHint="Inbox is empty. Ingest a source on Upload when you have new material."
      />
    ) : (
      <LockedPlace
        title="Review is locked"
        body="Ingest at least one source on Upload. Candidates land here."
      />
    );
  } else if (place === "mappings") {
    pane = gates.mappingsUnlocked ? (
      <div className="grid gap-10">
        <SuggestedMappings items={workspace.mappingSuggestions} />
        <section aria-labelledby="accepted-gaps">
          <h2 id="accepted-gaps" className="text-[15px] font-medium text-foreground">
            Accepted gaps
          </h2>
          <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
            Assign from the library onto an accepted open or partial gap. Coverage is still unknown
            until you lock it on the gap.
          </p>
          <OpenGapsQueue
            cards={workspace.openGaps}
            availableTactics={workspace.availableTactics}
          />
        </section>
      </div>
    ) : (
      <LockedPlace
        title="Mappings is locked"
        body="Ingest a source, then accept a gap and a tactic in Review."
      />
    );
  } else if (place === "library") {
    pane = gates.libraryUnlocked ? (
      <TacticLibrary items={workspace.availableTactics} />
    ) : (
      <LockedPlace
        title="Library is locked"
        body="Ingest a source, then accept an extracted tactic or create one here after Review unlocks."
      />
    );
  } else if (!gates.planUnlocked) {
    pane = (
      <LockedPlace
        title="Plan is locked"
        body="Ingest a source, then accept a gap or tactic. The plan lists prioritized leftovers — not every open gap."
      />
    );
  } else {
    pane = (
      <>
        {!state.asset.wizard_complete ? (
          <div className="mb-8 border border-border bg-card/40 p-4">
            <h2 className="text-[15px] font-medium text-foreground">Enter the plan</h2>
            <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
              Wizard once, plan forever. After this, the home page opens here. Later ingest stays on
              Upload and drops candidates into Review.
            </p>
            <LockForm
              label="Enter the plan"
              action="complete_wizard"
              confirmLabel="Go to the plan"
            />
          </div>
        ) : null}

        <section className="mb-10" aria-labelledby="prioritize-gaps">
          <h2 id="prioritize-gaps" className="text-[15px] font-medium text-foreground">
            Prioritize
          </h2>
          <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
            Leftover residuals after a mapped tactic only partially fills the gap. You lock High,
            Medium, or Low — the engine does not suggest a band.
          </p>
          <PrioritizeQueue
            cards={workspace.unprioritized}
            availableTactics={workspace.availableTactics}
          />
        </section>

        <h2 className="mb-3 text-[15px] font-medium text-foreground">Prioritized plan</h2>
        <p className="mb-4 text-[12px] text-muted-foreground">
          After the band is locked, assign an accepted tactic. Coverage is not priority.
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

        <div className="mt-8 flex flex-wrap items-center gap-3">
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
