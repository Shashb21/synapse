import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { IngestPanel } from "@/components/ingest-panel";
import { LockForm } from "@/components/lock-form";
import { GapsWorkbench } from "@/components/gaps-workbench";
import { PrioritizePlace } from "@/components/prioritize/prioritize-place";
import { TacticsPlace } from "@/components/tactics-place";
import { ManualStart } from "@/components/plan-cards";
import { StepWaiting } from "@/components/step-waiting";
import { aiEnabled } from "@/modules/kernel/ai-switch";
import { loadState, ensureAllLiveGapsHaveNeeds } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import {
  buildPlanWorkspace,
  defaultPlanPlace,
  gapsReadyForPrioritize,
  isPlanPlace,
  planGates,
  reviewGapFilterCounts,
  REVIEW_GAP_FILTERS,
  settingOptions,
  type PlanPlace,
  type ReviewGapFilter,
} from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

function PlaceIntro({
  place,
  wizardComplete,
  ai,
}: {
  place: PlanPlace;
  wizardComplete: boolean;
  ai: boolean;
}) {
  if (place === "upload" && !ai) {
    return (
      <PageIntro kicker="AI is off · manual plan" title="Start">
        Nothing is uploaded or parsed while AI is off. Add your gaps and the tactics you already
        have by hand, then map, prioritize and date them yourself.
      </PageIntro>
    );
  }
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
        accept/reject inbox. Map existing library tactics, or record a missed real study. Do not
        invent proposed tactics here. Add Open or Addressed gaps (Addressed needs a tactic). Partial
        must be split or rewritten before Prioritize.
      </PageIntro>
    );
  }
  if (place === "tactics") {
    return (
      <PageIntro kicker="Open gaps only" title="Tactics">
        Create and assign proposed tactics for Open gaps after they are prioritized. Proposed tactics
        do not change gap status until they are planned, ongoing, or completed. Recording missed
        real studies happens on Gaps.
      </PageIntro>
    );
  }
  return (
    <PageIntro kicker={wizardComplete ? "Living plan" : "Open gaps"} title="Prioritize">
      {ai
        ? "Pick a setting and two axes. Open gaps land on the matrix as a first draft — drag them to set their priority, then validate each one."
        : "Pick a setting and two axes, then place each Open gap by hand — type its scores or band, or drop it on the matrix — and validate each one."}
    </PageIntro>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ place?: string; gap_filter?: string; setting?: string }>;
}) {
  await ensureAllLiveGapsHaveNeeds();
  const state = await loadState();
  const workspace = buildPlanWorkspace(state);
  const gates = planGates(state);
  const ai = await aiEnabled().catch(() => true);
  // With AI off nothing is ingested, so Gaps never waits for a source.
  const gapsUnlocked = gates.gapsUnlocked || !ai;
  const params = await searchParams;
  if (params.place === "mappings") redirect("/mappings");
  const requested =
    params.place === "review" || params.place === "library" ? "gaps" : params.place;
  const suggested = defaultPlanPlace(state, workspace);
  // With AI off the first screen is Start (Add gaps / Add tactics) until there are gaps.
  const fallback: PlanPlace =
    !ai && suggested === "upload" && workspace.review.length > 0 ? "gaps" : suggested;
  const place: PlanPlace = isPlanPlace(requested) ? requested : fallback;
  const ready = gapsReadyForPrioritize(state);
  const gapFilter = (REVIEW_GAP_FILTERS as readonly string[]).includes(params.gap_filter ?? "")
    ? (params.gap_filter as ReviewGapFilter)
    : undefined;

  let pane: ReactNode;
  if (place === "upload") {
    const readiness = reviewGapFilterCounts(workspace.review);
    pane = (
      <>
        {ai ? (
          <IngestPanel sources={state.sources} />
        ) : (
          <ManualStart
            gapCount={workspace.review.length}
            tacticCount={workspace.availableTactics.length}
          />
        )}
        {workspace.review.length > 0 ? (
          <section className="mt-8 border border-border bg-card/40 p-4" aria-labelledby="upload-readiness">
            <h2 id="upload-readiness" className="text-[13px] font-medium text-foreground">
              Prep readiness
            </h2>
            <ul className="mt-2 grid gap-1 text-[12px] text-muted-foreground">
              <li>{readiness.all} gap{readiness.all === 1 ? "" : "s"} mapped</li>
              <li>{readiness.partial} partial — must resolve before Prioritize</li>
              <li>{readiness.needs_validation} unconfirmed</li>
            </ul>
            <p className="mt-2 text-[12px] text-foreground">
              {ready ? "Ready for Prioritize." : "Not ready for Prioritize yet — resolve Partial and confirm every gap on Gaps."}
            </p>
          </section>
        ) : null}
      </>
    );
  } else if (place === "gaps") {
    pane = (
      <>
        {!gapsUnlocked ? (
          <StepWaiting
            title="Waiting on Upload"
            body="Nothing has been ingested yet, so there are no extracted gaps to review. Upload a source first, or add a gap by hand below."
            href="/?place=upload"
            cta="Go to Upload"
          />
        ) : null}
        <GapsWorkbench
          cards={workspace.review}
          availableTactics={workspace.availableTactics}
          readyForPrioritize={ready}
          initialFilter={gapFilter}
          settingOptions={settingOptions(state)}
        />
      </>
    );
  } else if (place === "tactics") {
    // The validated matrix band is the gap's priority.
    const placements = new Map((await listPlacements()).map((row) => [row.gap_id, row]));
    const openGaps = workspace.openGaps.map((card) => {
      const placement = placements.get(card.gap_id);
      return placement?.validated && placement.band ? { ...card, band: placement.band } : card;
    });
    pane = (
      <TacticsPlace
        ready={gates.tacticsUnlocked}
        openGaps={openGaps}
        availableTactics={workspace.availableTactics}
      />
    );
  } else {
    pane = (
      <>
        {!gates.planUnlocked ? (
          <StepWaiting
            title="Waiting on Gaps"
            body="Prioritize needs every live gap validated, with Partially Addressed gaps split or rewritten. Until then the matrix shows only the gaps already validated as Open, so priorities will be incomplete."
            href="/?place=gaps"
            cta="Go to Gaps"
          />
        ) : null}
        <PrioritizePlace
          state={state}
          setting={params.setting}
          addressed={workspace.addressed}
          availableTactics={workspace.availableTactics}
        />
      </>
    );
  }

  return (
    <AppShell active={place}>
      <PlaceIntro place={place} wizardComplete={state.asset.wizard_complete} ai={ai} />
      {pane}
      {place === "upload" ? (
        <div className="mt-8">
          <LockForm label="Reset to blank slate" action="reset" confirmLabel="Reset" />
        </div>
      ) : null}
    </AppShell>
  );
}
