import { PlanChrome, type PlanNavModel, type ShellId } from "@/components/plan-chrome";
import { buildPlanWorkspace, planGates, planNavCounts } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";

const EMPTY_NAV: PlanNavModel = {
  gapsCount: 0,
  unvalidatedCount: 0,
  gapsUnlocked: false,
  planUnlocked: false,
  tacticsUnlocked: false,
  setupComplete: false,
};

/**
 * Shell for platform routes (/control, /pipeline, /runs). Loads IEGP nav when
 * Postgres is available; still renders when the store is down so OAuth setup works.
 */
export async function PlatformAppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: ShellId;
}) {
  let nav = EMPTY_NAV;
  try {
    const state = await loadState();
    const workspace = buildPlanWorkspace(state);
    const gates = planGates(state);
    const counts = planNavCounts(workspace);
    nav = {
      gapsCount: counts.gaps,
      unvalidatedCount: counts.unvalidated,
      gapsUnlocked: gates.gapsUnlocked,
      planUnlocked: gates.planUnlocked,
      tacticsUnlocked: gates.tacticsUnlocked,
      setupComplete: state.asset.setup_complete,
    };
  } catch {
    // Control panel must load even before DATABASE_URL is configured.
  }
  return (
    <PlanChrome active={active} nav={nav}>
      {children}
    </PlanChrome>
  );
}

export { PageIntro } from "@/components/app-shell";
