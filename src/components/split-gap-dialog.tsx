"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import type { PlanTactic } from "@/lib/iegp/engine";

const DEFAULT_FUNCTION: ActorFunction = "evidence_lead";
const FUNCTION_OPTIONS: ActorFunction[] = [
  DEFAULT_FUNCTION,
  ...ACTOR_FUNCTIONS.filter((fn) => fn !== DEFAULT_FUNCTION),
];

export function SplitGapDialog({
  gapId,
  gapName,
  residualName,
  tactics,
}: {
  gapId: string;
  gapName: string;
  residualName: string;
  tactics: PlanTactic[];
}) {
  const router = useRouter();
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"split" | "rewrite">("split");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actorName, setActorName] = useState("");
  const [actorFunction, setActorFunction] = useState<ActorFunction>(DEFAULT_FUNCTION);
  const [addressedName, setAddressedName] = useState(gapName);
  const [openName, setOpenName] = useState(residualName);
  const [rewriteName, setRewriteName] = useState(gapName);
  const [rewriteStatus, setRewriteStatus] = useState<"validated_open" | "validated_addressed">(
    "validated_open",
  );
  const counting = tactics.filter((t) => t.status === "completed" || t.status === "ongoing" || t.status === "planned");
  const defaultTactic = counting[0]?.id ?? tactics[0]?.id ?? "";
  const [tacticId, setTacticId] = useState(defaultTactic);

  function reset() {
    setError(null);
    setPending(false);
    setActorName("");
    setActorFunction(DEFAULT_FUNCTION);
    setMode("split");
    setAddressedName(gapName);
    setOpenName(residualName);
    setRewriteName(gapName);
    setRewriteStatus("validated_open");
    setTacticId(defaultTactic);
  }

  async function onSubmit() {
    const name = actorName.trim();
    if (!name) {
      setError("Type your name.");
      nameRef.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    const payload =
      mode === "split"
        ? {
            action: "split_partial_gap",
            parent_gap_id: gapId,
            addressed_name: addressedName,
            open_name: openName,
            tactic_id: tacticId,
            actor_name: name,
            actor_function: actorFunction,
          }
        : {
            action: "rewrite_partial_gap",
            gap_id: gapId,
            name: rewriteName,
            status: rewriteStatus,
            tactic_id: rewriteStatus === "validated_addressed" ? tacticId : "",
            actor_name: name,
            actor_function: actorFunction,
          };
    const res = await fetch("/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Could not resolve this gap.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>Resolve partial</DialogTrigger>
      <DialogContent className="z-[60] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Resolve Partially Addressed gap</DialogTitle>
          <DialogDescription>
            Split into an Addressed slice (left, with its tactic) and an Open leftover (right), or
            rewrite the original as Open or Addressed. The original is retired into version history.
            Partial cannot stay.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "split" ? "default" : "outline"}
            onClick={() => setMode("split")}
          >
            Split
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "rewrite" ? "default" : "outline"}
            onClick={() => setMode("rewrite")}
          >
            Rewrite original
          </Button>
        </div>
        {mode === "split" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="border border-border bg-card/40 p-3">
              <h3 className="text-[13px] font-medium">Addressed</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">Covered slice plus its tactic.</p>
              <label className="mt-3 grid gap-1 text-[12px] text-muted-foreground">
                Title
                <Input value={addressedName} onChange={(e) => setAddressedName(e.target.value)} />
              </label>
              <label className="mt-3 grid gap-1 text-[12px] text-muted-foreground">
                Tactic
                <select
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                  value={tacticId}
                  onChange={(e) => setTacticId(e.target.value)}
                >
                  {tactics.map((tactic) => (
                    <option key={tactic.id} value={tactic.id}>
                      {tactic.name} ({tactic.status})
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section className="border border-border bg-card/40 p-3">
              <h3 className="text-[13px] font-medium">Open</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">Residual evidence need.</p>
              <label className="mt-3 grid gap-1 text-[12px] text-muted-foreground">
                Title
                <Input value={openName} onChange={(e) => setOpenName(e.target.value)} />
              </label>
            </section>
          </div>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Rewritten title
              <Input value={rewriteName} onChange={(e) => setRewriteName(e.target.value)} />
            </label>
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Status
              <select
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={rewriteStatus}
                onChange={(e) =>
                  setRewriteStatus(e.target.value as "validated_open" | "validated_addressed")
                }
              >
                <option value="validated_open">Open</option>
                <option value="validated_addressed">Addressed</option>
              </select>
            </label>
            {rewriteStatus === "validated_addressed" ? (
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                Accompanying tactic
                <select
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                  value={tacticId}
                  onChange={(e) => setTacticId(e.target.value)}
                >
                  {tactics.map((tactic) => (
                    <option key={tactic.id} value={tactic.id}>
                      {tactic.name} ({tactic.status})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        )}
        <div className="grid gap-2">
          <label htmlFor={nameId} className="text-[12px] text-muted-foreground">
            Name
          </label>
          <Input
            ref={nameRef}
            id={nameId}
            value={actorName}
            placeholder="Your name"
            onChange={(e) => setActorName(e.target.value)}
          />
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            value={actorFunction}
            onChange={(e) => setActorFunction(e.target.value as ActorFunction)}
          >
            {FUNCTION_OPTIONS.map((fn) => (
              <option key={fn} value={fn}>
                {FUNCTION_LABELS[fn]}
              </option>
            ))}
          </select>
          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" size="sm" variant="outline" />}>
            Cancel
          </DialogClose>
          <Button type="button" size="sm" disabled={pending} onClick={() => void onSubmit()}>
            {pending ? "Saving…" : mode === "split" ? "Accept split" : "Rewrite and retire original"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
