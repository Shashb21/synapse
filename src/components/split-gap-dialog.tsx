"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import type { PlanTactic } from "@/lib/iegp/engine";

const DEFAULT_FUNCTION: ActorFunction = "evidence_lead";
const FUNCTION_OPTIONS: ActorFunction[] = [
  DEFAULT_FUNCTION,
  ...ACTOR_FUNCTIONS.filter((fn) => fn !== DEFAULT_FUNCTION),
];

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((row) => row !== id) : [...list, id];
}

function TacticChecklist({
  tactics,
  selected,
  onToggle,
  empty,
}: {
  tactics: PlanTactic[];
  selected: string[];
  onToggle: (id: string) => void;
  empty: string;
}) {
  if (tactics.length === 0) {
    return <p className="mt-2 text-[11px] text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="mt-2 grid gap-1.5">
      {tactics.map((tactic) => (
        <li key={tactic.id}>
          <label className="flex items-start gap-2 text-[12px] text-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={selected.includes(tactic.id)}
              onChange={() => onToggle(tactic.id)}
            />
            <span className="min-w-0 whitespace-normal">
              {tactic.name}{" "}
              <span className="text-muted-foreground">
                ({tactic.status}
                {tactic.overall ? ` · ${tactic.overall.replaceAll("_", " ")}` : ""})
              </span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

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
  const countingIds = tactics.filter((t) => t.counts_toward_addressing).map((t) => t.id);
  const defaultAddressed = countingIds.length > 0 ? countingIds : tactics.slice(0, 1).map((t) => t.id);
  const [addressedTacticIds, setAddressedTacticIds] = useState<string[]>(defaultAddressed);
  const [openTacticIds, setOpenTacticIds] = useState<string[]>([]);
  const [rationale, setRationale] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposalNote, setProposalNote] = useState<string | null>(null);
  /**
   * Tracks whether the user edited the split themselves, as opposed to just
   * accepting the suggested (default or proposed) split. A rationale is only
   * required once they touch a name or tactic selection — see onSubmit.
   */
  const [touched, setTouched] = useState(false);
  const leftoverTactics = useMemo(
    () => tactics.filter((t) => !addressedTacticIds.includes(t.id)),
    [tactics, addressedTacticIds],
  );
  const rationaleRequired = mode === "rewrite" || touched;

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
    setAddressedTacticIds(defaultAddressed);
    setOpenTacticIds([]);
    setRationale("");
    setProposalNote(null);
    setProposing(false);
    setTouched(false);
  }

  /** S6 proposes the split; the user still validates every field before it applies. */
  async function proposeSplit() {
    setProposing(true);
    setError(null);
    setProposalNote(null);
    const res = await fetch("/api/modules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage: "S6",
        input: { gap_id: gapId },
        actor_name: actorName.trim() || "Unsigned",
        actor_function: actorFunction,
      }),
    });
    const json = (await res.json()) as {
      error?: string;
      summary?: string;
      output?: {
        proposal: {
          addressed_name: string;
          open_name: string;
          addressed_tactic_ids: string[];
          confidence: number;
          rationale: string[];
        } | null;
      };
    };
    setProposing(false);
    if (!res.ok) {
      setError(json.error ?? "Could not propose a split.");
      return;
    }
    const proposal = json.output?.proposal;
    if (!proposal) {
      setProposalNote("The stage returned no usable proposal. Fill the split in yourself.");
      return;
    }
    setMode("split");
    setAddressedName(proposal.addressed_name);
    setOpenName(proposal.open_name);
    if (proposal.addressed_tactic_ids.length > 0) {
      setAddressedTacticIds(proposal.addressed_tactic_ids);
    }
    // A suggestion, not a user edit — accepting it as-is still needs no rationale.
    setTouched(false);
    setProposalNote(
      `Proposed with confidence ${proposal.confidence}. ${proposal.rationale.slice(0, 2).join(" ")}`,
    );
  }

  async function onSubmit() {
    const name = actorName.trim();
    if (!name) {
      setError("Type your name.");
      nameRef.current?.focus();
      return;
    }
    if (mode === "split") {
      if (!addressedName.trim() || !openName.trim()) {
        setError("Both titles are required.");
        return;
      }
      if (addressedTacticIds.length === 0) {
        setError("The Addressed slice needs at least one tactic.");
        return;
      }
    } else {
      if (!rewriteName.trim()) {
        setError("Title is required.");
        return;
      }
      if (rewriteStatus === "validated_addressed" && addressedTacticIds.length === 0) {
        setError("Addressed gaps need at least one accompanying tactic.");
        return;
      }
    }
    if (rationaleRequired && rationale.trim().length < 3) {
      setError(
        mode === "split"
          ? "You changed the suggested split — a short rationale is required."
          : "A short rationale is required. It is stored with the edit and feeds hillclimb.",
      );
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
            tactic_ids: addressedTacticIds.join(","),
            open_tactic_ids: openTacticIds.filter((id) => leftoverTactics.some((t) => t.id === id)).join(","),
            note: rationale.trim(),
            actor_name: name,
            actor_function: actorFunction,
          }
        : {
            action: "rewrite_partial_gap",
            gap_id: gapId,
            name: rewriteName,
            status: rewriteStatus,
            tactic_ids: rewriteStatus === "validated_addressed" ? addressedTacticIds.join(",") : "",
            note: rationale.trim(),
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
      <DialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Resolve this Partially Addressed gap by splitting or rewriting"
          />
        }
      >
        Split or rewrite
      </DialogTrigger>
      <DialogContent className="z-[60] max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Resolve Partially Addressed gap</DialogTitle>
          <DialogDescription>
            Split into an Addressed slice (left, with chosen tactics) and an Open leftover (right),
            or rewrite the original as Open or Addressed. The original is retired into version
            history. Partial cannot stay.
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={proposing}
            onClick={() => void proposeSplit()}
          >
            {proposing ? "Proposing…" : "Suggest a split"}
          </Button>
        </div>
        {proposalNote ? (
          <p className="text-[11px] text-muted-foreground">{proposalNote}</p>
        ) : null}
        {mode === "split" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="border border-border bg-card/40 p-3">
              <h3 className="text-[13px] font-medium">Addressed</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Covered slice plus the mapped tactics that close it. At least one tactic is required.
              </p>
              <label className="mt-3 grid gap-1 text-[12px] text-muted-foreground">
                Title
                <Textarea
                  value={addressedName}
                  rows={2}
                  className="min-h-16 whitespace-normal"
                  onChange={(e) => {
                    setAddressedName(e.target.value);
                    setTouched(true);
                  }}
                />
              </label>
              <p className="mt-3 text-[12px] text-muted-foreground">Mapped tactics</p>
              <TacticChecklist
                tactics={tactics}
                selected={addressedTacticIds}
                onToggle={(id) => {
                  setAddressedTacticIds((prev) => toggleId(prev, id));
                  setTouched(true);
                }}
                empty="No mapped tactics on this gap."
              />
            </section>
            <section className="border border-border bg-card/40 p-3">
              <h3 className="text-[13px] font-medium">Open</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Residual evidence need. Remaining tactics are optional (usually none until Tactics).
              </p>
              <label className="mt-3 grid gap-1 text-[12px] text-muted-foreground">
                Title
                <Textarea
                  value={openName}
                  rows={2}
                  className="min-h-16 whitespace-normal"
                  onChange={(e) => {
                    setOpenName(e.target.value);
                    setTouched(true);
                  }}
                />
              </label>
              <p className="mt-3 text-[12px] text-muted-foreground">Remaining tactics (optional)</p>
              <TacticChecklist
                tactics={leftoverTactics}
                selected={openTacticIds}
                onToggle={(id) => {
                  setOpenTacticIds((prev) => toggleId(prev, id));
                  setTouched(true);
                }}
                empty="No leftover tactics — usually none until Tactics."
              />
            </section>
          </div>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Rewritten title
              <Textarea
                value={rewriteName}
                rows={2}
                className="min-h-16 whitespace-normal"
                onChange={(e) => setRewriteName(e.target.value)}
              />
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
              <div>
                <p className="text-[12px] text-muted-foreground">
                  Accompanying tactics (at least one)
                </p>
                <TacticChecklist
                  tactics={tactics}
                  selected={addressedTacticIds}
                  onToggle={(id) => setAddressedTacticIds((prev) => toggleId(prev, id))}
                  empty="Map an existing tactic or record a missed one on Gaps first."
                />
              </div>
            ) : null}
          </div>
        )}
        <div className="grid gap-2">
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            {rationaleRequired ? "Rationale (required)" : "Rationale (optional — accepting the suggested split as-is)"}
            <Textarea
              value={rationale}
              rows={2}
              placeholder={rationaleRequired ? "Why this split or rewrite, in one line" : "Optional — add a note if you'd like"}
              onChange={(e) => setRationale(e.target.value)}
            />
            <span className="text-[11px] text-muted-foreground/80">
              {mode === "split"
                ? touched
                  ? "Required because you changed the suggested split. Stored on the edit record and replayed as a hillclimb signal."
                  : "Accepting the split as suggested needs no rationale."
                : "Stored on the edit record and replayed as a hillclimb signal for the split stage."}
            </span>
          </label>
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
