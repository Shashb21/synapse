"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
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
} from "@/components/ui/dialog";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { TACTIC_TYPES, TACTIC_TYPE_LABELS } from "@/lib/iegp/enums";
import { LANE_LABELS, TIMELINE_LANES, type TimelineActivity } from "@/modules/stages/s10-timeline/build";
import { dependencyConflicts, type DependencyConflict } from "@/modules/stages/s10-timeline/gap-view";

const SMALL_TRIGGER = <Button size="xs" variant="outline" />;

/** Dates an activity by hand, with no model: start, end, readout, and optionally a lane and rationale. */
export function ManualDatesDialog({
  identity,
  tacticId,
  label,
  title,
  hint,
  tactics,
  small = false,
}: {
  identity: ActionIdentity;
  /** Fixed tactic; omit and pass `tactics` to let the user choose one. */
  tacticId?: string;
  label: string;
  title: string;
  hint?: string;
  tactics?: { tactic_id: string; name: string }[];
  /** A compact trigger for rows on the chart. */
  small?: boolean;
}) {
  return (
    <ActionDialog
      endpoint="/api/plan"
      payload={{ action: "add_activity", ...(tacticId ? { tactic_id: tacticId } : {}) }}
      label={label}
      title={title}
      description="Your dates are marked as yours and survive every rebuild; no model is needed. The change is recorded with its rationale."
      confirmLabel="Save dates"
      identity={identity}
      trigger={small ? SMALL_TRIGGER : undefined}
      fields={[
        ...(tactics
          ? [
              {
                name: "tactic_id",
                label: "Tactic",
                type: "select" as const,
                defaultValue: tactics[0]?.tactic_id,
                options: tactics.map((row) => ({ value: row.tactic_id, label: row.name })),
                required: true,
              },
            ]
          : []),
        { name: "start_date", label: "Start", type: "date", hint, required: !hint },
        { name: "end_date", label: "End", type: "date", required: !hint },
        { name: "readout_date", label: "Readout (optional)", type: "date" },
        {
          name: "lane",
          label: "Lane",
          type: "select",
          defaultValue: "",
          options: [
            { value: "", label: "Follow the validated band" },
            ...TIMELINE_LANES.map((lane) => ({ value: lane, label: LANE_LABELS[lane] })),
          ],
        },
        { name: "schedule_rationale", label: "Why these dates (optional, shown on the activity)", type: "textarea" },
      ]}
    />
  );
}

/**
 * Adds a new activity under a gap from the timeline: a proposed tactic mapped
 * to that gap. Dates are optional; without them it shows as "Unscheduled".
 */
export function CreateActivityDialog({
  identity,
  gap,
  label = "Add activity",
  small = true,
}: {
  identity: ActionIdentity;
  gap: { gap_id: string; gap_name: string; statement: string };
  label?: string;
  small?: boolean;
}) {
  return (
    <ActionDialog
      endpoint="/api/plan"
      payload={{ action: "create_activity", gap_id: gap.gap_id }}
      label={label}
      title={`Add an activity under ${gap.gap_name}`}
      description="Creates a proposed tactic mapped to this gap. Leave the dates empty to keep it unscheduled. Everything you enter is yours and no rebuild overwrites it."
      confirmLabel="Add activity"
      identity={identity}
      trigger={small ? SMALL_TRIGGER : undefined}
      fields={[
        { name: "name", label: "Activity name", required: true, placeholder: "e.g. Real-world treatment patterns study" },
        {
          name: "type",
          label: "Type",
          type: "select",
          defaultValue: "rwe_study",
          options: TACTIC_TYPES.map((type) => ({ value: type, label: TACTIC_TYPE_LABELS[type] })),
          required: true,
        },
        {
          name: "evidence_question",
          label: "Evidence question it answers",
          type: "textarea",
          defaultValue: gap.statement,
          required: true,
        },
        { name: "start_date", label: "Start (optional)", type: "date" },
        { name: "end_date", label: "End (optional)", type: "date" },
        { name: "readout_date", label: "Readout (optional)", type: "date" },
      ]}
    />
  );
}

