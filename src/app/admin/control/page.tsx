import { requireOwnerPage } from "@/modules/auth/owner";
import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { ControlPanelView } from "@/components/platform/control-panel-view";
import { platformAiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ControlPage({
  searchParams,
}: {
  searchParams: Promise<{
    signed_in?: string;
    sign_in_error?: string;
  }>;
}) {
  await requireOwnerPage();
  const params = await searchParams;
  // The master switch, not the owner's own workspace setting.
  const ai = await platformAiEnabled().catch(() => true);
  return (
    <AdminMain>
      <PageIntro title="Control panel">
        Manage AI availability for every customer, check provider keys, and choose a model for each stage.
        Grok is the default; Claude is the one-click alternate. Keys are never shown or entered here.
        {ai ? null : " AI is off right now, so providers and routes below are kept but not used."}
      </PageIntro>
      <ControlPanelView params={params} />
    </AdminMain>
  );
}
