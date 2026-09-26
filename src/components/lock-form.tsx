"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function firstMissingRequired(form: HTMLFormElement): HTMLElement | null {
  for (const el of Array.from(form.elements)) {
    if (
      !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    if (el.disabled || el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
    if (el.name === "note") continue;
    if (!el.required) continue;
    if (!String(el.value || "").trim()) return el;
  }
  return null;
}

export function LockForm({
  label,
  action,
  extra,
  children,
  confirmLabel,
  description,
  variant = "outline",
}: {
  label: string;
  action: string;
  extra?: Record<string, string>;
  children?: React.ReactNode;
  confirmLabel?: string;
  description?: string;
  /** Visual weight of the trigger button. Defaults to secondary ("outline"); pass "default" for a hero/primary action. */
  variant?: "default" | "outline";
}) {
  const router = useRouter();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setError(null);
      setPending(false);
    }
  }

  async function onSubmit(form: HTMLFormElement) {
    const formData = new FormData(form);
    setError(null);
    const missing = firstMissingRequired(form);
    if (missing) {
      setError("Fill every required field in this dialog, then try again.");
      missing.focus();
      return;
    }
    setPending(true);
    // The actor is the signed-in person; the server takes it from the session.
    const payload: Record<string, unknown> = {
      action,
      note: String(formData.get("note") || ""),
      ...extra,
    };
    for (const [k, v] of formData.entries()) {
      if (k === "note") continue;
      payload[k] = v;
    }
    const res = await fetch("/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Could not save. Try again.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" variant={variant} />}>
        {label}
      </DialogTrigger>
      <DialogContent className="z-[60] sm:max-w-md" initialFocus={noteRef}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit(e.currentTarget);
          }}
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {description ?? "Recorded in the audit trail under your name."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            {children}
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Note (required to override Addressed)
              <Textarea ref={noteRef} name="note" rows={3} />
            </label>
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : confirmLabel ?? "Lock"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
