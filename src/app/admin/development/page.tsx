/** Owner-only setup for isolated development experiments. */
import { AdminMain } from "@/components/admin/admin-page";
import { DevelopmentSetup } from "@/components/development/development-setup";
import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";

export const dynamic = "force-dynamic";

/** Render the setup surface only after checking owner access. */
export default async function DevelopmentPage() {
  await requireOwnerPage();
  return (
    <AdminMain>
      <h1 className="text-xl font-semibold">Development</h1>
      <p className="mt-2 mb-6 max-w-prose text-sm text-muted-foreground">
        Prepare private experiments, run generation, and save optional evaluation
        references. Evaluation is separate and is not run here.
      </p>
      <p className="mb-6 text-sm">
        <Link href="/admin/development/evaluation-tools" className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Evaluation tools and historical benchmarks</Link>
      </p>
      <DevelopmentSetup />
    </AdminMain>
  );
}
