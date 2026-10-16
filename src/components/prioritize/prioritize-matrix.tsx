"use client";

import { SuggestionReferences } from "./suggestion-references";
import type { JudgementReference } from "@/lib/iegp/judgement-references";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Loader2 } from "lucide-react";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { usePageRefresh } from "@/components/platform/use-page-refresh";
import { EvidenceDecisionContext, PriorityJudgementDetails, priorityNextAction, type PriorityObjective } from "@/components/prioritize/priority-context";
import { SettingChips } from "@/components/gap-settings-editor";
import { placementGapError, scoreError } from "@/components/prioritize/score-input";
import { BandChip, BAND_LABELS, BAND_TOKENS, BANDS, QUADRANT_NAMES, type Band } from "@/components/matrix/bands";
import { cn } from "@/lib/utils";
import { useAiEnabled } from "@/components/platform/ai-status";
import {
  favourability,
  favourableLabel,
  quadrantBand,
  scoreFromFavourability,
  unfavourableLabel,
  type PriorityAxis,
} from "@/modules/stages/s8-prioritization/axis-math";
import { postJson } from "@/lib/post-json";
import { isPresenting } from "@/lib/room/presenting";

export type PrioritizeGap = {
  gap_id: string;
  run_id?: string | null;
  version?: string | null;
  context_version?: string | null;
  gap_name: string;
  statement: string;
  objective?: PriorityObjective | null;
  domain_label: string;
  settings: string[];
  tactic_count: number;
  /** Raw axis scores keyed by axis id; missing until S8 places the gap. */
  axis_scores: Record<string, number> | null;
  band: Band | null;
  validated: boolean;
  needs_review?: boolean;
  review_reason?: string | null;
  suggested_band: Band | null;
  suggested_rationale: string | null;
  suggested_references?: JudgementReference[];
  support_status?: "supported" | "unsupported";
  /** Axis ids a person set; a model re-run keeps their scores. */
  human_axes?: string[];
  /** The band is a person's; a model re-run keeps it. */
  human_band?: boolean;
  rationale: string | null;
  actor_name: string | null;
  at: string | null;
};

type Point = { x: number; y: number };

/** Favourable-scale point (100 = priority end) → CSS offsets: the priority corner is top-right, as in the design. */
function toOffsets(point: Point) {
  return { left: point.x, top: 100 - point.y };
}

function pointOf(gap: PrioritizeGap, xAxis: PriorityAxis, yAxis: PriorityAxis): Point | null {
  const x = gap.axis_scores?.[xAxis.id];
  const y = gap.axis_scores?.[yAxis.id];
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x: favourability(xAxis, x), y: favourability(yAxis, y) };
}

function bandAt(point: Point, xAxis: PriorityAxis, yAxis: PriorityAxis): Band {
  return quadrantBand({
    xAxis,
    yAxis,
    scores: {
      [xAxis.id]: scoreFromFavourability(xAxis, point.x),
      [yAxis.id]: scoreFromFavourability(yAxis, point.y),
    },
  });
}

async function runPrioritization(args: {
  identity: ActionIdentity;
  gapIds: string[];
  xAxis: string;
  yAxis: string;
  setting: string;
  onlyMissing: boolean;
}): Promise<{ ok: boolean; error?: string; summary?: string; mode?: string }> {
  const res = await postJson("/api/modules", {
      stage: "S8",
      input: {
        gap_ids: args.gapIds,
        x_axis: args.xAxis,
        y_axis: args.yAxis,
        setting: args.setting === "all" ? undefined : args.setting,
        only_missing: args.onlyMissing,
      },
      actor_name: args.identity.actor_name,
      actor_function: args.identity.actor_function,
    });
  const json = res.json as { error?: string; summary?: string; mode?: string };
  return res.ok ? { ok: true, summary: json.summary, mode: json.mode } : { ok: false, error: json.error ?? "Prioritization failed" };
}

async function saveAxes(scope: string, xAxis: string, yAxis: string): Promise<string | null> {
  const res = await postJson("/api/plan", { action: "save_scope_axes", scope, x_axis: xAxis, y_axis: yAxis });
  if (res.ok) return null;
  const json = res.json as { error?: string };
  return json.error ?? "Could not save the axes.";
}

function AxisSelect({
  label,
  value,
  onChange,
  axes,
  exclude,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  axes: PriorityAxis[];
  exclude: string;
}) {
  const selected = axes.find((axis) => axis.id === value);
  return (
    <label className="grid gap-1 text-[12px] text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
      >
        <option value="" disabled>
          Choose an axis
        </option>
        {axes.map((axis) => (
          <option key={axis.id} value={axis.id} disabled={axis.id === exclude}>
            {axis.label}
          </option>
        ))}
      </select>
      {selected ? <span className="text-[11px] leading-4">{selected.description}</span> : null}
    </label>
  );
}

