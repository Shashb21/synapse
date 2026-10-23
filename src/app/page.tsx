import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { IngestPanel } from "@/components/ingest-panel";
import { InventoryReadiness } from "@/components/inventory-readiness";
import { LockForm } from "@/components/lock-form";
import { GapsWorkbench } from "@/components/gaps-workbench";
import { pendingSuggestionCards } from "@/lib/iegp/gap-suggestion-cards";
import { PrioritizePlace } from "@/components/prioritize/prioritize-place";
import { TacticsPlace } from "@/components/tactics-place";
import { loadTacticIdeation } from "@/components/tactic-ideation/data";
import { ManualStart, ManualStartAlongsideUpload } from "@/components/plan-cards";
import { AiOnly } from "@/components/platform/ai-status";
import { StepWaiting } from "@/components/step-waiting";
import { RejectedTactics, SetAsideGaps } from "@/components/restore-actions";
import { aiSections } from "@/modules/kernel/ai-switch";
import { noAiSections, type AiSections } from "@/modules/kernel/ai-sections";
import { currentWorkspaceIsDemo } from "@/modules/workspaces/session";
import { loadState } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import {
  buildPlanWorkspace,
  defaultPlanPlace,
  gapsReadyForPrioritize,
  isPlanPlace,
  planGates,
  REVIEW_GAP_FILTERS,
  settingOptions,
  type PlanPlace,
  type ReviewGapFilter,
} from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

function PlaceIntro({
  place,
  wizardComplete,
  sections,
}: {
  place: PlanPlace;
  wizardComplete: boolean;
  sections: AiSections;
}) {
  if (place === "upload" && !sections.ingestion) {
    return (
      <PageIntro kicker="Manual plan" title="Start">
        Add your gaps and the tactics you already have, then map, prioritize and date them.
      </PageIntro>
    );
  }
  if (place === "upload") {
    return (
      <PageIntro
        kicker={wizardComplete ? "Living plan · ingest" : "First visit · ingest"}
        title="Upload sources"
      >
        Upload sources or paste notes, then review the extracted gaps and tactics in Evidence Inventory.
        You can also add gaps and tactics by hand.
      </PageIntro>
    );
  }
  if (place === "gaps") {
    return (
      <PageIntro kicker="Gaps & metadata" title="Evidence Inventory">
        Review evidence status, confirm evidence assessments, and resolve Partial gaps before prioritization.
      </PageIntro>
    );
  }
  if (place === "tactics") {
    return (
      <PageIntro kicker="Gap tactics" title="Tactic Ideation">
        {sections.ideation
          ? "Plan tactics for High-priority Open gaps using the library, custom tactics or suggestions."
          : "Plan tactics for High-priority Open gaps using the library or custom tactics."}
      </PageIntro>
    );
  }
  return (
    <PageIntro kicker="Priority canvas" title="Prioritization Matrix">
      Choose axes, review each Open gap’s placement, then validate priority with your reason.
    </PageIntro>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ place?: string; gap_filter?: string; gap_attention?: string; setting?: string }>;
}) {
  const state = await loadState();
  const workspace = buildPlanWorkspace(state);
  const gates = planGates(state);
  // Each place follows its own AI section (KAN-53): Upload ingestion, Matrix prioritization, Ideation.
  const sections = await aiSections().catch(() => noAiSections());
  const ai = sections.ingestion;
  // Demo source files are offered only in a workspace that holds the Velmara demo.
  const demo = await currentWorkspaceIsDemo();
  // With AI off nothing is ingested, so Gaps never waits for a source.
  const gapsUnlocked = gates.gapsUnlocked || !ai;
  const params = await searchParams;
  if (params.place === "mappings") redirect("/mappings");
  const requested =
    params.place === "review" || params.place === "library" ? "gaps" : params.place;
  const suggested = defaultPlanPlace(state, workspace);
  // With AI off there is no Upload place: the flow starts on Evidence Inventory.
  const fallback: PlanPlace = !ai && suggested === "upload" ? "gaps" : suggested;
  if (!ai && requested === "upload") redirect("/?place=gaps");
  const place: PlanPlace = isPlanPlace(requested) ? requested : fallback;
  const ready = gapsReadyForPrioritize(state);
  const gapFilter = (REVIEW_GAP_FILTERS as readonly string[]).includes(params.gap_filter ?? "")
    ? (params.gap_filter as ReviewGapFilter)
    : undefined;

  let pane: ReactNode;
  if (place === "upload") {
    pane = (
      <>
        {/* Upload follows the admin's ingestion switch (KAN-53); with it off the plan starts by hand. */}
        <AiOnly
          section="ingestion"
          fallback={
            <ManualStart
              gapCount={workspace.review.length}
              tacticCount={workspace.availableTactics.length}
            />
          }
        >
          <ManualStartAlongsideUpload
            gapCount={workspace.review.length}
            tacticCount={workspace.availableTactics.length}
          />
          <IngestPanel sources={state.sources} demoFiles={demo} />
        </AiOnly>
        <InventoryReadiness cards={workspace.review} readyForPrioritize={ready} />
      </>
    );
  } else if (place === "gaps") {
    // Each gap's priority on the matrix: the band, and whether a person validated it.
    const priorities = Object.fromEntries(
      (await listPlacements())
        .filter((row) => row.band)
        .map((row) => [row.gap_id, { band: row.band!, validated: row.validated }]),
    );
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
          initialAttention={params.gap_attention === "needs_attention"}
          settingOptions={settingOptions(state)}
          priorities={priorities}
          suggestions={pendingSuggestionCards(state)}
        />
        <SetAsideGaps gaps={state.gaps} />
      </>
    );
  } else if (place === "tactics") {
    // Only gaps validated as High on the matrix are ideated (KAN-8); Defer is out of this cycle.
    const ideation = await loadTacticIdeation(workspace.openGaps);
    pane = (
      <>
        <TacticsPlace ready={gates.tacticsUnlocked} availableTactics={workspace.availableTactics} {...ideation} />
        <RejectedTactics tactics={state.tactics} />
      </>
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
      <PlaceIntro place={place} wizardComplete={state.asset.wizard_complete} sections={sections} />
      {pane}
      {place === "upload" ? (
        <div className="mt-8">
          <LockForm label="Reset to blank slate" action="reset" confirmLabel="Reset" />
        </div>
      ) : null}
    </AppShell>
  );
}
