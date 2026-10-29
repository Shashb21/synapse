import { requireOwnerPage } from "@/modules/auth/owner";
import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { ControlPanelView } from "@/components/platform/control-panel-view";

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
  return (
    <AdminMain>
      <PageIntro title="Control panel">
        Manage customer AI availability, provider credentials and saved model routes.
      </PageIntro>
      <ControlPanelView params={params} />
    </AdminMain>
  );
}
