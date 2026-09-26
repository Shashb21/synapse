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
        Your own staff, who sign in with an email and password. Every account here is an admin or a Platform operator;
        accounts you create are verified, so their email matches workspace invites. Customers never get a password:
        they sign in with single sign-on and a seat you assign under Customers.
      </PageIntro>
      <AdminUsers initialUsers={users} selfId={selfId} />
    </AdminMain>
  );
}
