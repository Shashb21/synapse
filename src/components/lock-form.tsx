"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
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

const DEFAULT_FUNCTION: ActorFunction = "evidence_lead";
const FUNCTION_OPTIONS: ActorFunction[] = [
  DEFAULT_FUNCTION,
  ...ACTOR_FUNCTIONS.filter((fn) => fn !== DEFAULT_FUNCTION),
];

function firstMissingRequired(form: HTMLFormElement): HTMLElement | null {
  for (const el of Array.from(form.elements)) {
    if (
      !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    if (el.disabled || el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
    if (el.name === "actor_name" || el.name === "actor_function" || el.name === "note") continue;
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
}: {
  label: string;
  action: string;
  extra?: Record<string, string>;
  children?: React.ReactNode;
  confirmLabel?: string;
  description?: string;
}) {
  const router = useRouter();
  const nameId = useId();
  const functionId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actorName, setActorName] = useState("");
  const [actorFunction, setActorFunction] = useState<ActorFunction>(DEFAULT_FUNCTION);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setError(null);
      setNameError(null);
      setActorName("");
      setActorFunction(DEFAULT_FUNCTION);
      setPending(false);
    }
  }

  async function onSubmit(form: HTMLFormElement) {
    const formData = new FormData(form);
    const name = String(formData.get("actor_name") || actorName || "").trim();
    const fn = String(formData.get("actor_function") || actorFunction || "").trim();
    setError(null);
    setNameError(null);
    if (!name) {
      setNameError("Type your name. “Your name” is a placeholder, not a filled value.");
      nameRef.current?.focus();
      return;
    }
    const missing = firstMissingRequired(form);
    if (missing) {
      setError("Fill every required field in this dialog, then try again.");
      missing.focus();
      return;
    }
    setPending(true);
    const payload: Record<string, unknown> = {
      action,
      actor_name: name,
      actor_function: fn,
      note: String(formData.get("note") || ""),
      ...extra,
    };
    for (const [k, v] of formData.entries()) {
      if (k === "actor_name" || k === "actor_function" || k === "note") continue;
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
      setError(json.error ?? "Lock failed");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        {label}
      </DialogTrigger>
      <DialogContent className="z-[60] sm:max-w-md" initialFocus={nameRef}>
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
              {description ?? "Type your name and function. No login. Every IEGP gate records an actor."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            {children}
            <div className="grid gap-1">
              <label htmlFor={nameId} className="text-[12px] text-muted-foreground">
                Name
              </label>
              <Input
                ref={nameRef}
                id={nameId}
                name="actor_name"
                value={actorName}
                autoComplete="name"
                placeholder="Your name"
                aria-required="true"
                aria-invalid={nameError ? true : undefined}
                className="placeholder:italic placeholder:text-muted-foreground/70"
                onChange={(e) => {
                  setActorName(e.target.value);
                  if (nameError) setNameError(null);
                }}
              />
              {nameError ? (
                <p className="text-[12px] text-destructive">{nameError}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Empty until you type. Example: A. Rao
                </p>
              )}
            </div>
            <div className="grid gap-1">
              <label htmlFor={functionId} className="text-[12px] text-muted-foreground">
                Function
              </label>
              <select
                id={functionId}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                value={actorFunction}
                onChange={(e) => setActorFunction(e.target.value as ActorFunction)}
              >
                {FUNCTION_OPTIONS.map((fn) => (
                  <option key={fn} value={fn}>
                    {FUNCTION_LABELS[fn]}
                  </option>
                ))}
              </select>
              <input type="hidden" name="actor_function" value={actorFunction} />
              <p className="text-[11px] text-muted-foreground">Defaults to Evidence lead.</p>
            </div>
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Note (required to override Addressed)
              <Textarea name="note" rows={3} />
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
