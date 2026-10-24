"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/brand-mark";
import { ADMIN_SECTIONS, adminSectionFor, adminWorkspacePickerHref } from "@/components/admin/admin-nav";

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
  const pathname = usePathname() ?? "/admin";
  const active = adminSectionFor(pathname);
  return (
    <div className="flex min-h-full flex-1 flex-col" data-testid="admin-shell">
      <header className="border-b border-unknown/40 border-t-2 border-t-amber-500 bg-card">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-2">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 text-body font-semibold text-foreground no-underline"
          >
            <BrandMark />
            <ShieldCheck className="size-4 text-unknown-foreground" aria-hidden />
            Synapse Admin
          </Link>
          <span className="rounded bg-unknown/15 px-1.5 py-0.5 text-caption font-semibold text-unknown-foreground">
            Owner only
          </span>
          <p className="ml-auto flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            <span data-testid="admin-workspace">
              Workspace: <span className="text-foreground">{workspaceName}</span>
            </span>
            {/* The console's own picker: the owner belongs to no customer workspace (KAN-62). */}
            <Link
              href={adminWorkspacePickerHref(pathname)}
              className="text-foreground underline-offset-2 hover:underline"
              data-testid="admin-workspace-switch"
            >
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
                "shrink-0 rounded-md px-2 py-1 text-callout no-underline transition-colors",
                active === section.id
                  ? "bg-unknown/15 text-foreground"
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
