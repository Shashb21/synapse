import { requireOwnerPage } from "@/modules/auth/owner";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { AccuracyControlView } from "@/components/accuracy/accuracy-control-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AccuracyControlPage() {
  await requireOwnerPage();
  return (
    <AccuracyAppShell active="control">
      <PageIntro kicker="Routing · call kind × agent role" title="Accuracy routing">
        Default chain is Grok → Claude → OpenAI. Prefer OAuth on the legacy control panel; server
        env keys (<code>XAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>,{" "}
        <code>OPENAI_API_KEY</code>) also unlock those providers when present. Never paste secrets
        in the UI.
      </PageIntro>
      <AccuracyControlView />
    </AccuracyAppShell>
  );
}
