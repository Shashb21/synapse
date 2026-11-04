/** Owner-only setup for isolated development experiments. */
import { developmentStyles as styles } from "@/components/development/development-styles";
import { AdminMain } from "@/components/admin/admin-page";
import { DevelopmentSetup } from "@/components/development/development-setup";
import { requireOwnerPage } from "@/modules/auth/owner";

export const dynamic = "force-dynamic";

/** Render the setup surface only after checking owner access. */
export default async function DevelopmentPage() {
  await requireOwnerPage();
  return (
    <AdminMain>
      <h1 className={styles.pageTitle}>Development</h1>
      <p className={`${styles.explanation} mt-3 mb-8`}>
        Test generation with private documents, then review and compare saved results.
      </p>
      <DevelopmentSetup />
    </AdminMain>
  );
}
