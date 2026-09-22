import "@/modules";
import { PageIntro, PlatformAppShell } from "@/components/platform-app-shell";
import { ControlPanelView } from "@/components/platform/control-panel-view";

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
  return (
    <PlatformAppShell active="control">
      <PageIntro kicker="Cross-cutting · all roles" title="Control panel">
        Log in to each model provider with OAuth and route every stage where you want it. Grok is the
        locked default; Claude is one click away. Nothing here accepts an API key.
      </PageIntro>
      <ControlPanelView params={params} />
    </PlatformAppShell>
  );
}
