import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PRESENT_HEADER } from "@/modules/auth/gate";
import { PlanChrome, type PlanNavModel, type ShellId } from "@/components/plan-chrome";
import { loadWorkspaceTag } from "@/components/workspaces/workspace-tag-data";
import { loadState } from "@/lib/iegp/store";
import { prioritizationProgress } from "@/modules/stages/s8-prioritization/module";
import {
  buildPlanWorkspace,
  gapsReadyForPrioritize,
  planGates,
  planNavCounts,
  reviewGapFilterCounts,
} from "@/lib/iegp/engine";

export type { ShellId };

const EMPTY_NAV: PlanNavModel = {
  gapsCount: 0,
  unvalidatedCount: 0,
  partialCount: 0,
  gapsUnlocked: false,
  planUnlocked: false,
  tacticsUnlocked: false,
  setupComplete: false,
  readyForPrioritize: false,
};

export async function AppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: ShellId;
}) {
  // The proxy only checks that the cookies exist; this is the real check.
  const workspace = await loadWorkspaceTag();
  if (workspace.state === "signed_out") redirect("/login");
  // Fail closed: if the session or membership cannot be verified, nothing renders.
  if (workspace.state !== "ready") redirect("/workspaces");
  const present = (await headers()).get(PRESENT_HEADER) === "1";
  let nav = EMPTY_NAV;
  try {
    const state = await loadState();
    const workspace = buildPlanWorkspace(state);
    const gates = planGates(state);
    const counts = planNavCounts(workspace);
    const filterCounts = reviewGapFilterCounts(workspace.review);
    nav = {
      gapsCount: counts.gaps,
      unvalidatedCount: counts.unvalidated,
      partialCount: filterCounts.partial,
      gapsUnlocked: gates.gapsUnlocked,
      planUnlocked: gates.planUnlocked,
      tacticsUnlocked: gates.tacticsUnlocked,
      setupComplete: state.asset.setup_complete,
      readyForPrioritize: gapsReadyForPrioritize(state),
      prioritized: await prioritizationProgress(state),
    };
  } catch {
    // Setup and other shells must render before Postgres is configured.
  }
  return (
    <PlanChrome active={active} nav={nav} workspace={workspace.tag} present={present}>
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
    <div className="mb-4">
      {kicker ? (
        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{kicker}</p>
      ) : null}
      <h1 className="text-base font-bold tracking-tight text-foreground">{title}</h1>
      {children ? (
        <div className="mt-1 max-w-4xl text-[12px] leading-5 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}
