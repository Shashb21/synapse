"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Check, ChevronsUpDown, FolderKanban, Loader2, LogOut, Plus, Settings, ShieldCheck, Sparkles, UserRound } from "lucide-react";
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
import { DemoBadge } from "./demo-badge";
import { sendJson, WORKSPACE_ROLE_LABELS, type WorkspaceTagModel } from "./model";
import { SwitchTrack, useWorkspaceAiChange, WorkspaceAiConfirm } from "./workspace-ai-switch";

/**
 * The workspace you are working in. Press it to switch workspace, start a new
 * one, manage them, turn the workspace's AI assistance on or off, or sign out. Every page of the customer app shows it, so
 * which client's plan you are editing is never in doubt.
 */
export function WorkspaceTag({ tag, dense }: { tag: WorkspaceTagModel; dense?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aiNoteId = useId();
  const ai = useWorkspaceAiChange({
    workspaceId: tag.current.id,
    workspaceName: tag.current.name,
    enabled: tag.ai?.workspace ?? true,
    platformEnabled: tag.ai?.platform ?? true,
    owner: tag.current.role === "owner",
    isCurrent: true,
  });

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
          aria-label={`Workspace: ${tag.current.name}${tag.current.demo ? " (demo data)" : ""}. Switch workspace`}
          title={`Workspace: ${tag.current.name}${tag.current.demo ? " (demo data)" : ""}`}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 text-left text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
            dense ? "h-9 border-transparent bg-transparent px-[3px] group-hover/rail:border-sidebar-border group-hover/rail:bg-sidebar-accent/40 group-has-[:focus-visible]/rail:border-sidebar-border" : "h-9 px-2",
          )}
        >
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded bg-primary/80 text-[11px] font-semibold text-primary-foreground"
          >
            {initial}
          </span>
          <span className={cn("min-w-0 flex-1", dense && "opacity-0 transition-opacity group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100")}>
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-sidebar-foreground/60">
              Workspace
              {tag.current.demo ? <DemoBadge testId="workspace-tag-demo" /> : null}
            </span>
            <span className="block truncate text-[12px] font-medium" data-testid="workspace-tag-name">
              {tag.current.name}
            </span>
          </span>
          <ChevronsUpDown className={cn("size-3.5 shrink-0 opacity-60", dense && "opacity-0 transition-opacity group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100 group-hover/rail:opacity-60")} aria-hidden />
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
                {ws.demo ? <DemoBadge /> : null}
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
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspace settings</DropdownMenuLabel>
            <DropdownMenuItem
              data-testid="workspace-menu-ai"
              // Read only for members and while the platform switch is off; still focusable so its state is read out.
              disabled={!ai.mayChange}
              onClick={ai.ask}
              render={(props) => (
                <div
                  {...props}
                  role="switch"
                  aria-checked={ai.effective}
                  aria-label="AI assistance"
                  aria-describedby={ai.note ? aiNoteId : undefined}
                />
              )}
            >
              <Sparkles aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block">AI assistance</span>
                {ai.note ? (
                  <span id={aiNoteId} className="block text-[10px] text-muted-foreground" data-testid="workspace-menu-ai-note">
                    {ai.note}
                  </span>
                ) : null}
              </span>
              <SwitchTrack on={ai.effective} />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push(`/workspaces/${encodeURIComponent(tag.current.id)}`)}>
              <Settings aria-hidden />
              This workspace&apos;s settings
            </DropdownMenuItem>
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
            <DropdownMenuItem onClick={() => router.push("/account")}>
              <UserRound aria-hidden />
              Your account
            </DropdownMenuItem>
            {tag.person.owner ? (
              <DropdownMenuItem onClick={() => router.push("/admin")}>
                <ShieldCheck aria-hidden />
                Admin
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => void signOut()} disabled={pending === "sign-out"}>
              <LogOut aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkspaceAiConfirm change={ai} workspaceName={tag.current.name} />
      {error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
