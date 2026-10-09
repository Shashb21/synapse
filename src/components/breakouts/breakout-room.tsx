"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GapBadge } from "@/components/iegp-badges";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import { SplitGapDialog } from "@/components/split-gap-dialog";
import { LockForm } from "@/components/lock-form";
import { Button } from "@/components/ui/button";
import { Pencil, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DOMAIN_LABELS, GAP_STATUS_LABELS } from "@/lib/iegp/enums";
import type { ReviewGapCard } from "@/lib/iegp/engine";
import { cn } from "@/lib/utils";
import { postJson } from "@/lib/post-json";

export type PickableGap = {
  gap_id: string;
  gap_name: string;
  domain_label: string;
  settings: string[];
  priority: string;
  /** Other breakout groups the gap is already in (a gap can be in several). */
  other_groups: string[];
};

const FIELD = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";

async function postAction(body: Record<string, unknown>): Promise<string | null> {
  const res = await postJson("/api/iegp", body);
  if (res.ok) return null;
  return (res.json as { error?: string }).error ?? "Could not save.";
}

/**
 * Adds gaps to this breakout group (KAN-55): search, filter by theme (domain, setting,
 * priority), select all shown, and see which gaps are already in another group.
 */
export function AddGapsDialog({
  groupId,
  availableGaps,
}: {
  groupId: string;
  availableGaps: PickableGap[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [setting, setSetting] = useState("");
  const [priority, setPriority] = useState("");
  const [hideGrouped, setHideGrouped] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const domains = [...new Set(availableGaps.map((gap) => gap.domain_label))].sort();
  const settings = [...new Set(availableGaps.flatMap((gap) => gap.settings))].sort();
  const priorities = [...new Set(availableGaps.map((gap) => gap.priority))].sort();
  const q = query.trim().toLowerCase();
  const shown = availableGaps.filter(
    (gap) =>
      (!q || gap.gap_name.toLowerCase().includes(q) || gap.gap_id.toLowerCase().includes(q)) &&
      (!domain || gap.domain_label === domain) &&
      (!setting || gap.settings.includes(setting)) &&
      (!priority || gap.priority === priority) &&
      (!hideGrouped || gap.other_groups.length === 0),
  );
  const allShownSelected = shown.length > 0 && shown.every((gap) => selected.includes(gap.gap_id));

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setSelected([]);
      setQuery("");
      setDomain("");
      setSetting("");
      setPriority("");
      setError(null);
      setPending(false);
    }
  }

  async function onSubmit() {
    if (selected.length === 0) {
      setError("Pick at least one gap.");
      return;
    }
    setPending(true);
    setError(null);
    const failed = await postAction({ action: "assign_gaps_to_breakout", group_id: groupId, gap_ids: selected.join(",") });
    setPending(false);
    if (failed) {
      setError(failed);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger render={<Button variant="default" />}>
        <Plus className="size-3.5" /> Add gaps
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add gaps to this group</DialogTitle>
          <DialogDescription>
            Filter by theme, then pick gaps one by one or all at once. A gap can be in more than one group.
          </DialogDescription>
        </DialogHeader>
        {availableGaps.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">Every live gap is already in this group.</p>
        ) : (
          <div className="grid gap-2">
            <div className="grid gap-2 sm:grid-cols-4">
              <input
                type="search"
                aria-label="Search gaps"
                placeholder="Search gaps…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className={FIELD}
              />
              <select aria-label="Filter by domain" value={domain} onChange={(event) => setDomain(event.target.value)} className={FIELD}>
                <option value="">Any domain</option>
                {domains.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <select aria-label="Filter by setting" value={setting} onChange={(event) => setSetting(event.target.value)} className={FIELD}>
                <option value="">Any setting</option>
                {settings.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <select aria-label="Filter by priority" value={priority} onChange={(event) => setPriority(event.target.value)} className={FIELD}>
                <option value="">Any priority</option>
                {priorities.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <label className="flex items-center gap-1.5 text-foreground">
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  onChange={() =>
                    setSelected((prev) =>
                      allShownSelected
                        ? prev.filter((id) => !shown.some((gap) => gap.gap_id === id))
                        : [...new Set([...prev, ...shown.map((gap) => gap.gap_id)])],
                    )
                  }
                />
                Select all shown ({shown.length})
              </label>
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <input type="checkbox" checked={hideGrouped} onChange={(event) => setHideGrouped(event.target.checked)} />
                Hide gaps already in another group
              </label>
              <span className="ml-auto text-muted-foreground">{selected.length} selected</span>
            </div>
            <ul className="grid max-h-72 gap-1 overflow-y-auto" aria-label="Gaps to add">
              {shown.map((gap) => (
                <li key={gap.gap_id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2.5 py-1.5 hover:bg-muted/50">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.includes(gap.gap_id)}
                      onChange={() =>
                        setSelected((prev) =>
                          prev.includes(gap.gap_id) ? prev.filter((id) => id !== gap.gap_id) : [...prev, gap.gap_id],
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] text-foreground">
                        <span className="font-mono text-[10px] text-primary">{gap.gap_id}</span> {gap.gap_name}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        {[gap.domain_label, gap.priority, ...gap.settings].join(" · ")}
                        {gap.other_groups.length > 0 ? ` · also in ${gap.other_groups.join(", ")}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
              {shown.length === 0 ? <li className="text-[12px] text-muted-foreground">No gaps match.</li> : null}
            </ul>
          </div>
        )}
        {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button disabled={pending || selected.length === 0} onClick={() => void onSubmit()}>
            {pending ? "Adding…" : `Add ${selected.length || ""} gap${selected.length === 1 ? "" : "s"}`.replace("  ", " ")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Rename the group or change what it covers. */
export function EditGroupDialog({ groupId, name, note }: { groupId: string; name: string; note: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nextName, setNextName] = useState(name);
  const [nextNote, setNextNote] = useState(note ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setNextName(name);
          setNextNote(note ?? "");
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        <Pencil className="size-3.5" /> Edit group
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit breakout group</DialogTitle>
          <DialogDescription>The name and what the group covers.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Name
            <input value={nextName} onChange={(event) => setNextName(event.target.value)} className={FIELD} />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            What it covers
            <input value={nextNote} onChange={(event) => setNextNote(event.target.value)} className={FIELD} />
          </label>
          {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true);
              const failed = await postAction({ action: "update_breakout_group", group_id: groupId, name: nextName, note: nextNote });
              setPending(false);
              if (failed) return setError(failed);
              setOpen(false);
              router.refresh();
            }}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Moves a gap from this group to another. */
function MoveSelect({ gapId, groupId, otherGroups }: { gapId: string; groupId: string; otherGroups: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  if (otherGroups.length === 0) return null;
  return (
    <select
      aria-label="Move to another group"
      value=""
      disabled={pending}
      onChange={async (event) => {
        const to = event.target.value;
        if (!to) return;
        setPending(true);
        await postAction({ action: "move_gap_to_breakout", gap_id: gapId, from_group_id: groupId, to_group_id: to });
        setPending(false);
        router.refresh();
      }}
      className="h-8 rounded-lg border border-input bg-card px-2 text-[12px] text-foreground"
    >
      <option value="">{pending ? "Moving…" : "Move to…"}</option>
      {otherGroups.map((group) => (
        <option key={group.id} value={group.id}>
          {group.name}
        </option>
      ))}
    </select>
  );
}

function RoomGapCard({
  card,
  groupId,
  focused,
  otherGroups,
}: {
  card: ReviewGapCard;
  groupId: string;
  focused: boolean;
  otherGroups: { id: string; name: string }[];
}) {
  const isPartial = card.gap_status === "validated_partial";
  return (
    <article
      className={cn(
        "border bg-card p-5 transition-colors rounded-lg",
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
      <h3 className="mt-2 text-[15px] font-semibold leading-6 text-foreground">
        <span className="mr-1 font-mono text-[11px] font-normal text-primary">{card.gap_id}</span>
        {card.gap_name}
      </h3>
      <p className="mt-2 text-[13px] text-muted-foreground">
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
            note={{ label: "Note (optional)" }}
            confirmLabel={`Confirm ${GAP_STATUS_LABELS[card.gap_status]}`}
            variant="default"
          />
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <MoveSelect gapId={card.gap_id} groupId={groupId} otherGroups={otherGroups} />
          <RemoveButton groupId={groupId} gapId={card.gap_id} />
        </span>
      </div>
    </article>
  );
}

function RemoveButton({ groupId, gapId }: { groupId: string; gapId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await postAction({ action: "unassign_gap_from_breakout", group_id: groupId, gap_id: gapId });
        setPending(false);
        router.refresh();
      }}
    >
      <X className="size-3.5" /> Remove
    </Button>
  );
}

/**
 * ← → move focus between cards, Esc clears it — the board-navigation pattern
 * copied from /accuracy/workshop (see docs/presentation-and-breakouts.md).
 */
export function BreakoutBoard({
  groupId,
  cards,
  otherGroups = [],
}: {
  groupId: string;
  cards: ReviewGapCard[];
  otherGroups?: { id: string; name: string }[];
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
      <p className="rounded-lg border border-dashed border-border bg-card p-6 text-center text-[12px] text-muted-foreground">
        No gaps in this group yet. Use Add gaps to pick them, or filter by a theme and add them all at once.
      </p>
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
          otherGroups={otherGroups}
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
