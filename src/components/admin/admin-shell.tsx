"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_SECTIONS, adminSectionFor } from "@/components/admin/admin-nav";

/**
 * The owner console's own shell: an amber "Synapse Admin" bar with the console
 * nav, the workspace the lab surfaces are reading, and a way back to the app.
 * Nothing in the customer app links here.
 */
export function AdminShell({
  children,
  workspaceName,
  ownerName,
}: {
  children: React.ReactNode;
  workspaceName: string;
  ownerName: string;
}) {
  const active = adminSectionFor(usePathname() ?? "/admin");
  return (
    <div className="flex min-h-full flex-1 flex-col" data-testid="admin-shell">
      <header className="border-b border-amber-500/30 border-t-2 border-t-amber-500 bg-card/60">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-2">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground no-underline"
          >
            <ShieldCheck className="size-4 text-amber-500" aria-hidden />
            Synapse Admin
          </Link>
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
            Owner only
          </span>
          <p className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span data-testid="admin-workspace">
              Workspace: <span className="text-foreground">{workspaceName}</span>
            </span>
            <Link href="/workspaces" className="text-foreground underline-offset-2 hover:underline">
              Switch
            </Link>
            <span aria-hidden>·</span>
            <span>{ownerName}</span>
            <span aria-hidden>·</span>
            <Link href="/" className="text-foreground underline-offset-2 hover:underline">
              Back to the app
            </Link>
          </p>
        </div>
        <nav aria-label="Admin" className="flex gap-0.5 overflow-x-auto px-3 pb-1.5 pt-1.5">
          {ADMIN_SECTIONS.map((section) => (
            <Link
              key={section.id}
              href={section.href}
              aria-current={active === section.id ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-[12px] no-underline transition-colors",
                active === section.id
                  ? "bg-amber-500/15 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {section.label}
            </Link>
          ))}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
