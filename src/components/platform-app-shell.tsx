import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PRESENT_HEADER } from "@/modules/auth/gate";
import { PlanChrome, type PlanNavModel, type ShellId } from "@/components/plan-chrome";
import { loadWorkspaceTag } from "@/components/workspaces/workspace-tag-data";
import {
  buildPlanWorkspace,
  gapsReadyForPrioritize,
  planGates,
  planNavCounts,
  reviewGapFilterCounts,
} from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";

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

/**
 * Shell for platform routes. Loads IEGP nav when Postgres is available; still
 * renders when the store is down so OAuth setup works.
 */
export async function PlatformAppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: ShellId;
}) {
  // The proxy only checks that the cookies exist; this is the real check.
  const workspace = await loadWorkspaceTag();
  if (workspace.state === "signed_out") redirect("/login");
  if (workspace.state === "no_workspace") redirect("/workspaces");
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
    };
  } catch {
    // Control panel must load even before DATABASE_URL is configured.
  }
  return (
    <PlanChrome active={active} nav={nav} workspace={workspace.state === "ready" ? workspace.tag : null} present={present}>
      {children}
    </PlanChrome>
  );
}

export { PageIntro } from "@/components/app-shell";
