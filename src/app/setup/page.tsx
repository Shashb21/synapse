import { AppShell, PageIntro } from "@/components/app-shell";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { buildBlankWorkspace } from "@/lib/iegp/blank";
import { parsePlanningContext, type PlanningContext } from "@/lib/iegp/planning-context";
import { loadState } from "@/lib/iegp/store";
import { sessionContext, type SessionContext } from "@/modules/auth/session";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function initialFromAsset(state: Awaited<ReturnType<typeof loadState>>): PlanningContext {
  const parsed = parsePlanningContext(state.asset.planning_context);
  if (parsed.asset_name.trim()) return parsed;
  const objective = state.objectives[0];
  return {
    ...parsed,
    asset_name: state.asset.name,
    inn: state.asset.inn,
    indication: state.asset.indication,
    geography: state.asset.geography,
    key_decision: objective?.key_decision ?? parsed.key_decision,
    decision_date: objective?.decision_date ?? parsed.decision_date,
    lifecycle_stage: objective?.lifecycle_stage ?? parsed.lifecycle_stage,
    strategic_importance: objective?.strategic_importance ?? parsed.strategic_importance,
  };
}

async function loadSetupState() {
  try {
    return await loadState();
  } catch {
    return buildBlankWorkspace();
  }
}

async function loadSetupIdentity(): Promise<SessionContext> {
  try {
    return await sessionContext();
  } catch {
    return {
      session: null,
      actor: { name: "Unsigned (demo)", function: "medical_affairs" },
      role: "medical_affairs",
      demo: true,
      signed_in: false,
    };
  }
}

export default async function SetupPage() {
  const [state, identity, ai] = await Promise.all([
    loadSetupState(),
    loadSetupIdentity(),
    aiEnabled().catch(() => true),
  ]);
  const initial = initialFromAsset(state);

  return (
    <AppShell active="setup">
      <PageIntro kicker="Onboarding" title="Get started">
        {ai
          ? "Visual walkthrough of the IEGP pipeline plus asset context for smarter prioritization."
          : "Asset context for prioritization, then a walkthrough of the manual path: Add gaps, Add tactics, and every step by hand."}
      </PageIntro>
      <SetupWizard
        initial={initial}
        actorName={identity.actor.name}
        actorFunction={identity.actor.function}
        setupComplete={state.asset.setup_complete}
      />
    </AppShell>
  );
}
