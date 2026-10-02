import Link from "next/link";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { AdminWorkspacePicker } from "@/components/admin/admin-workspace-picker";
import { requireOwnerPage } from "@/modules/auth/owner";
import { adminReturnPath, adminWorkspace } from "@/modules/workspaces/admin-context";
import { listAllWorkspaces } from "@/modules/workspaces/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SOURCE_COPY = {
  picked: "chosen here",
  app: "your own app selection",
  default: "nothing chosen yet, so the Default workspace",
} as const;

/** The owner console's workspace picker (KAN-62): every customer workspace, not just the owner's own. */
export default async function AdminWorkspacePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await requireOwnerPage();
  const params = await searchParams;
  const next = adminReturnPath(params.next);
  const [current, workspaces] = await Promise.all([adminWorkspace(), listAllWorkspaces()]);

  return (
    <AdminMain>
      <PageIntro kicker="Owner · every workspace" title="Choose a workspace">
        Pipeline, Runs &amp; traces, Evals and the overview work in the workspace you choose here. It only
        changes what the console reads and runs; nobody is added to the workspace, and the app keeps its own
        selection.
      </PageIntro>
      <p className="mb-4 text-[13px] text-muted-foreground" data-testid="admin-workspace-current">
        Working in <span className="font-medium text-foreground">{current.name}</span> ({SOURCE_COPY[current.source]}).{" "}
        <Link href={next} className="text-foreground underline-offset-2 hover:underline">
          Back
        </Link>
      </p>
      <AdminWorkspacePicker
        workspaces={workspaces.map(({ id, name, created_by, created_at, demo, member_count }) => ({
          id,
          name,
          created_by,
          created_at,
          demo,
          member_count,
        }))}
        currentId={current.id}
        next={next}
      />
    </AdminMain>
  );
}
