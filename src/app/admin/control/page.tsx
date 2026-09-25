import { requireOwnerPage } from "@/modules/auth/owner";
import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
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
  await requireOwnerPage();
  const params = await searchParams;
  const ai = await aiEnabled().catch(() => true);
  return (
    <AdminMain>
      <PageIntro kicker="Owner · platform-wide" title="Control panel">
        Switch AI on or off for everyone, log in to each model provider with OAuth and route every stage where you want it. Grok is the
        locked default; Claude is one click away. Nothing here accepts an API key.
        {ai ? null : " AI is off right now, so providers and routes below are kept but not used."}
      </PageIntro>
      <ControlPanelView params={params} />
    </AdminMain>
  );
}
