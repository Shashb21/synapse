"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ChevronsUpDown, FolderKanban, Loader2, LogOut, Plus, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { sendJson, WORKSPACE_ROLE_LABELS, type WorkspaceTagModel } from "./model";

/**
 * The workspace you are working in. Press it to switch workspace, start a new
 * one, manage them, or sign out. Every page of the customer app shows it, so
 * which client's plan you are editing is never in doubt.
 */
export function WorkspaceTag({ tag, dense }: { tag: WorkspaceTagModel; dense?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(id: string) {
    if (id === tag.current.id) return;
    setPending(id);
    setError(null);
    try {
      await sendJson("/api/workspaces/select", { workspace_id: id });
      // A full load, so nothing from the previous workspace survives in client state.
      window.location.assign("/");
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : "Could not switch workspace.");
    }
  }

  async function signOut() {
    setPending("sign-out");
    try {
      await sendJson("/api/auth/logout", {});
    } finally {
      window.location.assign("/login");
    }
  }

  const initial = tag.current.name.trim().charAt(0).toUpperCase() || "W";

  return (
    <div className="grid gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="workspace-tag"
          aria-label={`Workspace: ${tag.current.name}. Switch workspace`}
          title={`Workspace: ${tag.current.name}`}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 text-left text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
            dense ? "h-8 justify-center px-1 md:h-9 md:justify-start md:px-2" : "h-9 px-2",
          )}
        >
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded bg-primary/80 text-[11px] font-semibold text-primary-foreground"
          >
            {initial}
          </span>
          <span className={cn("min-w-0 flex-1", dense && "hidden md:block")}>
            <span className="block text-[10px] uppercase tracking-wide text-sidebar-foreground/60">Workspace</span>
            <span className="block truncate text-[12px] font-medium" data-testid="workspace-tag-name">
              {tag.current.name}
            </span>
          </span>
          <ChevronsUpDown className={cn("size-3.5 shrink-0 opacity-60", dense && "hidden md:block")} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 min-w-64" align="start">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
            {tag.workspaces.map((ws) => (
              <DropdownMenuItem
                key={ws.id}
                data-testid="workspace-option"
                onClick={() => void switchTo(ws.id)}
                aria-current={ws.id === tag.current.id ? "true" : undefined}
              >
                <FolderKanban aria-hidden />
                <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                <span className="text-[10px] text-muted-foreground">{WORKSPACE_ROLE_LABELS[ws.role]}</span>
                {pending === ws.id ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : ws.id === tag.current.id ? (
                  <Check aria-label="Current workspace" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/workspaces?new=1")}>
            <Plus aria-hidden />
            New workspace
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/workspaces")}>
            <Settings aria-hidden />
            Manage workspaces
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal">
              Signed in as <span className="font-medium text-foreground">{tag.person.name}</span>
              {tag.person.email ? <span className="block truncate">{tag.person.email}</span> : null}
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void signOut()} disabled={pending === "sign-out"}>
              <LogOut aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
