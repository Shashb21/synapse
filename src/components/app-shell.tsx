import { PlanChrome, type PlanNavModel, type ShellId } from "@/components/plan-chrome";
import { loadState } from "@/lib/iegp/store";
import { buildPlanWorkspace, planGates, planNavCounts } from "@/lib/iegp/engine";

export type { ShellId };

const EMPTY_NAV: PlanNavModel = {
  gapsCount: 0,
  unvalidatedCount: 0,
  gapsUnlocked: false,
  planUnlocked: false,
  tacticsUnlocked: false,
  setupComplete: false,
};

export async function AppShell({
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
    // Setup and other shells must render before Postgres is configured.
  }
  return (
    <PlanChrome active={active} nav={nav}>
      {children}
    </PlanChrome>
  );
}

export function PageIntro({
  kicker,
  title,
  children,
}: {
  kicker?: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      {kicker ? (
        <p className="mb-1 text-[11px] text-muted-foreground">{kicker}</p>
      ) : null}
      <h1 className="text-lg font-medium text-foreground">{title}</h1>
      {children ? (
        <div className="mt-2 max-w-3xl text-[13px] leading-5 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}
