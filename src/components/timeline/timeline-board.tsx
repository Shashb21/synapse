"use client";

import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { RunStageButton } from "@/components/platform/run-stage-button";
import { ExportImageButton } from "@/components/timeline/export-image-button";
import { DependencyDialog } from "@/components/timeline/dependency-dialog";
import { GanttChart } from "@/components/timeline/gantt-chart";
import {
  DOMAIN_LABELS,
  FUNCTION_LABELS,
  TACTIC_STATUS_HELPERS,
  TACTIC_TYPE_LABELS,
  type ActorFunction,
  type EvidenceDomain,
  type TacticStatus,
  type TacticType,
} from "@/lib/iegp/enums";
import {
  LANE_LABELS,
  TIMELINE_LANES,
  type ScheduleSource,
  type TimelineActivity,
  type TimelineModel,
} from "@/modules/stages/s10-timeline/build";

export type PlanView = {
  version: number;
  status: "draft" | "final";
  note: string | null;
  saved_by: string;
  saved_at: string;
  activities: number;
};

/**
 * The saved-final IEGP: the Gantt, one activity's full record on click, and the
 * two actions that make it the truth artifact — save as final, export as an image.
 */
export function TimelineBoard({
  model,
  today,
  identity,
  plan,
  history,
  canSaveFinal,
  canReschedule,
  gapDomains,
  addable = [],
}: {
  model: TimelineModel;
  today: string;
  identity: ActionIdentity;
  plan: PlanView | null;
  history: PlanView[];
  canSaveFinal: boolean;
  canReschedule: boolean;
  gapDomains: Record<string, string>;
  /** Tactics not on the timeline in any form, which a user can add by hand. */
  addable?: { tactic_id: string; name: string }[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Read from the live model, so an edit shows as soon as the page refreshes.
  const selected = selectedId ? (model.activities.find((row) => row.id === selectedId) ?? null) : null;
  const setSelected = (activity: TimelineActivity | null) => setSelectedId(activity?.id ?? null);
  const nameOf = new Map(model.activities.map((row) => [row.id, row.tactic_name]));
  const stale = plan ? plan.activities !== model.activities.length : false;

  return (
    <div className="grid gap-4">
      <section className="flex flex-wrap items-start justify-between gap-3 border border-border bg-card/40 p-3">
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
            {model.activities.length} activity(ies) · {model.window.start} → {model.window.end} ·{" "}
            {model.window.months} month(s)
            {stale ? " · the live plan has changed since the last save" : ""}
          </p>
          {history.length > 1 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              History: {history.map((entry) => `v${entry.version} ${entry.status}`).join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunStageButton
            stage="S10"
            input={{ persist: true }}
            label="Rebuild from validated state"
            identity={identity}
          />
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
              Your role may export but not save the plan as final.
            </p>
          )}
        </div>
      </section>

      {model.activities.length === 0 ? (
        <EmptyTimeline identity={identity} unscheduled={model.unscheduled} />
      ) : (
        <div className="overflow-x-auto border border-border bg-background">
          <GanttChart
            model={model}
            today={today}
            selectedId={selected?.id ?? null}
            onSelect={(activity) => setSelected(activity)}
            svgRef={svgRef}
          />
        </div>
      )}

      {model.pending.length > 0 ? (
        <section className="border border-[var(--unknown)]/40 bg-card/40 p-3">
          <h2 className="text-[13px] font-medium text-foreground">Not dated yet</h2>
          <ul className="mt-2 grid gap-2">
            {model.pending.map((row) => (
              <li key={row.activity_id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-[11px] text-muted-foreground">
                  <span className="text-foreground">{row.tactic_name}</span> — {row.reason}
                </span>
                {canReschedule ? (
                  <span className="flex flex-wrap gap-2">
                    <ManualDatesDialog
                      identity={identity}
                      tacticId={row.tactic_id}
                      label="Date by hand"
                      title={`Date ${row.tactic_name} by hand`}
                    />
                    <ActionDialog
                      endpoint="/api/plan"
                      payload={{ action: "remove_activity", id: row.activity_id }}
                      label="Remove"
                      title={`Remove ${row.tactic_name} from the timeline`}
                      description="It stays off on every rebuild until someone adds it back. The tactic itself is not changed."
                      confirmLabel="Remove"
                      identity={identity}
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {model.removed.length > 0 ? (
        <section className="border border-border bg-card/40 p-3">
          <h2 className="text-[13px] font-medium text-foreground">Removed by hand</h2>
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

      {model.unscheduled.length > 0 && model.activities.length > 0 ? (
        <section className="border border-[var(--unknown)]/40 bg-card/40 p-3">
          <h2 className="text-[13px] font-medium text-foreground">Not on the timeline yet</h2>
          <ul className="mt-2 grid gap-1">
            {model.unscheduled.map((row) => (
              <li key={row.gap_id} className="text-[11px] text-muted-foreground">
                <span className="text-foreground">{row.gap_name}</span> — {row.reason}
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
                  {TACTIC_TYPE_LABELS[selected.tactic_type as TacticType]} ·{" "}
                  {selected.tactic_status.replaceAll("_", " ")}
                </SheetDescription>
              </SheetHeader>
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
                  ) : null}
                </div>

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
                    <Row label="Comparator" value={selected.meta.comparator} />
                    <Row label="Outcomes" value={selected.meta.outcomes} />
                    <Row label="Data source" value={selected.meta.data_source} />
                    <Row label="Design" value={selected.meta.study_design} />
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
                    <ActionDialog
                      endpoint="/api/plan"
                      payload={{ action: "move_activity", id: selected.id }}
                      label="Reschedule"
                      title={`Reschedule ${selected.tactic_name}`}
                      description="Your dates, lane and rationale are marked as yours and survive every rebuild. The change is recorded with its rationale."
                      confirmLabel="Move"
                      identity={identity}
                      fields={[
                        { name: "start_date", label: "Start", type: "date", defaultValue: selected.start_date },
                        { name: "end_date", label: "End", type: "date", defaultValue: selected.end_date },
                        {
                          name: "readout_date",
                          label: "Readout",
                          type: "date",
                          defaultValue: selected.readout_date ?? "",
                        },
                        {
                          name: "lane",
                          label: "Lane",
                          type: "select",
                          defaultValue: "",
                          options: [
                            { value: "", label: `Unchanged (${LANE_LABELS[selected.lane]})` },
                            ...TIMELINE_LANES.map((lane) => ({ value: lane, label: LANE_LABELS[lane] })),
                            ...(selected.meta.lane_locked
                              ? [{ value: "band", label: "Follow the validated band again" }]
                              : []),
                          ],
                        },
                        {
                          name: "schedule_rationale",
                          label: "Why these dates (shown on the activity)",
                          type: "textarea",
                          defaultValue: selected.meta.schedule_rationale ?? "",
                        },
                      ]}
                    />
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

/** Dates an activity by hand, with no model: start, end, readout, and optionally a lane and rationale. */
function ManualDatesDialog({
  identity,
  tacticId,
  label,
  title,
  hint,
  tactics,
}: {
  identity: ActionIdentity;
  /** Fixed tactic; omit and pass `tactics` to let the user choose one. */
  tacticId?: string;
  label: string;
  title: string;
  hint?: string;
  tactics?: { tactic_id: string; name: string }[];
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
        { name: "start_date", label: "Start", type: "date", hint },
        { name: "end_date", label: "End", type: "date" },
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
}: {
  identity: ActionIdentity;
  unscheduled: TimelineModel["unscheduled"];
}) {
  return (
    <section className="border border-border bg-card/40 p-4">
      <h2 className="text-[13px] font-medium text-foreground">No activities to plot yet</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        The timeline is built from validated state: gaps mapped to tactics, with priority bands. Run the
        chain on the Pipeline page — upload and parse, extract gaps and tactics, map them, then
        prioritize — and rebuild here.
      </p>
      {unscheduled.length > 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {unscheduled.length} open gap(s) have no tactic yet, so there is nothing to schedule for them.
        </p>
      ) : null}
      <div className="mt-3">
        <RunStageButton stage="S10" input={{ persist: true }} label="Rebuild timeline" identity={identity} />
      </div>
    </section>
  );
}
