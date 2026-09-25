import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { adminWorkspaceName } from "@/components/admin/admin-workspace";
import { requireOwnerPage } from "@/modules/auth/owner";

export const metadata: Metadata = {
  title: "Synapse Admin",
  description: "Owner console: AI switch, routing, provider logins, the accuracy lab, pipeline, runs and evals.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The owner console. Every page below also calls requireOwnerPage() itself —
 * a layout alone does not stop nested segments from rendering.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const [access, workspaceName] = await Promise.all([requireOwnerPage(), adminWorkspaceName()]);
  return (
    <AdminShell workspaceName={workspaceName} ownerName={access.actor.name}>
      {children}
    </AdminShell>
  );
}
