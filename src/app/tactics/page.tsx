import { AppShell, PageIntro } from "@/components/app-shell";
import { TacticsPlace } from "@/components/tactics-place";
import { buildPlanWorkspace, planGates } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function TacticsPage() {
  const state = await loadState();
  const workspace = buildPlanWorkspace(state);
  const gates = planGates(state);
  return (
    <AppShell active="tactics">
      <PageIntro kicker="Open gaps only" title="Tactics">
        Create and assign proposed tactics for Open gaps after they are prioritized. Proposed tactics
        do not change gap status until they are planned, ongoing, or completed. Recording missed
        real studies happens on Gaps.
      </PageIntro>
      <TacticsPlace
        unlocked={gates.tacticsUnlocked}
        openGaps={workspace.openGaps}
        availableTactics={workspace.availableTactics}
      />
    </AppShell>
  );
}
