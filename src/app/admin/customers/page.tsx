import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { AdminCustomers } from "@/components/admin/admin-customers";
import { listCustomers, MAX_BULK_EMAILS } from "@/modules/auth/customers";
import { requireOwnerPage } from "@/modules/auth/owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminCustomersPage() {
  await requireOwnerPage();
  const customers = await listCustomers();
  return (
    <AdminMain>
      <PageIntro kicker="Owner · platform-wide" title="Customers">
        Each customer has the seats they bought. Assign a seat to a person&apos;s work email and they can sign in with
        their organisation&apos;s single sign-on; without a seat, sign-in is refused. Unassigning a seat or deactivating a
        customer signs those people out at once. A seat lets someone in; they still need a workspace invite to see a
        plan.
      </PageIntro>
      <AdminCustomers initialCustomers={customers} maxBulk={MAX_BULK_EMAILS} />
    </AdminMain>
  );
}
