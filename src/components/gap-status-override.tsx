"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { GapBadge } from "@/components/iegp-badges";
import {
  GAP_STATUS_LABELS,
  MAPPED_GAP_STATUSES,
  type GapStatus,
  type MappedGapStatus,
} from "@/lib/iegp/enums";
import type { GapStatusOverride as GapStatusOverrideRecord } from "@/lib/iegp/types";

export function GapStatusDisagreement({
  computedStatus,
  override,
}: {
  computedStatus: MappedGapStatus | null;
  override: GapStatusOverrideRecord | null;
}) {
  if (!override) return null;
  if (!override.stale) {
    return (
      <p className="text-[12px] leading-5 text-muted-foreground">
        Human override: {GAP_STATUS_LABELS[override.status]} (
        {GAP_STATUS_LABELS[override.from]} → {GAP_STATUS_LABELS[override.to]}
        ). {override.actor_name}. Reason: {override.reason}
      </p>
    );
  }
  return (
    <p className="text-[12px] leading-5 text-amber-300" role="status">
      Override disagrees with the engine. Showing {GAP_STATUS_LABELS[override.status]} (human, kept).
      Engine now computes {computedStatus ? GAP_STATUS_LABELS[computedStatus] : "a different status"} after
      ingest, a model run or a coverage refresh. Not silent-clobbered: keep your status, or open the status
      dialog and use the computed one.
    </p>
  );
}

export function GapStatusOverride({
  gapId,
  status,
  computedStatus,
  override,
  children,
}: {
  gapId: string;
  status: GapStatus;
  computedStatus: MappedGapStatus | null;
  override: GapStatusOverrideRecord | null;
  children?: ReactNode;
}) {
  const router = useRouter();
  const reasonId = useId();
  const statusId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const mappedDefault: MappedGapStatus =
    status === "validated_partial" || status === "validated_addressed" || status === "validated_open"
      ? status
      : (computedStatus ?? "validated_open");
  const [nextStatus, setNextStatus] = useState<MappedGapStatus>(mappedDefault);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setError(null);
      setReasonError(null);
      setReason("");
      setPending(false);
      setNextStatus(mappedDefault);
    }
  }

  async function onSubmit(form: HTMLFormElement) {
    const formData = new FormData(form);
    const why = String(formData.get("reason") || reason || "").trim();
    setError(null);
    setReasonError(null);
    if (!why) {
      setReasonError("A reason is required to override computed gap status.");
      reasonRef.current?.focus();
      return;
    }
    setPending(true);
    const res = await fetch("/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "override_gap_status",
        gap_id: gapId,
        status: nextStatus,
        reason: why,
      }),
    });
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Override failed");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  async function clearOverride() {
    setPending(true);
    const res = await fetch("/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "clear_gap_status_override",
        gap_id: gapId,
      }),
    });
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Clear failed");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  const triggerLabel = `Change status of this gap (currently ${GAP_STATUS_LABELS[status]})`;
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto p-0 hover:bg-transparent"
            aria-label={triggerLabel}
          />
        }
      >
        {children ?? <GapBadge status={status} />}
      </DialogTrigger>
      <DialogContent className="z-[60] sm:max-w-md" initialFocus={reasonRef}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit(e.currentTarget);
          }}
        >
          <DialogHeader>
            <DialogTitle>Override gap status</DialogTitle>
            <DialogDescription>
              Engine computed{" "}
              {computedStatus ? GAP_STATUS_LABELS[computedStatus] : "status from joined tactics"}. A
              non-empty reason is required. Cancel does not change status.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            <label className="grid gap-1 text-[12px] text-muted-foreground" htmlFor={statusId}>
              Status
              <select
                id={statusId}
                name="status"
                value={nextStatus}
                onChange={(e) => setNextStatus(e.target.value as MappedGapStatus)}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
              >
                {MAPPED_GAP_STATUSES.filter((s) => s !== "validated_partial").map((s) => (
                  <option key={s} value={s}>
                    {GAP_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-1">
              <label htmlFor={reasonId} className="text-[12px] text-muted-foreground">
                Reason
              </label>
              <Textarea
                ref={reasonRef}
                id={reasonId}
                name="reason"
                rows={3}
                required
                value={reason}
                aria-required="true"
                aria-invalid={reasonError ? true : undefined}
                placeholder="Why should this differ from the computed status?"
                onChange={(e) => {
                  setReason(e.target.value);
                  if (reasonError) setReasonError(null);
                }}
              />
              {reasonError ? (
                <p className="text-[12px] text-destructive">{reasonError}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">Required. Empty reason does not save.</p>
              )}
            </div>
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" size="sm" variant="outline" />}>
              Cancel
            </DialogClose>
            {override ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void clearOverride()}
              >
                Clear override
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save override"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
