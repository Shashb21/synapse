"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CheckCheck, Download, Loader2, RotateCcw } from "lucide-react";
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
import { sendJson, type WorkspaceTagModel } from "./model";
import { acceptDemoStep, DEMO_STEP_LABELS, demoStepFor } from "@/lib/demo/accept-steps";

/**
 * Shown on every page of a demo workspace (KAN-127): says it holds the Velmara
 * demo and, for its owner, resets it to the clean demo in one confirm, so a
 * client demo can start fresh. Same "load_demo" action as Workspace settings.
 */
export function DemoResetBar({ workspace }: { workspace: WorkspaceTagModel["current"] }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = workspace.role === "owner";
  const pathname = usePathname() ?? "";
  const place = useSearchParams()?.get("place") ?? null;
  const step = workspace.demo_mode ? demoStepFor(pathname, place) : null;
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // Client demo (KAN-138): the presenter can take this step's AI suggestions as they are, as the recording did.
  async function acceptAll() {
    if (!step) return;
    setAccepting("Starting…");
    setAcceptError(null);
    try {
      await acceptDemoStep(step, setAccepting);
      window.location.reload();
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Could not accept this step.");
      setAccepting(null);
    }
  }

  async function reset() {
    setPending(true);
    setError(null);
    try {
      await sendJson("/api/iegp", { action: "load_demo" });
      // A full load from the home page, so nothing from before the reset stays on screen.
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The demo could not be reset.");
      setPending(false);
    }
  }

  return (
    <div
      data-app-chrome
      data-testid="demo-reset-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-unknown/40 bg-unknown/5 px-4 py-1 text-caption text-muted-foreground sm:px-6"
    >
      <DemoBadge testId="demo-bar-badge" />
      <span>
        {workspace.demo_mode
          ? "Client demo mode: AI steps replay a recorded run, so no model is called."
          : "Demo workspace with the Velmara sample plan."}
      </span>
      {step ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={accepting !== null}
          title={`Accept all as in demo: ${DEMO_STEP_LABELS[step]}`}
          onClick={() => void acceptAll()}
        >
          {accepting ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <CheckCheck className="size-3" aria-hidden />}
          {accepting ?? "Accept all as in demo"}
        </Button>
      ) : null}
      {acceptError ? (
        <span role="alert" className="text-destructive">
          {acceptError}
        </span>
      ) : null}
      {/* The seven input documents, to upload during the demo or hand to the client (KAN-139). */}
      <a
        href="/api/demo/files"
        download
        className="ml-auto inline-flex items-center gap-1 text-caption font-medium text-foreground underline-offset-2 hover:underline"
      >
        <Download className="size-3" aria-hidden />
        Download demo files
      </a>
      {owner ? (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (pending) return;
            setOpen(next);
            if (!next) setError(null);
          }}
        >
          <Button type="button" size="xs" variant="outline" onClick={() => setOpen(true)}>
            <RotateCcw className="size-3" aria-hidden />
            Reset demo
          </Button>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Reset the demo?</DialogTitle>
              <DialogDescription>
                {workspace.demo_mode
                  ? `Everything in ${workspace.name} is deleted, including uploads and saved plan versions, and the demo restarts at upload with setup done. Use it before each client demo.`
                  : `Everything changed in ${workspace.name} since the demo was loaded is deleted, including saved plan versions, and the clean Velmara demo is put back. Use it before each client demo.`}
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <p role="alert" className="text-callout text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose render={<Button type="button" size="sm" variant="outline" disabled={pending} />}>Cancel</DialogClose>
              <Button type="button" size="sm" onClick={() => void reset()} disabled={pending}>
                {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                {pending ? "Resetting…" : "Reset demo"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
