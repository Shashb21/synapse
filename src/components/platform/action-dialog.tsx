"use client";

import { useId, useState } from "react";
import { usePageRefresh } from "@/components/platform/use-page-refresh";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import { tacticDatesError } from "@/lib/iegp/tactic-dates";

export type ActionField = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "date" | "select";
  options?: { value: string; label: string }[];
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** Checks the typed value before anything is sent; returns the message to show, or null. */
  validate?: (value: string) => string | null;
};

export type ActionIdentity = {
  signed_in: boolean;
  actor_name: string;
  actor_function: ActorFunction;
};

/**
 * One dialog for every platform mutation. It collects the fields an action needs,
 * always collects the rationale when the action records an edit, and posts to the
 * module API.
 */
export function ActionDialog({
  endpoint,
  payload,
  fields = [],
  label,
  title,
  description,
  confirmLabel,
  rationaleLabel,
  requireRationale = true,
  identity,
  variant = "outline",
  size = "sm",
  className,
  trigger,
  validateForm,
}: {
  endpoint: string;
  payload: Record<string, unknown>;
  fields?: ActionField[];
  label: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  rationaleLabel?: string;
  requireRationale?: boolean;
  identity: ActionIdentity;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "sm" | "default" | "icon-sm";
  className?: string;
  trigger?: React.ReactElement;
  /** A check across fields (by name, as typed) once each field passes its own; message or null. */
  validateForm?: (values: Record<string, string>) => string | null;
}) {
  const { refreshing, refresh } = usePageRefresh();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actorName, setActorName] = useState(identity.signed_in ? identity.actor_name : "");
  const [actorFunction, setActorFunction] = useState<ActorFunction>(identity.actor_function);

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const rationale = String(data.get("rationale") ?? "").trim();
    setError(null);
    if (requireRationale && rationale.length < 3) {
      setError("A short rationale is required. It is stored with the edit.");
      return;
    }
    if (!identity.signed_in && !actorName.trim()) {
      setError("Type your name so the edit has an actor.");
      return;
    }
    const extra: Record<string, unknown> = {};
    const typed: Record<string, string> = {};
    for (const field of fields) {
      const value = data.get(field.name);
      if (value !== null) extra[field.name] = field.type === "number" ? Number(value) : String(value);
      typed[field.name] = String(value ?? "");
      if (field.required && !String(value ?? "").trim()) {
        setError(`${field.label} is required.`);
        return;
      }
      const invalid = field.validate?.(String(value ?? ""));
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    // A tactic's dates, checked as the server will (KAN-68); a server page can't pass validateForm.
    const invalid =
      ("evidence_available" in typed ? tacticDatesError(typed.start_date, typed.evidence_available) : null) ??
      validateForm?.(typed);
    if (invalid) {
      setError(invalid);
      return;
    }
    setPending(true);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        ...extra,
        rationale,
        actor_name: actorName.trim() || identity.actor_name,
        actor_function: actorFunction,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Action failed");
      return;
    }
    setError(null);
    // The dialog closes as the refreshed data arrives, so the page never shows the old value.
    refresh(() => setOpen(false));
  }

  function onOpenChange(next: boolean) {
    // Each opening starts clean: an error from an earlier attempt does not linger.
    if (next) {
      setError(null);
      setPending(false);
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={trigger ?? <Button size={size} variant={variant} className={className} />}>
        {label}
      </DialogTrigger>
      <DialogContent className="z-[60] sm:max-w-md">
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title ?? label}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="grid gap-3 py-3">
            {fields.map((field) => (
              // A new default (the page refreshed after a save) remounts the control: Base UI
              // refuses to change an uncontrolled field's default in place (KAN-68).
              <label key={`${field.name}:${field.defaultValue ?? ""}`} className="grid gap-1 text-[12px] text-muted-foreground">
                {field.label}
                {field.type === "textarea" ? (
                  <Textarea name={field.name} rows={3} defaultValue={field.defaultValue} placeholder={field.placeholder} />
                ) : field.type === "select" ? (
                  <select
                    name={field.name}
                    defaultValue={field.defaultValue ?? (field.placeholder ? "" : undefined)}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                  >
                    {/* A placeholder means nothing is picked until the person picks it. */}
                    {field.placeholder ? (
                      <option value="" disabled>
                        {field.placeholder}
                      </option>
                    ) : null}
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    name={field.name}
                    type={field.type ?? "text"}
                    defaultValue={field.defaultValue}
                    placeholder={field.placeholder}
                  />
                )}
                {field.hint ? <span className="text-[11px] text-muted-foreground/80">{field.hint}</span> : null}
              </label>
            ))}
            {requireRationale ? (
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                {rationaleLabel ?? "Rationale (required)"}
                <Textarea name="rationale" rows={3} placeholder="Why this decision, in one line" />
                <span className="text-[11px] text-muted-foreground/80">
                  Stored on the edit record.
                </span>
              </label>
            ) : (
              <input type="hidden" name="rationale" value="" />
            )}
            {!identity.signed_in ? (
              <div className="grid gap-2 border-t border-border pt-3">
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Name
                  <Input
                    value={actorName}
                    placeholder="Your name"
                    onChange={(event) => setActorName(event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Function
                  <select
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                    value={actorFunction}
                    onChange={(event) => setActorFunction(event.target.value as ActorFunction)}
                  >
                    {ACTOR_FUNCTIONS.map((fn) => (
                      <option key={fn} value={fn}>
                        {FUNCTION_LABELS[fn]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" size="sm" disabled={pending || refreshing}>
              {pending || refreshing ? "Saving…" : (confirmLabel ?? "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
