import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { AccuracyControlView } from "@/components/accuracy/accuracy-control-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function AccuracyControlPage() {
  return (
    <AccuracyAppShell active="control">
      <PageIntro kicker="Routing · call kind × agent role" title="Accuracy routing">
        Configure provider, model, and parameters for every LLM role on each agentic call kind. OAuth
        providers connect on the legacy control panel until accuracy inherits that flow.
      </PageIntro>
      <AccuracyControlView />
    </AccuracyAppShell>
  );
}