/**
 * Picks the two matrix axes for a scope, saves them, and asks S8 for a first
 * placement of every Open gap in the scope.
 */
export function AxisChooser({
  scope,
  scopeLabel,
  axes,
  initialX = "",
  initialY = "",
  gapIds,
  identity,
  mayPrioritize,
  submitLabel,
  onCancel,
}: {
  scope: string;
  scopeLabel: string;
  axes: PriorityAxis[];
  initialX?: string;
  initialY?: string;
  gapIds: string[];
  identity: ActionIdentity;
  mayPrioritize: boolean;
  submitLabel: string;
  onCancel?: () => void;
}) {
  const { refresh } = usePageRefresh();
  const ai = useAiEnabled("prioritization");
  const [xAxis, setXAxis] = useState(initialX);
  const [yAxis, setYAxis] = useState(initialY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!xAxis || !yAxis) {
      setError("Choose both axes.");
      return;
    }
    setPending(true);
    setError(null);
    const saveError = await saveAxes(scope, xAxis, yAxis);
    if (saveError) {
      setPending(false);
      setError(saveError);
      return;
    }
    // With AI off the axes are saved and every gap is placed by hand.
    if (ai && gapIds.length > 0) {
      const result = await runPrioritization({
        identity,
        gapIds,
        xAxis,
        yAxis,
        setting: scope,
        onlyMissing: true,
      });
      if (!result.ok) {
        setPending(false);
        setError(result.error ?? "Prioritization failed");
        refresh();
        return;
      }
    }
    // The chooser gives way to the matrix once the placements have arrived.
    refresh(() => {
      setPending(false);
      onCancel?.();
    });
  }

  const x = axes.find((axis) => axis.id === xAxis);
  const y = axes.find((axis) => axis.id === yAxis);

  return (
    <section className="grid gap-4 border border-border bg-card/40 p-4" aria-labelledby="axis-chooser">
      <div>
        <h2 id="axis-chooser" className="text-[15px] font-medium text-foreground">
          How should {scopeLabel} be prioritized?
        </h2>
        <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">
          {ai
            ? "Pick the two axes for the matrix. The model places each Open gap as a first draft; you then drag gaps to change their priority and validate each one."
            : "Pick the two axes for the matrix. You place each Open gap yourself: type its scores or band, or drop it on the matrix, then validate it."}{" "}
          Top-right is Prioritize (High), top-left Plan (Medium), bottom-right Monitor (Low) and bottom-left Defer. The quadrant only suggests a priority: you confirm it with a rationale.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <AxisSelect label="Vertical axis (Y)" value={yAxis} onChange={setYAxis} axes={axes} exclude={xAxis} />
        <AxisSelect label="Horizontal axis (X)" value={xAxis} onChange={setXAxis} axes={axes} exclude={yAxis} />
      </div>
      {x && y ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          Prioritize = <span className="text-foreground">{favourableLabel(y)}</span> and{" "}
          <span className="text-foreground">{favourableLabel(x)}</span>. Defer ={" "}
          {unfavourableLabel(y)} and {unfavourableLabel(x)}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || !mayPrioritize}
          onClick={() => void submit()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {pending ? (ai ? "Placing gaps…" : "Saving axes…") : ai ? submitLabel : "Save axes"}
        </button>
        {onCancel ? (
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-[13px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        ) : null}
        {!mayPrioritize ? (
          <span className="text-[11px] text-muted-foreground">Your role may not prioritize.</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {gapIds.length} Open gap{gapIds.length === 1 ? "" : "s"} in {scopeLabel}
          </span>
        )}
      </div>
    </section>
  );
}

function QuadrantBackdrop() {
  const cells: { band: Band; className: string }[] = [
    { band: "medium", className: "left-0 top-0" },
    { band: "high", className: "right-0 top-0" },
    { band: "defer", className: "left-0 bottom-0" },
    { band: "low", className: "right-0 bottom-0" },
  ];
  return (
    <>
      {cells.map((cell) => (
        <div
          key={cell.className}
          aria-hidden
          className={cn("pointer-events-none absolute h-1/2 w-1/2", cell.className)}
          style={{
            backgroundColor: `color-mix(in oklab, ${BAND_TOKENS[cell.band]} ${cell.band === "high" ? 11 : 6}%, transparent)`,
          }}
        >
          <span
            className={cn(
              "absolute text-[10px] font-medium uppercase tracking-wide",
              cell.className.includes("top") ? "top-1.5" : "bottom-1.5",
              cell.className.includes("left") ? "left-2" : "right-2",
            )}
            style={{ color: BAND_TOKENS[cell.band] }}
          >
            {QUADRANT_NAMES[cell.band]}
          </span>
        </div>
      ))}
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-dashed border-border" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
    </>
  );
}

function GapDetail({
  gap,
  xAxis,
  yAxis,
  identity,
  mayPrioritize,
  tacticsUnlocked,
}: {
  gap: PrioritizeGap;
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  identity: ActionIdentity;
  mayPrioritize: boolean;
  tacticsUnlocked: boolean;
}) {
  const ai = useAiEnabled("prioritization");
  const point = pointOf(gap, xAxis, yAxis);
  const band = gap.band ?? gap.suggested_band;
  const quadrant = point ? bandAt(point, xAxis, yAxis) : null;
  return (
    <article className="grid gap-3 border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {band ? <BandChip band={band} validated={gap.validated} /> : null}
        <Link href={`/gaps/${gap.gap_id}`} className="text-[11px] text-muted-foreground no-underline hover:underline">
          Gap dossier ↗
        </Link>
      </div>
      <h3 className="text-[14px] font-medium leading-5 text-foreground">{gap.gap_name}</h3>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>{gap.domain_label}</span>
        <span>·</span>
        <span>
          {gap.tactic_count} tactic{gap.tactic_count === 1 ? "" : "s"}
        </span>
        <SettingChips settings={gap.settings} />
      </div>
      <EvidenceDecisionContext statement={gap.statement} objective={gap.objective} />
      <PriorityJudgementDetails priority={{ ...gap, band }} axes={[yAxis, xAxis]} />
      {ai && gap.suggested_band && (gap.run_id || gap.suggested_rationale) ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          <span className="text-foreground">Model suggested {BAND_LABELS[gap.suggested_band]}.</span>{" "}
          {gap.suggested_rationale || "Reason not recorded"}
        </p>
      ) : null}
      {ai && gap.suggested_band && (gap.run_id || gap.suggested_rationale) ? <SuggestionReferences key={`${gap.gap_id}-${gap.version}`} gapId={gap.gap_id} version={gap.version ?? null} references={gap.support_status === "supported" ? gap.suggested_references : []} /> : null}
      {ai && band && mayPrioritize && !gap.validated && !gap.needs_review && !gap.human_band && !gap.human_axes?.length && gap.support_status === "supported" ? (
        <ActionDialog endpoint="/api/plan"
          payload={{ action: "accept_priority_suggestion", gap_id: gap.gap_id, band: gap.suggested_band, expected_version: gap.version ?? null }}
          label="Accept supported AI suggestion" title={`Accept AI priority for ${gap.gap_name}`}
          description="Inspect the supporting records before accepting this suggestion. Your reason and its references will be retained in history."
          confirmLabel="Accept supported AI suggestion" requireRationale rationaleFieldName="reason" rationaleLabel="Reason for acceptance (required)" identity={identity} />
      ) : null}
      {quadrant && band && quadrant !== band ? (
        <p className="text-[11px] leading-4 text-amber-700 dark:text-amber-300">
          Its band ({BAND_LABELS[band]}) differs from the quadrant it sits in here ({BAND_LABELS[quadrant]}). Drag
          it, or edit its scores or band, to match.
        </p>
      ) : null}
      {gap.validated ? (
        <div className="grid gap-1 text-[12px]">
          {band === "high" && tacticsUnlocked ? (
            <Link href="/?place=tactics">Continue to tactics</Link>
          ) : !tacticsUnlocked ? (
            <Link href="/?place=plan&setting=all">Review remaining plan-wide priorities</Link>
          ) : (
            <Link href={`/gaps/${gap.gap_id}`}>Map a tactic from the library</Link>
          )}
        </div>
      ) : null}
      {mayPrioritize ? (
        <ActionDialog
          endpoint="/api/plan"
          payload={{ action: "set_placement", gap_id: gap.gap_id, x_axis: xAxis.id, y_axis: yAxis.id, expected_version: gap.version ?? null, expected_context_version: gap.context_version ?? null }}
          fields={[
            { name: "rationale", label: "Priority rationale (optional)", type: "textarea", defaultValue: gap.rationale ?? "", hint: "Why this priority is appropriate. Kept separately from the reason for this change." },
            {
              name: "y_score",
              label: `${yAxis.label} score (0–100)`,
              defaultValue:
                typeof gap.axis_scores?.[yAxis.id] === "number" ? String(gap.axis_scores[yAxis.id]) : "",
              placeholder: "0–100",
              hint: `0 = ${yAxis.low_label}, 100 = ${yAxis.high_label}. Leave empty to keep it unscored.`,
              validate: (value) => scoreError(yAxis.label, value),
            },
            {
              name: "x_score",
              label: `${xAxis.label} score (0–100)`,
              defaultValue:
                typeof gap.axis_scores?.[xAxis.id] === "number" ? String(gap.axis_scores[xAxis.id]) : "",
              placeholder: "0–100",
              hint: `0 = ${xAxis.low_label}, 100 = ${xAxis.high_label}. Leave empty to keep it unscored.`,
              validate: (value) => scoreError(xAxis.label, value),
            },
            {
              name: "band",
              label: "Band",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: point ? "The quadrant the scores fall in" : "The quadrant (needs both scores)" },
                ...BANDS.map((value) => ({ value, label: BAND_LABELS[value] })),
              ],
              // Customers aren't told about AI when it is off (KAN-53).
              hint: ai
                ? "A band you set here is yours: a later model run keeps it and only updates its own suggestion."
                : "A band you set here is kept until you change it.",
            },
            {
              name: "validate",
              label: "Confirm priority now",
              type: "select",
              defaultValue: "no",
              options: [
                { value: "no", label: "No — keep it as a draft" },
                { value: "yes", label: "Yes — confirm priority" },
              ],
            },
          ]}
          validateForm={(values) =>
            placementGapError({
              x: { label: xAxis.label, typed: values.x_score ?? "", saved: gap.axis_scores?.[xAxis.id] },
              y: { label: yAxis.label, typed: values.y_score ?? "", saved: gap.axis_scores?.[yAxis.id] },
              band: values.band ?? "",
            })
          }
          label={band ? "Edit scores" : "Set priority"}
          title={`${point ? "Edit the placement of" : "Place"} ${gap.gap_name}`}
          description={
            ai
              ? "Type the exact axis scores and, if you want, the band. No model run is needed; what you set is kept across re-runs."
              : "Type the exact axis scores and, if you want, the band."
          }
          confirmLabel="Save placement"
          requireRationale
          rationaleFieldName="reason"
          rationaleLabel="Reason for change (required)"
          identity={identity}
          variant="outline"
          size="sm"
        />
      ) : null}
      {band && mayPrioritize ? (
        <ActionDialog
          endpoint="/api/plan"
          payload={{ action: "validate_band", gap_id: gap.gap_id, band, expected_version: gap.version ?? null, expected_context_version: gap.context_version ?? null }}
          label={gap.needs_review ? "Review changed context and reconfirm" : gap.validated ? "Review or change priority" : ai && (gap.run_id || gap.suggested_rationale) && !gap.human_band ? "Make manual judgement" : "Review and confirm priority"}
          title={`Confirm ${BAND_LABELS[band]} priority for ${gap.gap_name}`}
          description="Make an explicit manual judgement across all settings and record your own reason. Supporting references are not required for a manual judgement, including when you retain the same band and scores."
          confirmLabel="Confirm priority"
          requireRationale
          rationaleFieldName="reason"
          rationaleLabel="Reason for change (required)"
          identity={identity}
          variant={gap.validated ? "outline" : "default"}
          size="sm"
        />
      ) : null}
    </article>
  );
}

