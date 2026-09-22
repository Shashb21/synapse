import { AppShell, PageIntro } from "@/components/app-shell";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { parsePlanningContext, type PlanningContext } from "@/lib/iegp/planning-context";
import { loadState } from "@/lib/iegp/store";
import { sessionContext } from "@/modules/auth/session";

export const dynamic = "force-dynamic";

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

export default async function SetupPage() {
  const [state, identity] = await Promise.all([loadState(), sessionContext()]);
  const initial = initialFromAsset(state);

  return (
    <AppShell active="setup">
      <PageIntro kicker="Onboarding" title="Get started">
        Visual walkthrough of the IEGP pipeline plus asset context for smarter prioritization.
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
