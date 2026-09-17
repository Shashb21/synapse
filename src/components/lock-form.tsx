"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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

export function LockForm({
  label,
  action,
  extra,
  children,
  confirmLabel,
}: {
  label: string;
  action: string;
  extra?: Record<string, string>;
  children?: React.ReactNode;
  confirmLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    const payload: Record<string, unknown> = {
      action,
      actor_name: String(formData.get("actor_name") || ""),
      actor_function: String(formData.get("actor_function") || ""),
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        {label}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit(new FormData(e.currentTarget));
          }}
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              Type your name and function. No login. Every IEGP gate records an actor.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            {children}
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Name
              <Input name="actor_name" required placeholder="A. Rao" />
            </label>
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Function
              <select
                name="actor_function"
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                defaultValue="evidence_lead"
              >
                {ACTOR_FUNCTIONS.map((fn) => (
                  <option key={fn} value={fn}>
                    {FUNCTION_LABELS[fn as ActorFunction]}
                  </option>
                ))}
              </select>
            </label>
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
