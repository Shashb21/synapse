"use client";

import { useRef, useState } from "react";
import { usePageRefresh } from "@/components/platform/use-page-refresh";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { tacticDatesError } from "@/lib/iegp/tactic-dates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** The optional note a dialog collects. Only actions that store a note pass one. */
export type LockFormNote = { label: string; required?: boolean; placeholder?: string };

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function missingRequired(form: HTMLFormElement): FormControl[] {
  const missing: FormControl[] = [];
  for (const el of Array.from(form.elements)) {
    if (
      !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    if (el.disabled || el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
    if (!el.required) continue;
    if (!String(el.value || "").trim()) missing.push(el);
  }
  return missing;
}

/** The name a person sees for a field: its aria-label, its label's own text, or its placeholder. */
export function fieldName(el: FormControl): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const label = el.labels?.[0];
  if (label) {
    // The label's own words come before the control; a hint after it is not part of the name.
    let lead = "";
    for (const node of Array.from(label.childNodes)) {
      if (node === el || (node instanceof Element && node.contains(el))) break;
      lead += node.textContent ?? "";
    }
    const leadText = lead.replace(/\s+/g, " ").replace(/\s*(?:\*|\(required\))\s*$/i, "").trim();
    if (leadText) return leadText;
    // Otherwise the whole label, without the control's own text (options, typed value).
    const copy = label.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("input, select, textarea").forEach((node) => node.remove());
    const text = copy.textContent
      ?.replace(/\s+/g, " ")
      .replace(/\s*(?:\*|\(required\))\s*$/i, "")
      .trim();
    if (text) return text;
  }
  const placeholder = el instanceof HTMLSelectElement ? "" : el.placeholder.replace(/…$/, "").trim();
  return placeholder || el.name || "the required field";
}

/** Names the empty required fields instead of a vague "fill every required field" (KAN-68). */
export function missingFieldsMessage(names: string[]): string {
  const unique = [...new Set(names)].map((name) => `"${name}"`);
  if (unique.length === 1) return `Fill in ${unique[0]}, then try again.`;
  return `Fill in ${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}, then try again.`;
}

export function LockForm({
  label,
  action,
  extra,
  children,
  confirmLabel,
  description,
  variant = "outline",
  note,
  size = "md",
  href,
  triggerName,
}: {
  label: string;
  /**
   * The button's accessible name when several on a page share a label (e.g. one
   * "Accept merge" per suggestion). Starts with the label, so it still matches it.
   */
  triggerName?: string;
  action: string;
  extra?: Record<string, string>;
  children?: React.ReactNode;
  confirmLabel?: string;
  description?: string;
  /** Visual weight of the trigger button. Defaults to secondary ("outline"); pass "default" for a hero/primary action. */
  variant?: "default" | "outline";
  /**
   * Show a note field. Leave it out when the action does not use a note; the
   * request then carries an empty note.
   */
  note?: LockFormNote;
  /** A form with many fields gets a wider dialog (KAN-52). */
  size?: "md" | "lg";
  /** Where to go once the action has saved (e.g. the next place); without it the page refreshes in place. */
  href?: string;
}) {
  const { refreshing, refresh, navigate } = usePageRefresh();
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
    const missing = missingRequired(form);
    if (missing.length > 0) {
      setError(missingFieldsMessage(missing.map(fieldName)));
      missing[0]!.focus();
      return;
    }
    // A tactic's dates: the same check the server makes, before anything is sent (KAN-68).
    if (form.elements.namedItem("evidence_available")) {
      const dateError = tacticDatesError(
        String(formData.get("start_date") ?? ""),
        String(formData.get("evidence_available") ?? ""),
      );
      if (dateError) {
        setError(dateError);
        return;
      }
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
    // The dialog closes as the new data (or the next page) arrives, not before it.
    if (href) navigate(href, () => setOpen(false));
    else refresh(() => setOpen(false));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" variant={variant} />} aria-label={triggerName}>
        {label}
      </DialogTrigger>
      <DialogContent className={size === "lg" ? "z-[60] sm:max-w-2xl" : "z-[60] sm:max-w-md"} initialFocus={note ? noteRef : undefined}>
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
            {note ? (
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                {note.label}
                <Textarea
                  ref={noteRef}
                  name="note"
                  rows={3}
                  required={note.required}
                  placeholder={note.placeholder}
                />
              </label>
            ) : null}
            {error ? (
              <p role="alert" className="text-[12px] text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" size="sm" disabled={pending || refreshing}>
              {pending || refreshing ? "Saving…" : confirmLabel ?? "Lock"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
