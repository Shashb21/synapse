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
        Default chain is Grok → Claude → OpenAI. Each provider uses an API key set in the server
        environment (<code>XAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>,{" "}
        <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>OPENROUTER_API_KEY</code>);
        a provider without one is skipped. Keys are never shown or entered here.
      </PageIntro>
      <AccuracyControlView />
    </AccuracyAppShell>
  );
}
