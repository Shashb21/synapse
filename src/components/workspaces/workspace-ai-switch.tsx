"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSetAiEnabled } from "@/components/platform/ai-status";
import { cn } from "@/lib/utils";
import { sendJson } from "./model";

/**
 * The workspace's "AI assistance" switch: in the workspace menu (the tag) and
 * on the workspace settings page. Only the owner flips it, after a short
 * confirm; everyone else sees its state. The platform master switch
 * (/admin/control) overrides it, and then it is shown off and disabled.
 *
 * Flipping it changes the flow at once: the AI status updates on the client,
 * a page that no longer applies (Upload's sources while AI turns off) goes to
 * Start, and `router.refresh()` brings the server's view.
 */

export type WorkspaceAiModel = {
  workspaceId: string;
  workspaceName: string;
  /** The workspace's own setting. */
  enabled: boolean;
  /** The platform master switch. */
  platformEnabled: boolean;
  /** The signed-in person owns this workspace. */
  owner: boolean;
  /** This is the workspace the person has open, so the flow follows the switch. */
  isCurrent: boolean;
};

export const PLATFORM_OFF_NOTE = "Turned off by your Synapse administrator";
export const MEMBER_NOTE = "Only the workspace owner can change this.";

/** What the confirm says each way. */
export function aiConfirmCopy(next: boolean, workspaceName: string) {
  return next
    ? {
        title: `Turn on AI assistance for ${workspaceName}?`,
        body:
          "Models can suggest again in this workspace. Upload replaces Start, so sources can be uploaded and parsed, and the AI buttons (Generate ideas, Prioritize with the model, Re-suggest) come back. People still decide, nothing already entered changes, and other workspaces are not affected.",
        confirm: "Turn AI on",
      }
    : {
        title: `Turn off AI assistance for ${workspaceName}?`,
        body:
          "No model is called for anyone in this workspace. Nothing is uploaded or parsed: work starts at Start with Add gaps and Add tactics, the AI buttons (Generate ideas, Prioritize with the model, Re-suggest) are hidden, and every step is done by hand. Your plan stays as it is, you can turn AI back on at any time, and other workspaces are not affected.",
        confirm: "Turn AI off",
      };
}

/** Pages that only make sense with AI on: while AI turns off they go to Start. */
function pageNeedsAi(pathname: string): boolean {
  return pathname === "/sources" || pathname.startsWith("/sources/");
}

/** Shared by both places: the pending change, the POST, and the flow change. */
export function useWorkspaceAiChange(model: WorkspaceAiModel) {
  const router = useRouter();
  const pathname = usePathname();
  const setAi = useSetAiEnabled();
  const [enabled, setEnabled] = useState(model.enabled);
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new value from the server (after a refresh) replaces the local one.
  const [seen, setSeen] = useState(model.enabled);
  if (seen !== model.enabled) {
    setSeen(model.enabled);
    setEnabled(model.enabled);
  }

  const mayChange = model.owner && model.platformEnabled;
  const effective = enabled && model.platformEnabled;

  function ask() {
    if (!mayChange || pending) return;
    setError(null);
    setConfirming(!enabled);
  }

  async function confirm() {
    if (confirming === null) return;
    const next = confirming;
    setPending(true);
    setError(null);
    try {
      await sendJson(`/api/workspaces/${encodeURIComponent(model.workspaceId)}/ai`, { enabled: next });
      setEnabled(next);
      setConfirming(null);
      // The client status changes first, so the nav and AI buttons follow at once.
      if (model.isCurrent) setAi({ enabled: next && model.platformEnabled, offBy: next ? null : "workspace" });
      // A page that no longer applies goes to Start (a push fetches it fresh);
      // anywhere else the page refreshes in place. A refresh right after a
      // push would cancel the push, so it is one or the other.
      if (model.isCurrent && !next && pageNeedsAi(pathname ?? "")) router.push("/?place=upload");
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change AI assistance.");
    } finally {
      setPending(false);
    }
  }

  return {
    enabled,
    effective,
    mayChange,
    pending,
    error,
    ask,
    confirming,
    cancel: () => setConfirming(null),
    confirm,
    note: !model.platformEnabled ? PLATFORM_OFF_NOTE : !model.owner ? MEMBER_NOTE : null,
  };
}

export type WorkspaceAiChange = ReturnType<typeof useWorkspaceAiChange>;

/** The short confirm before the switch flips. */
export function WorkspaceAiConfirm({ change, workspaceName }: { change: WorkspaceAiChange; workspaceName: string }) {
  const next = change.confirming;
  const copy = aiConfirmCopy(next ?? !change.enabled, workspaceName);
  return (
    <Dialog
      open={next !== null}
      onOpenChange={(open) => {
        if (!open && !change.pending) change.cancel();
      }}
    >
      <DialogContent data-testid="workspace-ai-confirm">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {change.error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {change.error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" size="sm" variant="outline" disabled={change.pending} />}>
            Cancel
          </DialogClose>
          <Button type="button" size="sm" disabled={change.pending} onClick={() => void change.confirm()}>
            {change.pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The track and thumb; decorative, the element around it carries the switch role. */
export function SwitchTrack({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors",
        on ? "bg-primary" : "bg-muted",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block size-3.5 rounded-full bg-background shadow transition-transform",
          on ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </span>
  );
}

/** The switch on the workspace settings page. */
export function WorkspaceAiSetting({ model }: { model: WorkspaceAiModel }) {
  const change = useWorkspaceAiChange(model);
  const noteId = useId();
  return (
    <section aria-labelledby="ws-ai" className="grid gap-2" data-testid="workspace-ai-setting">
      <h2 id="ws-ai" className="text-[15px] font-medium text-foreground">
        AI assistance
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card/40 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-foreground" data-testid="workspace-ai-state">
            AI assistance {change.effective ? "is on" : "is off"}
          </p>
          <p id={noteId} className="text-[11px] text-muted-foreground">
            {change.note ??
              (change.effective
                ? "Models suggest; people decide. Turn it off to work fully by hand in this workspace."
                : "Everything in this workspace is entered by hand. Other workspaces are not affected.")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={change.effective}
          aria-labelledby="ws-ai"
          aria-describedby={noteId}
          aria-disabled={!change.mayChange || change.pending ? true : undefined}
          data-testid="workspace-ai-switch"
          onClick={change.ask}
          className={cn(
            "inline-flex items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
            (!change.mayChange || change.pending) && "cursor-not-allowed opacity-60",
          )}
        >
          <SwitchTrack on={change.effective} />
        </button>
      </div>
      {change.error && change.confirming === null ? (
        <p role="alert" className="text-[12px] text-destructive">
          {change.error}
        </p>
      ) : null}
      <WorkspaceAiConfirm change={change} workspaceName={model.workspaceName} />
    </section>
  );
}
