"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
import { postJson } from "@/lib/post-json";

const SMALL_TRIGGER = <Button size="xs" variant="outline" />;

/** Dates an activity by hand, with no model: start, end, readout, and optionally a lane and rationale. */
export function ManualDatesDialog({
  identity,
  tacticId,
  expansionId,
  label,
  title,
  hint,
  tactics,
  small = false,
}: {
  identity: ActionIdentity;
  /** Fixed tactic; omit and pass `tactics` to let the user choose one. */
  tacticId?: string;
  expansionId?: string;
  label: string;
  title: string;
  hint?: string;
  tactics?: { tactic_id: string; expansion_id?: string; name: string }[];
  /** A compact trigger for rows on the chart. */
  small?: boolean;
}) {
  return (
    <ActionDialog
      endpoint="/api/plan"
      payload={{ action: "add_activity", ...(tacticId ? { tactic_id: tacticId } : {}), ...(expansionId ? {expansion_id: expansionId} : {}) }}
      label={label}
      title={title}
      description="Your dates are marked as yours and survive every rebuild. The change is recorded with its rationale."
      confirmLabel="Save dates"
      identity={identity}
      trigger={small ? SMALL_TRIGGER : undefined}
      fields={[
        ...(tactics
          ? [
              {
                name: "activity_id",
                label: "Tactic",
                type: "select" as const,
                placeholder: "Choose a tactic",
                options: tactics.map((row) => ({ value: row.expansion_id ? `ACT-EXP-${row.expansion_id}` : `ACT-${row.tactic_id}`, label: row.name })),
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
          placeholder: "Choose a type",
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
    const res = await postJson("/api/plan", {
        action: "move_activity",
        id: change.activity.id,
        start_date: start,
        end_date: end,
        rationale: rationale.trim(),
        actor_name: actorName.trim() || identity.actor_name,
        actor_function: identity.actor_function,
      });
    const json = res.json as { error?: string };
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

/**
 * Edits an activity inside the timeline's side panel (owner feedback, KAN-56): the panel
 * that opens on a bar stays put and turns into the form, rather than opening a dialog.
 * Dates, lane and why go to the plan (`move_activity`); name, type, evidence question and
 * budget go to the tactic (`modify_tactic`). Only what changed is sent, with one rationale.
 */
export function ActivitySheetEditor({
  identity,
  activity,
  canEditDetails,
  onDone,
}: {
  identity: ActionIdentity;
  activity: TimelineActivity;
  canEditDetails: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actorName, setActorName] = useState(identity.signed_in ? identity.actor_name : "");
  // The panel leaves edit mode with the refreshed values, not the stale ones for a moment.
  const [refreshing, startRefresh] = useTransition();

  async function post(endpoint: string, body: Record<string, unknown>): Promise<string | null> {
    const res = await postJson(endpoint, {
        ...body,
        actor_name: actorName.trim() || identity.actor_name,
        actor_function: identity.actor_function,
      });
    if (res.ok) return null;
    const json = res.json as { error?: string };
    return json.error ?? "Saving failed";
  }

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "").trim();
    const rationale = value("rationale");
    setError(null);
    if (rationale.length < 3) {
      setError("A short rationale is required. It is stored with the edit.");
      return;
    }
    if (!identity.signed_in && !actorName.trim()) {
      setError("Type your name so the edit has an actor.");
      return;
    }
    const start = value("start_date");
    const end = value("end_date");
    if (start && end && end < start) {
      setError("The end date is before the start date.");
      return;
    }
    const readout = value("readout_date");
    if (readout && start && readout < start) {
      setError("The readout cannot be before the activity starts.");
      return;
    }

    const schedule: Record<string, string> = {};
    if (start && start !== activity.start_date) schedule.start_date = start;
    if (end && end !== activity.end_date) schedule.end_date = end;
    if (value("readout_date") !== (activity.readout_date ?? "")) schedule.readout_date = value("readout_date");
    if (value("lane")) schedule.lane = value("lane");
    if (value("schedule_rationale") !== (activity.meta.schedule_rationale ?? "")) {
      schedule.schedule_rationale = value("schedule_rationale");
    }

    const details: Record<string, string> = {};
    if (canEditDetails) {
      if (!value("name")) return setError("Activity name is required.");
      if (!value("evidence_question")) return setError("Evidence question is required.");
      if (value("name") !== activity.tactic_name) details.name = value("name");
      if (value("type") !== activity.tactic_type) details.type = value("type");
      if (value("evidence_question") !== activity.meta.evidence_question) {
        details.evidence_question = value("evidence_question");
      }
      if (value("budget") !== (activity.meta.budget ?? "")) details.budget = value("budget");
    }

    if (Object.keys(schedule).length === 0 && Object.keys(details).length === 0) {
      setError("Nothing changed.");
      return;
    }
    setPending(true);
    const failed =
      (Object.keys(schedule).length > 0
        ? await post("/api/plan", { action: "move_activity", id: activity.id, ...schedule, rationale })
        : null) ??
      (Object.keys(details).length > 0
        ? await post("/api/iegp", { action: "modify_tactic", tactic_id: activity.tactic_id, ...details, rationale })
        : null);
    setPending(false);
    if (failed) {
      setError(failed);
      return;
    }
    startRefresh(() => {
      router.refresh();
      onDone();
    });
  }

  const label = "grid gap-1 text-[12px] font-medium text-foreground";
  const select =
    "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <form
      aria-label={`Edit ${activity.tactic_name}`}
      data-testid="activity-editor"
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
    >
      {canEditDetails ? (
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-[12px] font-medium text-foreground">Details</legend>
          <label className={label}>
            Activity name
            <Input name="name" defaultValue={activity.tactic_name} required />
          </label>
          <label className={label}>
            Type
            <select name="type" defaultValue={activity.tactic_type} className={select}>
              {TACTIC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TACTIC_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            Budget
            <Input name="budget" defaultValue={activity.meta.budget ?? ""} placeholder="e.g. $120k" maxLength={60} />
          </label>
          <label className={label}>
            Evidence question
            <Textarea name="evidence_question" defaultValue={activity.meta.evidence_question} rows={3} required />
          </label>
        </fieldset>
      ) : null}

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-[12px] font-medium text-foreground">Schedule</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className={label}>
            Start
            <Input type="date" name="start_date" defaultValue={activity.start_date} />
          </label>
          <label className={label}>
            End
            <Input type="date" name="end_date" defaultValue={activity.end_date} />
          </label>
        </div>
        <label className={label}>
          Readout
          <Input type="date" name="readout_date" defaultValue={activity.readout_date ?? ""} />
        </label>
        <label className={label}>
          Lane
          <select name="lane" defaultValue="" className={select}>
            <option value="">Unchanged ({LANE_LABELS[activity.lane]})</option>
            {TIMELINE_LANES.map((lane) => (
              <option key={lane} value={lane}>
                {LANE_LABELS[lane]}
              </option>
            ))}
            {activity.meta.lane_locked ? <option value="band">Follow the validated band again</option> : null}
          </select>
        </label>
        <label className={label}>
          Why these dates (shown on the activity)
          <Textarea name="schedule_rationale" defaultValue={activity.meta.schedule_rationale ?? ""} rows={2} />
        </label>
      </fieldset>

      {!identity.signed_in ? (
        <label className={label}>
          Your name
          <Input value={actorName} onChange={(event) => setActorName(event.target.value)} />
        </label>
      ) : null}
      <label className={label}>
        Rationale for the change
        <Textarea name="rationale" rows={2} placeholder="Stored with the edit" />
      </label>
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || refreshing}>
          {pending || refreshing ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending || refreshing}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
