"use client";

import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { RunStageButton } from "@/components/platform/run-stage-button";
import { useAiEnabled } from "@/components/platform/ai-status";
import { ExportImageButton } from "@/components/timeline/export-image-button";
import { AlertTriangle } from "lucide-react";
import { DependencyDialog } from "@/components/timeline/dependency-dialog";
import { GapGantt, type TimelinePriorityFilter } from "@/components/timeline/gap-gantt";
import { cn } from "@/lib/utils";
import { tacticTypeLabel } from "@/lib/iegp/tactic-type-colors";
import {
  ConflictList,
  DragRescheduleDialog,
  ActivitySheetEditor,
  ManualDatesDialog,
  type DragChange,
} from "@/components/timeline/timeline-dialogs";
import {
  DOMAIN_LABELS,
  FUNCTION_LABELS,
  TACTIC_STATUS_HELPERS,
  type ActorFunction,
  type EvidenceDomain,
  type TacticStatus,
} from "@/lib/iegp/enums";
import {
  LANE_LABELS,
  type ScheduleSource,
  type TimelineActivity,
  type TimelineModel,
} from "@/modules/stages/s10-timeline/build";
import type { GapTimelineView } from "@/modules/stages/s10-timeline/gap-view";
import { plural } from "@/lib/plural";

export type PlanView = {
  version: number;
  status: "draft" | "final";
  note: string | null;
  saved_by: string;
  saved_at: string;
  activities: number;
};

/**
 * What a pending activity still needs. With AI off nothing will estimate it,
 * so the build's "or rebuild to have the model estimate" remedy is replaced.
 */
export function pendingReason(reason: string, ai: boolean): string {
  if (ai) return reason;
  const missing = reason.split(". ")[0]?.trim() ?? "";
  return /^No .+ yet$/.test(missing) ? `${missing}. Date it by hand or remove it.` : "Date it by hand or remove it.";
}

/** S10 lays out dates with or without AI; only the label and copy change. */
export function layoutLabel(ai: boolean, empty: boolean): string {
  if (!ai) return "Lay out dates";
  return empty ? "Rebuild timeline" : "Rebuild from validated state";
}

/**
 * Rebuild / lay out with the plan's start date in view. Model start offsets
 * count from this date; it is prefilled with today and the person can change
 * it before running (KAN-16: nothing is assumed out of sight).
 */
export function AnchoredLayoutButton({ label, identity }: { label: string; identity: ActionIdentity }) {
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        Plan starts
        <input
          type="date"
          value={anchor}
          onChange={(event) => setAnchor(event.target.value)}
          title="Model start estimates count from this date"
          data-testid="timeline-anchor"
          className="h-7 rounded-md border border-input bg-transparent px-1.5 text-[11px] text-foreground"
        />
      </label>
      <RunStageButton
        stage="S10"
        input={anchor ? { persist: true, anchor } : { persist: true }}
        label={label}
        identity={identity}
      />
    </span>
  );
}

/**
 * The saved-final IEGP: the Gantt, one activity's full record on click, and the
 * two actions that make it the truth artifact — save as final, export as an image.
 */