/** Edits the activity's own record (the tactic): name, type and evidence question. */
export function EditActivityDialog({ identity, activity }: { identity: ActionIdentity; activity: TimelineActivity }) {
  return (
    <ActionDialog
      endpoint="/api/iegp"
      payload={{ action: "modify_tactic", tactic_id: activity.tactic_id }}
      label="Edit details"
      title={`Edit ${activity.tactic_name}`}
      description="Changes the tactic behind this activity. Your values are locked as yours."
      confirmLabel="Save"
      identity={identity}
      fields={[
        { name: "name", label: "Activity name", defaultValue: activity.tactic_name, required: true },
        {
          name: "type",
          label: "Type",
          type: "select",
          defaultValue: activity.tactic_type,
          options: TACTIC_TYPES.map((type) => ({ value: type, label: TACTIC_TYPE_LABELS[type] })),
        },
        {
          name: "evidence_question",
          label: "Evidence question",
          type: "textarea",
          defaultValue: activity.meta.evidence_question,
          required: true,
        },
      ]}
    />
  );
}

export function ConflictList({ conflicts }: { conflicts: DependencyConflict[] }) {
  return (
    <ul className="grid gap-1">
      {conflicts.map((conflict) => (
        <li key={`${conflict.predecessor_id}->${conflict.successor_id}`} className="text-[11px] text-foreground">
          <span className="font-medium">{conflict.successor_name}</span> starts {conflict.successor_start}, before{" "}
          <span className="font-medium">{conflict.predecessor_name}</span> ends {conflict.predecessor_end}.
        </li>
      ))}
    </ul>
  );
}

export type DragChange = { activity: TimelineActivity; start_date: string; end_date: string };

/**
 * Confirms a drag on the chart: the new dates (still editable), the
 * dependencies the move would break, and the rationale every edit carries.
 * Nothing moves until it is saved, and nothing else is shifted automatically.
 */
export function DragRescheduleDialog({
  change,
  activities,
  identity,
  onClose,
}: {
  change: DragChange | null;
  activities: TimelineActivity[];
  identity: ActionIdentity;
  onClose: () => void;
}) {
  const router = useRouter();
  const [start, setStart] = useState(change?.start_date ?? "");
  const [end, setEnd] = useState(change?.end_date ?? "");
  const [rationale, setRationale] = useState("Moved on the timeline");
  const [actorName, setActorName] = useState(identity.signed_in ? identity.actor_name : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = change?.activity.id;
  const conflicts = id
    ? dependencyConflicts(
        activities.map((row) => (row.id === id ? { ...row, start_date: start, end_date: end } : row)),
      ).filter((conflict) => conflict.predecessor_id === id || conflict.successor_id === id)
    : [];

  async function save() {
    if (!change) return;
    setError(null);
    if (!start || !end) return setError("A start and an end date are required.");
    if (end < start) return setError("An activity cannot end before it starts.");
    if (rationale.trim().length < 3) return setError("A short rationale is required.");
    if (!identity.signed_in && !actorName.trim()) return setError("Type your name so the edit has an actor.");
    setPending(true);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "move_activity",
        id: change.activity.id,
        start_date: start,
        end_date: end,
        rationale: rationale.trim(),
        actor_name: actorName.trim() || identity.actor_name,
        actor_function: identity.actor_function,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setPending(false);
    if (!res.ok) return setError(json.error ?? "Could not save the new dates.");
    onClose();
    router.refresh();
  }

  return (
    <Dialog open={change !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="z-[60] sm:max-w-md">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reschedule {change?.activity.tactic_name}</DialogTitle>
            <DialogDescription>
              From {change?.activity.start_date} → {change?.activity.end_date}. Your dates are marked as yours and
              survive every rebuild.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                Start
                <Input type="date" name="start_date" value={start} onChange={(event) => setStart(event.target.value)} />
              </label>
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                End
                <Input type="date" name="end_date" value={end} onChange={(event) => setEnd(event.target.value)} />
              </label>
            </div>
            {conflicts.length > 0 ? (
              <div role="alert" className="grid gap-1 border border-destructive/50 bg-destructive/10 p-2">
                <p className="flex items-center gap-1 text-[12px] font-medium text-destructive">
                  <AlertTriangle className="size-3.5" /> This breaks a dependency
                </p>
                <ConflictList conflicts={conflicts} />
                <p className="text-[11px] text-muted-foreground">
                  You can still save; nothing else is moved automatically.
                </p>
              </div>
            ) : null}
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Rationale (required)
              <Textarea name="rationale" rows={2} value={rationale} onChange={(event) => setRationale(event.target.value)} />
            </label>
            {!identity.signed_in ? (
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                Name
                <Input value={actorName} placeholder="Your name" onChange={(event) => setActorName(event.target.value)} />
              </label>
            ) : null}
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save dates"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
