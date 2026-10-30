"use client";

/** Owner's source inventory clear control, with confirmation and request feedback. */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { usePageRefresh } from "@/components/platform/use-page-refresh";
import { postJson } from "@/lib/post-json";
import { CLEAR_INGESTED_FILES_DESCRIPTION } from "@/lib/ingest/clear-confirmation";

/** Confirm destructive removal and refresh the current source inventory after success. */
export function ClearIngestedFiles() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [checkRequired, setCheckRequired] = useState(false);
  const { refreshing, refresh } = usePageRefresh();
  const busy = pending || refreshing;

  async function clear() {
    if (busy || checkRequired) return;
    setPending(true);
    setError(null);
    setSuccess(false);
    const response = await postJson("/api/iegp", { action: "clear_ingested_files", confirmation: "clear_ingested_files" });
    setPending(false);
    if (!response.ok) {
      setCheckRequired(response.outcome !== "rejected");
      setError((response.json as { error?: string }).error ?? "The clear could not be confirmed. Reload sources to check the current contents before clearing again.");
      return;
    }
    refresh(() => { setOpen(false); setSuccess(true); });
  }

  return (
    <div>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); setError(null); } }}>
        <DialogTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>
          Clear ingested files
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear ingested files?</DialogTitle>
            <DialogDescription>{CLEAR_INGESTED_FILES_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {checkRequired ? <Button variant="outline" onClick={() => window.location.reload()}>Check current sources</Button> : null}
          {busy ? <p role="status" className="text-sm text-muted-foreground">{pending ? "Clearing files…" : "Refreshing sources…"}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || checkRequired} onClick={() => void clear()}>Clear files and extracted records</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {success ? <p role="status" className="mt-2 text-sm text-muted-foreground">Current sources and their extracted records cleared. Manual work and historical records retained.</p> : null}
    </div>
  );
}
