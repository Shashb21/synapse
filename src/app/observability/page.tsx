import { AppShell, PageIntro } from "@/components/app-shell";
import { ObservabilityDashboard } from "@/components/observability-dashboard";

export const dynamic = "force-dynamic";

export default function ObservabilityPage() {
  return (
    <AppShell active="observability">
      <PageIntro kicker="Live tape" title="Agentic observability">
        Every Claude Code OAuth call, refresh, and extract step. Tokens are redacted; prompt
        previews and judge JSON stay here so you can see what the agents did.
      </PageIntro>
      <ObservabilityDashboard />
    </AppShell>
  );
}
