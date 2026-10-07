import Link from "next/link";
import { adminWorkspacePickerHref } from "@/components/admin/admin-nav";

/** Content frame for an owner-console page that has no sub-navigation of its own. */
export function AdminMain({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-5 sm:px-6">{children}</main>;
}

export { PageIntro } from "@/components/page-intro";

/** Which workspace a console page reads and runs in, with the way to change it (KAN-62). */
export function AdminWorkspaceBar({
  workspace,
  path,
  verb = "Reading",
}: {
  workspace: { id: string; name: string; demo: boolean };
  /** This page, so the picker comes back here. */
  path: string;
  verb?: string;
}) {
  return (
    <p
      className="mb-6 flex flex-wrap items-center gap-2 border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[13px] text-muted-foreground rounded-lg"
      data-testid="admin-workspace-bar"
      data-workspace-id={workspace.id}
    >
      <span>
        {verb} workspace <span className="font-medium text-foreground">{workspace.name}</span>{" "}
        <span className="font-mono text-[12px]">({workspace.id})</span>
        {workspace.demo ? " · demo" : ""}
      </span>
      <Link href={adminWorkspacePickerHref(path)} className="text-foreground underline-offset-2 hover:underline">
        Choose another
      </Link>
    </p>
  );
}
