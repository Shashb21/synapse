"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GapBadge } from "@/components/iegp-badges";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import { SplitGapDialog } from "@/components/split-gap-dialog";
import { LockForm } from "@/components/lock-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ACTOR_FUNCTIONS,
  DOMAIN_LABELS,
  FUNCTION_LABELS,
  GAP_STATUS_LABELS,
  type ActorFunction,
} from "@/lib/iegp/enums";
import type { ReviewGapCard } from "@/lib/iegp/engine";
import { cn } from "@/lib/utils";

type PickableGap = { gap_id: string; gap_name: string; domain_label: string };

/** Adds gaps to this breakout group. Loops one POST per selection — a handful at a time in practice. */
export function AddGapsDialog({
  groupId,
  availableGaps,
  defaultActorName,
  defaultActorFunction,
}: {
  groupId: string;
  availableGaps: PickableGap[];
  defaultActorName?: string;
  defaultActorFunction?: ActorFunction;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [actorName, setActorName] = useState(defaultActorName ?? "");
  const [actorFunction, setActorFunction] = useState<ActorFunction>(
    defaultActorFunction ?? "medical_affairs",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setSelected([]);
      setActorName(defaultActorName ?? "");
      setActorFunction(defaultActorFunction ?? "medical_affairs");
      setError(null);
      setPending(false);
    }
  }

  async function onSubmit() {
    const name = actorName.trim();
    if (!name) {
      setError("Type your name.");
      return;
    }
    if (selected.length === 0) {
      setError("Pick at least one gap.");
      return;
    }
    setPending(true);
    setError(null);
    for (const gap_id of selected) {
      const res = await fetch("/api/iegp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "assign_gap_to_breakout",
          group_id: groupId,
          gap_id,
          actor_name: name,
          actor_function: actorFunction,
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setError(json.error ?? "Could not add a gap.");
        setPending(false);
        return;
      }
    }
    setPending(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger render={<Button size="sm" variant="default" />}>Add gaps</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add gaps to this breakout</DialogTitle>
          <DialogDescription>
            Every live gap not already in this group. Assigning does not remove it from anywhere
            else — a gap can be in more than one breakout.
          </DialogDescription>
        </DialogHeader>
        {availableGaps.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">Every live gap is already in this group.</p>
        ) : (
          <ul className="grid max-h-64 gap-1.5 overflow-y-auto">
            {availableGaps.map((gap) => (
              <li key={gap.gap_id}>
                <label className="flex items-start gap-2 text-[13px] text-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.includes(gap.gap_id)}
                    onChange={() =>
                      setSelected((prev) =>
                        prev.includes(gap.gap_id)
                          ? prev.filter((id) => id !== gap.gap_id)
                          : [...prev, gap.gap_id],
                      )
                    }
                  />
                  <span>
                    {gap.gap_name}{" "}
                    <span className="text-[11px] text-muted-foreground">({gap.domain_label})</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 border-t border-border pt-3">
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Name
            <Input value={actorName} placeholder="Your name" onChange={(e) => setActorName(e.target.value)} />
          </label>
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            value={actorFunction}
            onChange={(e) => setActorFunction(e.target.value as ActorFunction)}
          >
            {ACTOR_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>
                {FUNCTION_LABELS[fn]}
              </option>
            ))}
          </select>
          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" disabled={pending || availableGaps.length === 0} onClick={() => void onSubmit()}>
            {pending ? "Adding…" : "Add selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoomGapCard({
  card,
  groupId,
  focused,
  defaultActorName,
  defaultActorFunction,
}: {
  card: ReviewGapCard;
  groupId: string;
  focused: boolean;
  defaultActorName?: string;
  defaultActorFunction?: ActorFunction;
}) {
  const isPartial = card.gap_status === "validated_partial";
  return (
    <article
      className={cn(
        "border bg-card p-5 transition-colors",
        focused ? "border-foreground ring-2 ring-foreground/25" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {isPartial ? (
          <GapBadge status={card.gap_status} />
        ) : (
          <GapStatusOverride
            gapId={card.gap_id}
            status={card.gap_status}
            computedStatus={card.computed_status}
            override={card.status_override}
          />
        )}
        <span className="text-[13px] text-muted-foreground">{DOMAIN_LABELS[card.domain]}</span>
      </div>
      <GapStatusDisagreement computedStatus={card.computed_status} override={card.status_override} />
      <h3 className="mt-2 text-[20px] font-medium leading-7 text-foreground">{card.gap_name}</h3>
      <p className="mt-2 text-[14px] text-muted-foreground">
        {card.tactics.length} tactic{card.tactics.length === 1 ? "" : "s"} mapped
        {!card.human_validated ? " · unconfirmed" : ""}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {isPartial ? (
          <SplitGapDialog
            gapId={card.gap_id}
            gapName={card.gap_name}
            residualName={card.residual?.statement || card.gap_name}
            tactics={card.tactics}
          />
        ) : !card.human_validated ? (
          <LockForm
            label="Confirm status"
            action="validate_gap"
            extra={{ gap_id: card.gap_id }}
            confirmLabel={`Confirm ${GAP_STATUS_LABELS[card.gap_status]}`}
            variant="default"
            defaultActorName={defaultActorName}
            defaultActorFunction={defaultActorFunction}
          />
        ) : null}
        <LockForm
          label="Remove from group"
          action="unassign_gap_from_breakout"
          extra={{ group_id: groupId, gap_id: card.gap_id }}
          confirmLabel="Remove"
          defaultActorName={defaultActorName}
          defaultActorFunction={defaultActorFunction}
        />
      </div>
    </article>
  );
}

/**
 * ← → move focus between cards, Esc clears it — the board-navigation pattern
 * copied from /accuracy/workshop (see docs/presentation-and-breakouts.md).
 */
export function BreakoutBoard({
  groupId,
  cards,
  defaultActorName,
  defaultActorFunction,
}: {
  groupId: string;
  cards: ReviewGapCard[];
  defaultActorName?: string;
  defaultActorFunction?: ActorFunction;
}) {
  const [focused, setFocused] = useState<number | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (cards.length === 0) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setFocused((i) => (i === null ? 0 : Math.min(i + 1, cards.length - 1)));
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setFocused((i) => (i === null ? 0 : Math.max(i - 1, 0)));
      } else if (event.key === "Escape") {
        setFocused(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length]);

  if (cards.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">No gaps assigned yet. Add some above.</p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {cards.map((card, i) => (
        <RoomGapCard
          key={card.gap_id}
          card={card}
          groupId={groupId}
          focused={focused === i}
          defaultActorName={defaultActorName}
          defaultActorFunction={defaultActorFunction}
        />
      ))}
    </div>
  );
}

/** Polls lightly so a second window/consultant's edits eventually show up. See docs/presentation-and-breakouts.md. */
export function RoomAutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
