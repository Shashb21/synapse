"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Database, Eraser, Loader2 } from "lucide-react";
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
import { DemoBadge } from "./demo-badge";
import { sendJson } from "./model";

type Replace = "load_demo" | "reset";

const COPY: Record<Replace, { button: string; title: string; body: string; confirm: string; done: string }> = {
  load_demo: {
    button: "Load demo data",
    title: "Replace everything with the Velmara demo?",
    body: "Every source, gap, tactic, priority, timeline and room note in this workspace is deleted and replaced with the Velmara demo data. The workspace is marked Demo. This cannot be undone.",
    confirm: "Replace with demo data",
    done: "Demo data loaded. This workspace is marked Demo.",
  },
  reset: {
    button: "Reset to blank",
    title: "Reset this workspace to blank?",
    body: "Everything in this workspace is deleted: the asset details, objectives, sources, gaps, tactics, priorities, timeline and room notes. Setup starts again from an empty plan. This cannot be undone.",
    confirm: "Reset to blank",
    done: "Workspace reset to blank. Run setup to start the plan.",
  },
};

/**
 * Owner-only: replace the workspace's contents with the Velmara demo, or empty
 * it. Both go through the /api/iegp "load_demo" and "reset" actions, which act
 * on the open workspace, so this workspace is opened first when it is not.
 */
export function WorkspaceContents({
  workspaceId,
  demo: initialDemo,
  isCurrent,
}: {
  workspaceId: string;
  demo: boolean;
  isCurrent: boolean;
}) {
  const router = useRouter();
  const [demo, setDemo] = useState(initialDemo);
  const [open, setOpen] = useState<Replace | null>(null);
  const [pending, setPending] = useState<Replace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: Replace) {
    setPending(action);
    setError(null);
    setNotice(null);
    try {
      if (!isCurrent) await sendJson("/api/workspaces/select", { workspace_id: workspaceId });
      await sendJson("/api/iegp", { action });
      setDemo(action === "load_demo");
      setNotice(COPY[action].done);
      setOpen(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="ws-contents" className="grid gap-2">
      <h2 id="ws-contents" className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        Contents
        {demo ? <DemoBadge testId="settings-demo-badge" /> : null}
      </h2>
      <p className="text-[12px] text-muted-foreground">
        {demo
          ? "This workspace holds the Velmara demo data, for trying Synapse out."
          : "This workspace holds your own plan. Load the Velmara demo to try Synapse with worked data."}
        {isCurrent ? null : " Either action opens this workspace."}
      </p>
      <div className="flex flex-wrap gap-2">
        {(["load_demo", "reset"] as const).map((action) => (
          <Dialog
            key={action}
            open={open === action}
            onOpenChange={(next) => {
              setOpen(next ? action : null);
              if (next) setError(null);
            }}
          >
            <Button
              type="button"
              size="sm"
              variant={action === "reset" ? "outline" : "default"}
              disabled={pending !== null}
              onClick={() => setOpen(action)}
            >
              {action === "reset" ? <Eraser className="size-3.5" aria-hidden /> : <Database className="size-3.5" aria-hidden />}
              {COPY[action].button}
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{COPY[action].title}</DialogTitle>
                <DialogDescription>{COPY[action].body}</DialogDescription>
              </DialogHeader>
              {error ? (
                <p role="alert" className="text-[12px] text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose render={<Button type="button" size="sm" variant="outline" />}>Cancel</DialogClose>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={pending !== null}
                  onClick={() => void run(action)}
                >
                  {pending === action ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {COPY[action].confirm}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ))}
      </div>
      {notice ? (
        <p role="status" className="text-[12px] text-emerald-600 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}
      {error && open === null ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