export function TimelineBoard({
  model,
  view,
  today,
  identity,
  plan,
  history,
  canSaveFinal,
  canReschedule,
  canRun = canReschedule,
  canCreate = canReschedule,
  canEditDetails = canCreate,
  gapDomains,
  addable = [],
}: {
  model: TimelineModel;
  /** The gap-grouped view the chart draws (KAN-25). */
  view: GapTimelineView;
  today: string;
  identity: ActionIdentity;
  plan: PlanView | null;
  history: PlanView[];
  canSaveFinal: boolean;
  /** Dates, dependencies and removals may be edited; false for a viewer. */
  canReschedule: boolean;
  /** May run S10 (lay out or rebuild). */
  canRun?: boolean;
  /** May create a new activity under a gap. */
  canCreate?: boolean;
  /** May edit the tactic behind an activity. */
  canEditDetails?: boolean;
  gapDomains: Record<string, string>;
  /** Tactics not on the timeline in any form, which a user can add by hand. */
  addable?: { tactic_id: string; name: string }[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const ai = useAiEnabled();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Read from the live model, so an edit shows as soon as the page refreshes.
  const selected = selectedId ? (model.activities.find((row) => row.id === selectedId) ?? null) : null;
  // Editing happens inside the side panel (KAN-56); choosing another bar leaves edit mode.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = selected !== null && editingId === selected.id;
  const setSelected = (activity: TimelineActivity | null) => setSelectedId(activity?.id ?? null);
  const nameOf = new Map(model.activities.map((row) => [row.id, row.tactic_name]));
  const stale = plan ? plan.activities !== model.activities.length : false;
  const [dragChange, setDragChange] = useState<DragChange | null>(null);
  const selectedConflicts = selected
    ? view.conflicts.filter((row) => row.successor_id === selected.id || row.predecessor_id === selected.id)
    : [];
  const [priorityFilter, setPriorityFilter] = useState<TimelinePriorityFilter>("all");
  const [setting, setSetting] = useState<string | null>(null);
  const [showDependencies, setShowDependencies] = useState(true);
  const settingTags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const group of [...view.prioritized, ...view.not_prioritized, ...view.deferred]) {
      for (const tag of group.settings) {
        const key = tag.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, tag.trim());
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [view]);
  const hasRows = view.prioritized.length + view.not_prioritized.length + view.deferred.length + view.other.length > 0;

  return (
    <div className="grid gap-4">
      <section className="flex flex-wrap items-start justify-between gap-3 border border-border bg-card p-3 rounded-lg">
        <div className="min-w-0">
          <p className="text-[12px] text-foreground">
            {plan ? (
              <>
                Saved v{plan.version} · <span className="uppercase">{plan.status}</span> by {plan.saved_by} ·{" "}
                {plan.saved_at.slice(0, 16).replace("T", " ")}
              </>
            ) : (
              "Not saved yet. Save the plan as final when the bands, tactics and dates are the ones you stand behind."
            )}
          </p>
          {plan?.note ? <p className="mt-1 text-[11px] text-muted-foreground">“{plan.note}”</p> : null}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {plural(model.activities.length, "activity", "activities")} · {model.window.start} → {model.window.end} ·{" "}
            {plural(model.window.months, "month")}
            {stale ? " · the live plan has changed since the last save" : ""}
          </p>
          {history.length > 1 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              History: {history.map((entry) => `v${entry.version} ${entry.status}`).join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRun ? (
            <AnchoredLayoutButton label={layoutLabel(ai, false)} identity={identity} />
          ) : null}
          {canReschedule && addable.length > 0 ? (
            <ManualDatesDialog
              identity={identity}
              tactics={addable}
              label="Add activity"
              title="Add an activity by hand"
            />
          ) : null}
          <ExportImageButton
            svgRef={svgRef}
            fileName={`synapse-iegp-v${plan?.version ?? "draft"}.png`}
            disabledReason={model.activities.length === 0 ? "Nothing to export yet." : undefined}
          />
          {canSaveFinal && model.pending.length > 0 ? (
            <p className="max-w-56 text-[11px] text-muted-foreground">
              {plural(model.pending.length, "activity", "activities")} not dated yet.{" "}
              {ai
                ? "Date them by hand or rebuild before saving as final."
                : "Date them by hand or remove them before saving as final."}
            </p>
          ) : null}
          {canSaveFinal ? (
            <ActionDialog
              endpoint="/api/plan"
              payload={{ action: "save_plan" }}
              label="Save as final"
              title="Save this IEGP as final"
              description="Freezes a versioned snapshot of every activity, lane and dependency as it stands now."
              confirmLabel="Save"
              rationaleLabel="What is being signed off (required)"
              identity={identity}
              variant="default"
              fields={[
                {
                  name: "status",
                  label: "Status",
                  type: "select",
                  defaultValue: "final",
                  options: [
                    { value: "final", label: "Final — the plan I stand behind" },
                    { value: "draft", label: "Draft snapshot" },
                  ],
                },
              ]}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {canReschedule
                ? "Your role may export but not save the plan as final."
                : "Read-only: your role may view and export the timeline, not edit it."}
            </p>
          )}
        </div>
      </section>

      {view.conflicts.length > 0 ? (
        <section role="alert" className="grid gap-1 border border-destructive/50 bg-destructive/10 p-3">
          <h2 className="flex items-center gap-1 text-[12px] font-semibold text-destructive">
            <AlertTriangle className="size-4" /> {view.conflicts.length} broken dependenc
            {view.conflicts.length === 1 ? "y" : "ies"}
          </h2>
          <ConflictList conflicts={view.conflicts} />
          <p className="text-[11px] text-muted-foreground">
            A successor starts before the activity it waits on ends. Nothing is shifted automatically: move a bar or
            edit its dependencies.
          </p>
        </section>
      ) : null}

      {!hasRows ? (
        <EmptyTimeline identity={identity} unscheduled={model.unscheduled} ai={ai} canRun={canRun} />
      ) : (
        <>
        <div
          role="toolbar"
          aria-label="Timeline filters"
          className="-mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5"
        >
          <button
            type="button"
            aria-pressed={showDependencies}
            onClick={() => setShowDependencies((on) => !on)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[11px] font-medium",
              showDependencies
                ? "border-primary/40 bg-primary/10 text-indigo-800 dark:text-indigo-300"
                : "border-border bg-background text-muted-foreground",
            )}
          >
            ⤳ Dependencies
          </button>
          <span className="h-5 w-px bg-border" aria-hidden />
          <div role="group" aria-label="Priority" className="flex flex-wrap items-center gap-1">
            {(
              [
                { id: "all", label: "All gaps" },
                { id: "high", label: "High priority" },
                { id: "high_medium", label: "High + Medium" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={priorityFilter === option.id}
                onClick={() => setPriorityFilter(option.id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[11px] font-medium",
                  priorityFilter === option.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {settingTags.length > 0 ? (
            <>
              <span className="h-5 w-px bg-border" aria-hidden />
              <div role="group" aria-label="Setting" className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Setting</span>
                {[null, ...settingTags].map((tag) => (
                  <button
                    key={tag ?? "all"}
                    type="button"
                    aria-pressed={setting === tag}
                    onClick={() => setSetting(tag === setting ? null : tag)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] font-medium",
                      setting === tag
                        ? tag === null
                          ? "border-foreground bg-foreground text-background"
                          : "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tag ?? "All"}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div className="overflow-x-auto border border-border bg-background">
          <GapGantt
            filter={priorityFilter}
            setting={setting}
            showDependencies={showDependencies}
            view={view}
            activities={model.activities}
            today={today}
            selectedId={selected?.id ?? null}
            onSelect={(id) => setSelectedId(id)}
            svgRef={svgRef}
            editable={canReschedule}
            canCreate={canCreate}
            identity={identity}
            onDragCommit={setDragChange}
          />
        </div>
        </>
      )}
      {canReschedule && hasRows ? (
        <p className="-mt-2 text-[11px] text-muted-foreground">
          Drag a bar to move it, or drag either end to change its start or end. From the keyboard, focus a bar and
          press Enter to open it, then use Edit.
        </p>
      ) : null}

      {dragChange ? (
        <DragRescheduleDialog
          key={`${dragChange.activity.id}:${dragChange.start_date}:${dragChange.end_date}`}
          change={dragChange}
          activities={model.activities}
          identity={identity}
          onClose={() => setDragChange(null)}
        />
      ) : null}

      {model.removed.length > 0 ? (
        <section className="border border-border bg-card p-3 rounded-lg">
          <h2 className="text-[12px] font-semibold text-foreground">Removed by hand</h2>
          <ul className="mt-2 grid gap-2">
            {model.removed.map((row) => (
              <li key={row.activity_id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-[11px] text-muted-foreground">
                  <span className="text-foreground">{row.tactic_name}</span> — “{row.reason}”
                </span>
                {canReschedule ? (
                  <ManualDatesDialog
                    identity={identity}
                    tacticId={row.tactic_id}
                    expansionId={row.expansion_id}
                    label="Add back"
                    title={`Add ${row.tactic_name} back to the timeline`}
                    hint="Leave the dates empty to keep the ones it had, if it had any."
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Sheet open={selected !== null} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle className="text-[15px]">{selected.tactic_name}</SheetTitle>
                <SheetDescription className="text-[12px]">
                  {tacticTypeLabel({ type: selected.tactic_type, custom_type: selected.tactic_custom_type })} ·{" "}
                  {selected.tactic_status.replaceAll("_", " ")}
                  {selected.expansion_id ? ` · Expansion of ${selected.parent_tactic_name}` : ""}
                </SheetDescription>
              </SheetHeader>
              {editing ? (
                <div className="px-4 pb-6">
                  <ActivitySheetEditor
                    identity={identity}
                    activity={selected}
                    canEditDetails={canEditDetails && !selected.expansion_id}
                    onDone={() => setEditingId(null)}
                  />
                </div>
              ) : (
              <div className="grid gap-4 px-4 pb-6">
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className="text-[10px]">
                    {selected.band === "addressed"
                      ? "Addressed evidence"
                      : selected.band === "unprioritized"
                        ? "not yet prioritized"
                        : `${selected.band} priority`}
                  </Badge>
                  {selected.meta.counts_toward_addressing ? (
                    <Badge variant="secondary" className="text-[10px]">
                      counts toward addressing
                    </Badge>
                  ) : selected.expansion_id ? <span className="text-xs text-muted-foreground">Not counting toward addressing</span> : null}
                </div>
                {selected.expansion_id && selected.expansion_version && canEditDetails ? <ActionDialog endpoint="/api/plan" payload={{action: "set_expansion_status", expansion_id: selected.expansion_id, expected_version: selected.expansion_version}} label="Change expansion status" title={`Status for ${selected.tactic_name}`} description="Change only this expansion. Coverage still needs its own review." confirmLabel="Save status" identity={identity} fields={[{name: "status", label: "Status", type: "select", defaultValue: selected.tactic_status, options: ["proposed", "planned", "ongoing", "completed", "cancelled"].map(value => ({value, label: value}))}]} /> : null}

                <section>
                  <h3 className="text-[12px] font-medium text-foreground">Evidence gaps it answers</h3>
                  <ul className="mt-1 grid gap-1">
                    {selected.gap_ids.map((gapId, index) => (
                      <li key={gapId} className="text-[12px] text-muted-foreground">
                        <span className="text-foreground">{selected.gap_names[index] ?? gapId}</span>
                        {gapDomains[gapId]
                          ? ` · ${DOMAIN_LABELS[gapDomains[gapId] as EvidenceDomain] ?? gapDomains[gapId]}`
                          : ""}{" "}
                        <span className="text-muted-foreground/70">{gapId}</span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section>
                  <h3 className="text-[12px] font-medium text-foreground">Timing</h3>
                  <dl className="mt-1 grid gap-1 text-[12px] text-muted-foreground">
                    <Row label="Start" value={`${selected.start_date} · ${BASIS_LABELS[selected.meta.schedule_basis.start]}`} />
                    <Row label="End" value={`${selected.end_date} · ${BASIS_LABELS[selected.meta.schedule_basis.end]}`} />
                    <Row
                      label="Readout"
                      value={
                        selected.readout_date
                          ? `${selected.readout_date} · ${BASIS_LABELS[selected.meta.schedule_basis.readout ?? "saved"]}`
                          : "—"
                      }
                    />
                    <Row
                      label="Lane"
                      value={`${LANE_LABELS[selected.lane]} · ${selected.meta.lane_locked ? "set by hand" : "follows the validated band"}`}
                    />
                    <Row
                      label="Depends on"
                      value={`${
                        selected.depends_on.length > 0
                          ? selected.depends_on.map((id) => nameOf.get(id) ?? id).join(", ")
                          : "nothing"
                      } · ${selected.meta.depends_locked ? "set by hand" : "model"}`}
                    />
                    {selected.meta.manual ? <Row label="Added" value="by hand" /> : null}
                  </dl>
                  {selectedConflicts.length > 0 ? (
                    <div role="alert" className="mt-2 grid gap-1 border border-destructive/50 bg-destructive/10 p-2">
                      <p className="flex items-center gap-1 text-[11px] font-medium text-destructive">
                        <AlertTriangle className="size-3.5" /> Broken dependency
                      </p>
                      <ConflictList conflicts={selectedConflicts} />
                    </div>
                  ) : null}
                  {selected.meta.dependency_note ? (
                    <p className="mt-1 text-[11px] text-[var(--opportunity)]">{selected.meta.dependency_note}</p>
                  ) : null}
                  {selected.meta.schedule_rationale ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Why these dates ({selected.meta.rationale_locked ? "written by hand" : "model or design"}):{" "}
                      {selected.meta.schedule_rationale}
                    </p>
                  ) : null}
                </section>

                <section>
                  <h3 className="text-[12px] font-medium text-foreground">Design</h3>
                  <dl className="mt-1 grid gap-1 text-[12px] text-muted-foreground">
                    <Row label="Evidence question" value={selected.meta.evidence_question} />
                    <Row label="Population" value={selected.meta.population} />
                    {selected.expansion_scope ? <>
                      <Row label="Analysis" value={selected.expansion_scope.analysis} />
                      <Row label="Data cut" value={selected.expansion_scope.data_cut} />
                      <Row label="Geography" value={selected.expansion_scope.geography} />
                      <Row label="Feasibility risks" value={selected.expansion_scope.feasibility_risks} />
                    </> : null}
                    <Row label="Comparator" value={selected.meta.comparator} />
                    <Row label="Outcomes" value={selected.meta.outcomes} />
                    <Row label="Data source" value={selected.meta.data_source} />
                    <Row label="Design" value={selected.meta.study_design} />
                    <Row label="Budget" value={selected.meta.budget || "—"} />
                    <Row label="Owner" value={`${selected.meta.owner} · ${FUNCTION_LABELS[selected.meta.function as ActorFunction] ?? selected.meta.function}`} />
                  </dl>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {TACTIC_STATUS_HELPERS[selected.tactic_status as TacticStatus]}
                  </p>
                </section>

                {selected.meta.priority_rationale ? (
                  <section>
                    <h3 className="text-[12px] font-medium text-foreground">Why this priority</h3>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      “{selected.meta.priority_rationale}”
                    </p>
                  </section>
                ) : null}

                {canReschedule ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setEditingId(selected.id)}>
                      Edit
                    </Button>
                    <DependencyDialog activity={selected} activities={model.activities} identity={identity} />
                    <ActionDialog
                      endpoint="/api/plan"
                      payload={{ action: "remove_activity", id: selected.id }}
                      label="Remove from timeline"
                      title={`Remove ${selected.tactic_name} from the timeline`}
                      description="It stays off on every rebuild until someone adds it back. The tactic itself is not changed."
                      confirmLabel="Remove"
                      identity={identity}
                    />
                  </div>
                ) : null}
              </div>
              )}
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

const BASIS_LABELS: Record<ScheduleSource, string> = {
  human: "set by hand",
  saved: "saved",
  tactic: "from the tactic",
  design: "from the study design",
  model: "model estimate",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground/80">{label}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </div>
  );
}

function EmptyTimeline({
  identity,
  unscheduled,
  ai,
  canRun,
}: {
  identity: ActionIdentity;
  unscheduled: TimelineModel["unscheduled"];
  ai: boolean;
  canRun: boolean;
}) {
  return (
    <section className="border border-border bg-card p-4 rounded-lg">
      <h2 className="text-[12px] font-semibold text-foreground">No activities to plot yet</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {ai
          ? "The timeline is built from validated state: gaps mapped to tactics, with priority bands. Upload sources on Upload, confirm the gaps and their tactics on Gaps, validate their bands on Prioritize, then build the timeline here."
          : "The timeline is built from validated state: gaps mapped to tactics, with validated priority bands. Add gaps and tactics by hand, map them on Gaps, validate their bands on Prioritize, then lay out dates here or add an activity by hand."}
      </p>
      {unscheduled.length > 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {unscheduled.length === 1 ? "1 open gap has" : `${unscheduled.length} open gaps have`} no tactic yet, so there is nothing to schedule for{" "}
          {unscheduled.length === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {canRun ? (
        <div className="mt-3">
          <AnchoredLayoutButton label={layoutLabel(ai, true)} identity={identity} />
        </div>
      ) : null}
    </section>
  );
}
