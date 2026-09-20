import { AppShell, PageIntro } from "@/components/app-shell";
import { ObservabilityDashboard } from "@/components/observability-dashboard";

export const dynamic = "force-dynamic";

export default function ObservabilityPage() {
  return (
    <AppShell active="observability">
      <PageIntro kicker="Live tape" title="Agentic observability">
        Connect Claude Code on this page, then inspect every OAuth call, refresh, and extract step.
        Tokens are redacted in the tape.
      </PageIntro>
      <ObservabilityDashboard />
    </AppShell>
  );
}