/**
 * The Prioritize matrix. Gaps sit where their two axis scores put them; drag
 * one (or focus it and use the arrow keys) to move it. The quadrant it lands
 * in is its band — top-left High, bottom-right Low, the rest Medium.
 */
export function PrioritizeMatrix({
  scope,
  gaps,
  axes,
  xAxis,
  yAxis,
  identity,
  mayPrioritize,
  tacticsUnlocked = false,
}: {
  scope: string;
  gaps: PrioritizeGap[];
  axes: PriorityAxis[];
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  identity: ActionIdentity;
  mayPrioritize: boolean;
  tacticsUnlocked?: boolean;
}) {
  const { refresh } = usePageRefresh();
  const ai = useAiEnabled("prioritization");
  const plotRef = useRef<HTMLDivElement>(null);
  const matrixRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    gapId: string;
    startX: number;
    startY: number;
    moved: boolean;
    /** Dragged in from the "Not placed yet" list: a drop outside the matrix places nothing. */
    fromList: boolean;
  } | null>(null);
  const [pendingMove, setPendingMove] = useState<{ gapId: string; point: Point; version: string | null; contextVersion: string | null } | null>(null);
  const autoPlaced = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // An error is announced as an alert; a summary (re-suggest finished) is quiet text.
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const showError = (text: string) => setMessage({ text, error: true });

  // Server data is the truth once it refreshes; drop local drag overrides then.
  const [seenGaps, setSeenGaps] = useState(gaps);
  if (seenGaps !== gaps) {
    setSeenGaps(gaps);
    setPositions({});
  }

  // A gap dropped on the matrix leaves this list at once, not after the refresh.
  const unplaced = gaps.filter((gap) => !positions[gap.gap_id] && !pointOf(gap, xAxis, yAxis));

  // Gaps new to this scope (or to these axes) get a first placement automatically.
  useEffect(() => {
    // With AI off nothing is placed for you: unplaced gaps wait for a person. A Room
    // slide shows the matrix; it never starts an S8 run of its own (KAN-18).
    if (!ai || autoPlaced.current || unplaced.length === 0 || !mayPrioritize || isPresenting()) return;
    autoPlaced.current = true;
    setBusy("Placing new gaps on the matrix…");
    void runPrioritization({
      identity,
      gapIds: unplaced.map((gap) => gap.gap_id),
      xAxis: xAxis.id,
      yAxis: yAxis.id,
      setting: scope,
      onlyMissing: true,
    }).then((result) => {
      // "Placing…" stays up until the placed gaps are on the matrix, not just saved.
      refresh(() => {
        setBusy(null);
        if (!result.ok) setMessage({ text: result.error ?? "Could not place the new gaps.", error: true });
      });
    });
  }, [ai, unplaced, mayPrioritize, identity, xAxis.id, yAxis.id, scope, refresh]);

  const view = gaps.map((gap) => {
    const point = positions[gap.gap_id] ?? pointOf(gap, xAxis, yAxis);
    const band = gap.band ?? gap.suggested_band;
    return { gap, point, band, validated: gap.validated };
  });
  const placed = view.filter((row) => row.point);
  const selected = gaps.find((gap) => gap.gap_id === selectedId) ?? null;
  const selectedView = view.find((row) => row.gap.gap_id === selectedId);
  const validatedCount = view.filter((row) => row.validated).length;
  // The design's priority chips: each counts its gaps and highlights them on the canvas.
  const [highlight, setHighlight] = useState<Band | null>(null);
  const bandCounts = Object.fromEntries(BANDS.map((b) => [b, view.filter((row) => row.band === b).length])) as Record<Band, number>;

  function pointFromEvent(event: PointerEvent): Point | null {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const left = ((event.clientX - rect.left) / rect.width) * 100;
    const top = ((event.clientY - rect.top) / rect.height) * 100;
    return {
      x: Math.max(0, Math.min(100, left)),
      y: Math.max(0, Math.min(100, 100 - top)),
    };
  }

  function requestMove(gapId: string, point: Point) {
    const gap = gaps.find((candidate) => candidate.gap_id === gapId);
    if (!gap) return;
    const rounded = { x: Math.round(point.x), y: Math.round(point.y) };
    const saved = pointOf(gap, xAxis, yAxis);
    if (saved && Math.round(saved.x) === rounded.x && Math.round(saved.y) === rounded.y) {
      dropPosition(gapId);
      return;
    }
    // Preview only. Nothing is sent on cancellation, navigation or pagehide.
    setPendingMove({ gapId, point: rounded, version: gap.version ?? null, contextVersion: gap.context_version ?? null });
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, gapId: string) {
    if (!mayPrioritize || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { gapId, startX: event.clientX, startY: event.clientY, moved: false, fromList: false };
  }

  /**
   * A drag from the "Not placed yet" list onto the matrix (owner feedback, KAN-52). The pointer
   * leaves the list, so it is followed on the window rather than captured by the list item.
   */
  function onListPointerDown(event: PointerEvent<HTMLButtonElement>, gapId: string) {
    if (!mayPrioritize || event.button !== 0) return;
    event.preventDefault(); // no text selection while dragging
    dragRef.current = { gapId, startX: event.clientX, startY: event.clientY, moved: false, fromList: true };
    const move = (e: globalThis.PointerEvent) => onPointerMove(e as unknown as PointerEvent<HTMLButtonElement>);
    const up = (e: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      onPointerUp(e as unknown as PointerEvent<HTMLButtonElement>);
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragRef.current = null;
      dropPosition(gapId);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  function overPlot(event: PointerEvent) {
    const rect = plotRef.current?.getBoundingClientRect();
    return Boolean(
      rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom,
    );
  }

  function dropPosition(gapId: string) {
    setPositions((current) => {
      const next = { ...current };
      delete next[gapId];
      return next;
    });
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    // From the list, the gap appears on the matrix only while the pointer is over it.
    if (drag.fromList && !overPlot(event)) {
      dropPosition(drag.gapId);
      return;
    }
    const point = pointFromEvent(event);
    if (point) setPositions((current) => ({ ...current, [drag.gapId]: point }));
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.moved) {
      setSelectedId(drag.gapId);
      return;
    }
    // Dropped back outside the matrix: nothing is placed and nothing is selected.
    if (drag.fromList && !overPlot(event)) {
      dropPosition(drag.gapId);
      return;
    }
    setSelectedId(drag.gapId);
    const point = pointFromEvent(event);
    if (point) requestMove(drag.gapId, point);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, gapId: string, point: Point) {
    const step = event.shiftKey ? 10 : 2;
    // Arrow keys move on screen: right is the favourable end of X, up of Y.
    const delta: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: step },
      ArrowDown: { x: 0, y: -step },
    };
    const move = delta[event.key];
    if (!move || !mayPrioritize) return;
    event.preventDefault();
    const next = {
      x: Math.max(0, Math.min(100, point.x + move.x)),
      y: Math.max(0, Math.min(100, point.y + move.y)),
    };
    setSelectedId(gapId);
    setPositions((current) => ({ ...current, [gapId]: next }));
    requestMove(gapId, next);
  }

  async function resuggest() {
    const targets = view.filter((row) => !row.validated).map((row) => row.gap.gap_id);
    if (targets.length === 0) return;
    setBusy("Re-suggesting unvalidated gaps…");
    setMessage(null);
    const result = await runPrioritization({
      identity,
      gapIds: targets,
      xAxis: xAxis.id,
      yAxis: yAxis.id,
      setting: scope,
      onlyMissing: false,
    });
    refresh(() => {
      setBusy(null);
      if (!result.ok) showError(result.error ?? "Re-suggest failed");
      else setMessage(result.summary ? { text: result.summary, error: false } : null);
    });
  }

  /** Axes change in place (owner feedback, KAN-56): save them, then place any gap missing scores on them. */
  async function changeAxes(nextX: string, nextY: string) {
    if (!mayPrioritize || nextX === nextY) return;
    setBusy("Saving axes…");
    setMessage(null);
    const saveError = await saveAxes(scope, nextX, nextY);
    if (saveError) {
      setBusy(null);
      showError(saveError);
      return;
    }
    if (ai && gaps.length > 0) {
      setBusy("Placing gaps on the new axes…");
      const result = await runPrioritization({
        identity,
        gapIds: gaps.map((gap) => gap.gap_id),
        xAxis: nextX,
        yAxis: nextY,
        setting: scope,
        onlyMissing: true,
      });
      if (!result.ok) showError(result.error ?? "Prioritization failed");
    }
    refresh(() => setBusy(null));
  }

  return (
    <div ref={matrixRef} className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Highlight a priority">
        {BANDS.map((b) => {
          const on = highlight === b;
          return (
            <button
              key={b}
              type="button"
              aria-pressed={on}
              onClick={() => setHighlight(on ? null : b)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-[11.5px] transition-colors",
                on ? "border-current" : "border-border hover:bg-muted",
              )}
              style={on ? { color: BAND_TOKENS[b] } : undefined}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: BAND_TOKENS[b] }} aria-hidden />
              <span className="font-medium text-foreground">{QUADRANT_NAMES[b]}</span>
              <span className="font-bold" style={{ color: BAND_TOKENS[b] }}>{bandCounts[b]}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground" data-testid="matrix-axes">
          <label className="inline-flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">Vertical</span>
            <select
              aria-label="Vertical axis (Y)"
              value={yAxis.id}
              disabled={!mayPrioritize || Boolean(busy)}
              onChange={(event) => void changeAxes(xAxis.id, event.target.value)}
              className="h-7 rounded-md border border-input bg-card px-2 text-[12px] text-foreground"
            >
              {axes.map((axis) => (
                <option key={axis.id} value={axis.id} disabled={axis.id === xAxis.id}>
                  {axis.label}
                </option>
              ))}
            </select>
          </label>
          <span aria-hidden>×</span>
          <label className="inline-flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">Horizontal</span>
            <select
              aria-label="Horizontal axis (X)"
              value={xAxis.id}
              disabled={!mayPrioritize || Boolean(busy)}
              onChange={(event) => void changeAxes(event.target.value, yAxis.id)}
              className="h-7 rounded-md border border-input bg-card px-2 text-[12px] text-foreground"
            >
              {axes.map((axis) => (
                <option key={axis.id} value={axis.id} disabled={axis.id === yAxis.id}>
                  {axis.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {busy ? (
            <span role="status" className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {busy}
            </span>
          ) : null}
          {ai ? (
            <button
              type="button"
              onClick={() => void resuggest()}
              disabled={!mayPrioritize || Boolean(busy) || validatedCount === gaps.length}
              className="h-7 rounded-md border border-border px-2.5 text-[12px] text-foreground hover:bg-muted disabled:opacity-50"
              title="Ask the model again for every gap you have not validated yet"
            >
              Re-suggest unvalidated
            </button>
          ) : null}
        </div>
      </div>
      {message?.error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {message.text}
        </p>
      ) : message ? (
        <p className="text-[12px] text-muted-foreground">{message.text}</p>
      ) : null}

      {pendingMove ? (
        <ActionDialog
          key={pendingMove.gapId}
          endpoint="/api/plan"
          payload={{ action: "move_placement", gap_id: pendingMove.gapId,
            x_axis: xAxis.id, y_axis: yAxis.id, x: pendingMove.point.x, y: pendingMove.point.y,
            expected_version: pendingMove.version, expected_context_version: pendingMove.contextVersion }}
          open
          onOpenChange={(open) => {
            if (!open) {
              dropPosition(pendingMove.gapId);
              setPendingMove(null);
              requestAnimationFrame(() => matrixRef.current?.querySelector<HTMLButtonElement>(`button[data-gap-id="${pendingMove.gapId}"]`)?.focus());
            }
          }}
          trigger={null}
          label="Save matrix move"
          title={`Review matrix move for ${gaps.find((gap) => gap.gap_id === pendingMove.gapId)?.gap_name ?? pendingMove.gapId}`}
          description={`${xAxis.label}: ${scoreFromFavourability(xAxis, pendingMove.point.x)}; ${yAxis.label}: ${scoreFromFavourability(yAxis, pendingMove.point.y)}. Proposed band: ${BAND_LABELS[bandAt(pendingMove.point, xAxis, yAxis)]}. Give a reason to save this move. Closing cancels it.`}
          confirmLabel="Save matrix move"
          rationaleFieldName="reason"
          rationaleLabel="Reason for change (required)"
          identity={identity}
        />
      ) : null}

      {/* The matrix and its side panel share one screen (KAN-56): the matrix shrinks to the
          window height, so a gap in "Not placed yet" can be dragged on without scrolling. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,auto)_minmax(280px,1fr)] lg:items-start">
        <div className="grid w-full min-w-0 max-w-[min(748px,calc(100dvh-140px))] gap-2 max-lg:max-w-[748px]">
          <div className="flex items-stretch gap-2">
            <div className="flex w-5 shrink-0 flex-col items-center justify-between py-1 text-[11px] text-muted-foreground">
              <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap">{favourableLabel(yAxis)}</span>
              <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap text-foreground">{yAxis.label}</span>
              <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap">{unfavourableLabel(yAxis)}</span>
            </div>
            <div
              ref={plotRef}
              className="relative aspect-square w-full touch-none select-none overflow-hidden rounded-md border border-border bg-card/40"
              role="group"
              aria-label={`Prioritization matrix: ${yAxis.label} by ${xAxis.label}`}
            >
              <QuadrantBackdrop />
              {placed.map(({ gap, point, band, validated }) => {
                const offsets = toOffsets(point!);
                const isSelected = gap.gap_id === selectedId;
                return (
                  <button
                    key={gap.gap_id}
                    data-gap-id={gap.gap_id}
                    type="button"
                    onPointerDown={(event) => onPointerDown(event, gap.gap_id)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={() => { dragRef.current = null; dropPosition(gap.gap_id); }}
                    onKeyDown={(event) => onKeyDown(event, gap.gap_id, point!)}
                    onClick={() => setSelectedId(gap.gap_id)}
                    aria-label={`${gap.gap_name}: ${band ? BAND_LABELS[band] : "unplaced"}${validated ? ", priority confirmed" : ", priority not confirmed"}. Arrow keys move it.`}
                    aria-pressed={isSelected}
                    className={cn(
                      "absolute flex max-w-[42%] -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border bg-card/95 px-2 py-0.5 text-[11px] leading-4 text-foreground shadow-sm transition-opacity",
                      highlight && band !== highlight && !isSelected && "opacity-15",
                      mayPrioritize ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                      isSelected ? "z-30 ring-2 ring-foreground/60" : "z-10 hover:z-20",
                    )}
                    style={{
                      left: `${offsets.left}%`,
                      top: `${offsets.top}%`,
                      borderColor: band ? BAND_TOKENS[band] : "var(--border)",
                      borderStyle: validated ? "solid" : "dashed",
                    }}
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: band ? BAND_TOKENS[band] : "var(--muted-foreground)" }}
                      aria-hidden
                    />
                    <span className="truncate">{gap.gap_name}</span>
                    {validated ? <span className="shrink-0 text-[10px] text-muted-foreground">✓</span> : null}
                  </button>
                );
              })}
              {placed.length === 0 ? (
                <p className="absolute inset-0 grid place-items-center p-6 text-center text-[12px] text-muted-foreground">
                  {busy ??
                    (ai
                      ? "No gap is placed yet."
                      : "No gap is placed yet. Drag one from Not placed yet onto the matrix.")}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-between pl-7 text-[11px] text-muted-foreground">
            <span>{unfavourableLabel(xAxis)}</span>
            <span className="text-foreground">{xAxis.label}</span>
            <span>{favourableLabel(xAxis)}</span>
          </div>
          <p className="pl-7 text-[11px] leading-4 text-muted-foreground">
            Drag a gap to change its priority, or select it and use the arrow keys (Shift for bigger
            steps). Every saved move needs a reason. A dashed edge means the priority is not confirmed yet.
          </p>
        </div>

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:sticky lg:top-5">
          {selected && selectedView ? (
            <GapDetail
              gap={{ ...selected, band: selectedView.band, validated: selectedView.validated }}
              xAxis={xAxis}
              yAxis={yAxis}
              identity={identity}
              mayPrioritize={mayPrioritize}
              tacticsUnlocked={tacticsUnlocked}
            />
          ) : (
            <p className="border border-dashed border-border p-4 text-[12px] text-muted-foreground">
              Select a gap on the matrix to review its evidence, decision context and priority.
            </p>
          )}
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            {unplaced.length > 0 && !busy ? (
              <section aria-label="Gaps not placed yet">
                <h3 className="mb-1 text-[12px] font-medium text-foreground">
                  Not placed yet <span className="font-normal text-muted-foreground">{unplaced.length}</span>
                </h3>
                <p className="mb-1 text-[11px] leading-4 text-muted-foreground">
                  {mayPrioritize
                    ? "Drag a gap onto the matrix: where you drop it sets its two scores. Or select it to type them."
                    : "Your role may view the matrix but not place gaps."}
                </p>
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                  {unplaced.map((gap) => (
                    <li key={gap.gap_id}>
                      <button
                        type="button"
                        data-testid="unplaced-gap"
                        data-gap-id={gap.gap_id}
                        onPointerDown={(event) => onListPointerDown(event, gap.gap_id)}
                        onClick={() => setSelectedId(gap.gap_id)}
                        aria-label={`${gap.gap_name}: not placed. Drag onto the matrix, or select to type its scores.`}
                        className={cn(
                          "flex w-full touch-none select-none items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] hover:bg-muted",
                          mayPrioritize && "cursor-grab active:cursor-grabbing",
                          gap.gap_id === selectedId && "bg-muted",
                        )}
                      >
                        <span aria-hidden className="text-muted-foreground">
                          ⠿
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground">{gap.gap_name}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {gap.band ? BAND_LABELS[gap.band] : "No band yet"} · Evidence needed by: {gap.objective?.evidence_needed_by || "Unknown"}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {priorityNextAction({ band: gap.band ?? gap.suggested_band, validated: gap.validated, needs_review: gap.needs_review, tacticsUnlocked })}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {BANDS.map((band) => {
              const rows = view.filter((row) => row.point && row.band === band);
              return (
                <section key={band} aria-label={`${BAND_LABELS[band]} gaps`}>
                  <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                    <span className="size-2 rounded-full" style={{ backgroundColor: BAND_TOKENS[band] }} aria-hidden />
                    {BAND_LABELS[band]}
                    <span className="font-normal text-muted-foreground">{rows.length}</span>
                  </h3>
                  {rows.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">None</p>
                  ) : (
                    <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                      {rows.map(({ gap, validated }) => (
                        <li key={gap.gap_id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(gap.gap_id)}
                            className={cn(
                              "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] hover:bg-muted",
                              gap.gap_id === selectedId && "bg-muted",
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-foreground">{gap.gap_name}</span>
                              <span className="block text-[11px] text-muted-foreground">
                                {BAND_LABELS[band]} · Evidence needed by: {gap.objective?.evidence_needed_by || "Unknown"}
                              </span>
                              <span className="block text-[11px] text-muted-foreground">
                                {priorityNextAction({ band, validated, needs_review: gap.needs_review, tacticsUnlocked })}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
