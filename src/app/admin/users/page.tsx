import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { AdminUsers } from "@/components/admin/admin-users";
import { PASSWORD_PROVIDER } from "@/modules/auth/accounts";
import { listAdminUsers } from "@/modules/auth/admin-users";
import { requireOwnerPage } from "@/modules/auth/owner";
import { currentSession } from "@/modules/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminUsersPage() {
  await requireOwnerPage();
  const [users, session] = await Promise.all([listAdminUsers(), currentSession().catch(() => null)]);
  const selfId = session?.provider_id === PASSWORD_PROVIDER ? session.subject : null;
  return (
    <AdminMain>
      <PageIntro kicker="Owner · platform-wide" title="Users">
        Everyone who signs in with an email and password. Accounts you create here are verified, so their email matches
        workspace invites; self sign-ups stay unverified until you verify them. Single sign-on users are not listed:
        their identity provider manages them.
      </PageIntro>
      <AdminUsers initialUsers={users} selfId={selfId} />
    </AdminMain>
  );
}
