"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
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

export type ActionField = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "date" | "select";
  options?: { value: string; label: string }[];
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
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
}) {
  const router = useRouter();
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
    for (const field of fields) {
      const value = data.get(field.name);
      if (value !== null) extra[field.name] = field.type === "number" ? Number(value) : String(value);
      if (field.required && !String(value ?? "").trim()) {
        setError(`${field.label} is required.`);
        return;
      }
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
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Action failed");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
              <label key={field.name} className="grid gap-1 text-[12px] text-muted-foreground">
                {field.label}
                {field.type === "textarea" ? (
                  <Textarea name={field.name} rows={3} defaultValue={field.defaultValue} placeholder={field.placeholder} />
                ) : field.type === "select" ? (
                  <select
                    name={field.name}
                    defaultValue={field.defaultValue}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                  >
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
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : (confirmLabel ?? "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
