import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "./sign-out-button";

/** Page frame for choosing and managing workspaces (outside any one workspace). */
export function WorkspacesFrame({
  person,
  children,
}: {
  person: { name: string; email: string | null };
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 sm:px-6">
        <Link href="/workspaces" className="text-[13px] font-medium text-foreground no-underline">
          Synapse IEGP
        </Link>
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span data-testid="signed-in-as">
            Signed in as <span className="text-foreground">{person.name}</span>
            {person.email ? <span className="hidden sm:inline"> · {person.email}</span> : null}
          </span>
          <Link href="/account" className="text-foreground underline underline-offset-2">
            Account
          </Link>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
