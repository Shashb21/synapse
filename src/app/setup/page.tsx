import { AppShell, PageIntro } from "@/components/app-shell";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { setupContextFromState } from "@/lib/iegp/planning-context";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import { sessionContext } from "@/modules/auth/session";
import { aiSectionEnabled } from "@/modules/kernel/ai-switch";
import { currentWorkspace } from "@/modules/workspaces/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The IEGP setup wizard for the current workspace. `?new=1` (sent right after
 * a workspace is created) opens on a welcome step with an empty form.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const params = await searchParams;
  const [state, identity, ai, workspace] = await Promise.all([
    loadState(),
    sessionContext(),
    aiSectionEnabled("ingestion"),
    currentWorkspace(),
  ]);
  const isNew = params.new === "1" && !state.asset.setup_complete;
  const initial = setupContextFromState(state, { fresh: isNew });

  return (
    <AppShell active="setup">
      <PageIntro kicker="Onboarding" title="Get started">
        {ai
          ? "The context of this IEGP — asset, objectives, key decisions, landscape and people — for smarter prioritization, ideation and timelines."
          : "The context of this IEGP, then the manual path: Add gaps, Add tactics, and every step by hand."}
      </PageIntro>
      <SetupWizard
        key={state.asset.id}
        initial={initial}
        linkedGaps={state.gaps.filter(isLiveGap).map(gap => ({ id: gap.id, name: gap.name, objective_id: gap.objective_id, open: displayedGapStatus(gap) === "validated_open", settings: gap.settings ?? [] }))}
        actorName={identity.actor.name}
        actorFunction={identity.actor.function}
        setupComplete={state.asset.setup_complete}
        isNew={isNew}
        workspaceName={workspace?.name}
      />
    </AppShell>
  );
}
