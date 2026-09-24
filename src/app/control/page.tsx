import "@/modules";
import { PageIntro, PlatformAppShell } from "@/components/platform-app-shell";
import { ControlPanelView } from "@/components/platform/control-panel-view";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ControlPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    connect_error?: string;
    signed_in?: string;
    sign_in_error?: string;
  }>;
}) {
  const params = await searchParams;
  const ai = await aiEnabled().catch(() => true);
  return (
    <PlatformAppShell active="control">
      <PageIntro kicker="Cross-cutting · all roles" title="Control panel">
        Log in to each model provider with OAuth and route every stage where you want it. Grok is the
        locked default; Claude is one click away. Nothing here accepts an API key.
        {ai ? null : " AI is off right now, so providers and routes below are kept but not used."}
      </PageIntro>
      <ControlPanelView params={params} />
    </PlatformAppShell>
  );
}
