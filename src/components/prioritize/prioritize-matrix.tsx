"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Loader2 } from "lucide-react";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { SettingChips } from "@/components/gap-settings-editor";
import { BandChip, BAND_LABELS, BAND_TOKENS, BANDS, type Band } from "@/components/matrix/bands";
import { cn } from "@/lib/utils";
import {
  favourability,
  favourableLabel,
  quadrantBand,
  scoreFromFavourability,
  unfavourableLabel,
  type PriorityAxis,
} from "@/modules/stages/s8-prioritization/axis-math";

export type PrioritizeGap = {
  gap_id: string;
  gap_name: string;
  statement: string;
  domain_label: string;
  settings: string[];
  tactic_count: number;
  /** Raw axis scores keyed by axis id; missing until S8 places the gap. */
  axis_scores: Record<string, number> | null;
  band: Band | null;
  validated: boolean;
  suggested_band: Band | null;
  suggested_rationale: string | null;
  /** Axis ids a person set; a model re-run keeps their scores. */
  human_axes?: string[];
  /** The band is a person's; a model re-run keeps it. */
  human_band?: boolean;
  rationale: string | null;
  actor_name: string | null;
  at: string | null;
};

type Point = { x: number; y: number };

/** Favourable-scale point (100 = priority end) → CSS offsets. X is flipped so the priority end is left. */
function toOffsets(point: Point) {
  return { left: 100 - point.x, top: 100 - point.y };
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
  const res = await fetch("/api/modules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
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
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; summary?: string; mode?: string };
  return res.ok ? { ok: true, summary: json.summary, mode: json.mode } : { ok: false, error: json.error ?? "Prioritization failed" };
}

async function saveAxes(scope: string, xAxis: string, yAxis: string): Promise<string | null> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save_scope_axes", scope, x_axis: xAxis, y_axis: yAxis }),
  });
  if (res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
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
  const router = useRouter();
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
    if (gapIds.length > 0) {
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
        router.refresh();
        return;
      }
    }
    setPending(false);
    onCancel?.();
    router.refresh();
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
          Pick the two axes for the matrix. The model places each Open gap as a first draft; you then
          drag gaps to change their priority and validate each one. Top-left is High, bottom-right
          is Low, the other two corners are Medium.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <AxisSelect label="Vertical axis (Y)" value={yAxis} onChange={setYAxis} axes={axes} exclude={xAxis} />
        <AxisSelect label="Horizontal axis (X)" value={xAxis} onChange={setXAxis} axes={axes} exclude={yAxis} />
      </div>
      {x && y ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          High = <span className="text-foreground">{favourableLabel(y)}</span> and{" "}
          <span className="text-foreground">{favourableLabel(x)}</span>. Low ={" "}
          {unfavourableLabel(y)} and {unfavourableLabel(x)}.
        </p>
      ) : null}
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || !mayPrioritize}
          onClick={() => void submit()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {pending ? "Placing gaps…" : submitLabel}
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
  const cells: { band: Band; label: string; className: string }[] = [
    { band: "high", label: "High", className: "left-0 top-0" },
    { band: "medium", label: "Medium", className: "right-0 top-0" },
    { band: "medium", label: "Medium", className: "left-0 bottom-0" },
    { band: "low", label: "Low", className: "right-0 bottom-0" },
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
            {cell.label}
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
}: {
  gap: PrioritizeGap;
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  identity: ActionIdentity;
  mayPrioritize: boolean;
}) {
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
      <p className="text-[12px] leading-5 text-muted-foreground">{gap.statement}</p>
      {point && gap.axis_scores ? (
        <dl className="grid grid-cols-2 gap-2 text-[11px]">
          {[yAxis, xAxis].map((axis) => (
            <div key={axis.id} className="grid gap-0.5">
              <dt className="text-muted-foreground">{axis.label}</dt>
              <dd className="text-foreground">
                {gap.axis_scores?.[axis.id]} / 100
                {gap.human_axes?.includes(axis.id) ? <span className="text-muted-foreground"> · set by hand</span> : null}
                <span className="text-muted-foreground">
                  {" "}
                  · {(gap.axis_scores?.[axis.id] ?? 0) >= 50 ? axis.high_label : axis.low_label}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {gap.suggested_band && gap.suggested_rationale ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          <span className="text-foreground">Model suggested {BAND_LABELS[gap.suggested_band]}.</span>{" "}
          {gap.suggested_rationale}
        </p>
      ) : null}
      {quadrant && band && quadrant !== band ? (
        <p className="text-[11px] leading-4 text-amber-300">
          This gap&apos;s band ({BAND_LABELS[band]}) was set on a different pair of axes. It sits in the{" "}
          {BAND_LABELS[quadrant]} quadrant here — drag it to change its priority.
        </p>
      ) : null}
      {gap.validated ? (
        <p className="text-[11px] leading-4" style={{ color: band ? BAND_TOKENS[band] : undefined }}>
          Validated {band ? BAND_LABELS[band] : ""} by {gap.actor_name ?? "unknown"}
          {gap.at ? ` · ${gap.at.slice(0, 10)}` : ""}
          {gap.rationale ? ` — ${gap.rationale}` : ""}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Not validated. Drag the gap to the right quadrant or edit its scores, then validate it.
        </p>
      )}
      {mayPrioritize ? (
        <ActionDialog
          endpoint="/api/plan"
          payload={{ action: "set_placement", gap_id: gap.gap_id, x_axis: xAxis.id, y_axis: yAxis.id }}
          fields={[
            {
              name: "y_score",
              label: `${yAxis.label} score (0–100)`,
              defaultValue:
                typeof gap.axis_scores?.[yAxis.id] === "number" ? String(gap.axis_scores[yAxis.id]) : "",
              placeholder: "0–100",
              hint: `0 = ${yAxis.low_label}, 100 = ${yAxis.high_label}. Leave empty to keep it unscored.`,
            },
            {
              name: "x_score",
              label: `${xAxis.label} score (0–100)`,
              defaultValue:
                typeof gap.axis_scores?.[xAxis.id] === "number" ? String(gap.axis_scores[xAxis.id]) : "",
              placeholder: "0–100",
              hint: `0 = ${xAxis.low_label}, 100 = ${xAxis.high_label}. Leave empty to keep it unscored.`,
            },
            {
              name: "band",
              label: "Band",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: point ? "The quadrant the scores fall in" : "The quadrant (needs both scores)" },
                ...(["high", "medium", "low"] as const).map((value) => ({ value, label: BAND_LABELS[value] })),
              ],
              hint: "A band you set here is yours: a later model run keeps it and only updates its own suggestion.",
            },
            {
              name: "validate",
              label: "Validate the band now",
              type: "select",
              defaultValue: "no",
              options: [
                { value: "no", label: "No — keep it as a draft" },
                { value: "yes", label: "Yes — lock it as validated" },
              ],
            },
          ]}
          label={point ? "Edit scores" : "Place by hand"}
          title={`${point ? "Edit the placement of" : "Place"} ${gap.gap_name}`}
          description="Type the exact axis scores and, if you want, the band. No model run is needed; what you set is kept across re-runs."
          confirmLabel="Save placement"
          requireRationale
          identity={identity}
          variant="outline"
          size="sm"
        />
      ) : null}
      {band && mayPrioritize ? (
        <ActionDialog
          endpoint="/api/plan"
          payload={{ action: "validate_band", gap_id: gap.gap_id, band }}
          label={gap.validated ? `Re-validate ${BAND_LABELS[band]}` : `Validate ${BAND_LABELS[band]}`}
          title={`Validate ${BAND_LABELS[band]} for ${gap.gap_name}`}
          description="Locks this priority band for the gap in every setting. To change the band, drag the gap to another quadrant first."
          confirmLabel={`Validate ${BAND_LABELS[band]}`}
          requireRationale
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
  scopeLabel,
  gaps,
  axes,
  xAxis,
  yAxis,
  identity,
  mayPrioritize,
}: {
  scope: string;
  scopeLabel: string;
  gaps: PrioritizeGap[];
  axes: PriorityAxis[];
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  identity: ActionIdentity;
  mayPrioritize: boolean;
}) {
  const router = useRouter();
  const plotRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ gapId: string; startX: number; startY: number; moved: boolean } | null>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoPlaced = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [bands, setBands] = useState<Record<string, { band: Band; validated: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingAxes, setEditingAxes] = useState(false);

  // Server data is the truth once it refreshes; drop local drag overrides then.
  const [seenGaps, setSeenGaps] = useState(gaps);
  if (seenGaps !== gaps) {
    setSeenGaps(gaps);
    setPositions({});
    setBands({});
  }

  const unplaced = gaps.filter((gap) => !pointOf(gap, xAxis, yAxis));

  // Gaps new to this scope (or to these axes) get a first placement automatically.
  useEffect(() => {
    if (autoPlaced.current || unplaced.length === 0 || !mayPrioritize) return;
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
      setBusy(null);
      if (!result.ok) setMessage(result.error ?? "Could not place the new gaps.");
      router.refresh();
    });
  }, [unplaced, mayPrioritize, identity, xAxis.id, yAxis.id, scope, router]);

  const view = gaps.map((gap) => {
    const point = positions[gap.gap_id] ?? pointOf(gap, xAxis, yAxis);
    const local = bands[gap.gap_id];
    const band = local?.band ?? gap.band ?? gap.suggested_band;
    return { gap, point, band, validated: local ? local.validated : gap.validated };
  });
  const placed = view.filter((row) => row.point);
  const selected = gaps.find((gap) => gap.gap_id === selectedId) ?? null;
  const selectedView = view.find((row) => row.gap.gap_id === selectedId);
  const validatedCount = view.filter((row) => row.validated).length;

  function pointFromEvent(event: PointerEvent): Point | null {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const left = ((event.clientX - rect.left) / rect.width) * 100;
    const top = ((event.clientY - rect.top) / rect.height) * 100;
    return {
      x: Math.max(0, Math.min(100, 100 - left)),
      y: Math.max(0, Math.min(100, 100 - top)),
    };
  }

  async function commit(gapId: string, point: Point) {
    setMessage(null);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "move_placement",
        gap_id: gapId,
        x_axis: xAxis.id,
        y_axis: yAxis.id,
        x: Math.round(point.x),
        y: Math.round(point.y),
        actor_name: identity.actor_name,
        actor_function: identity.actor_function,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      placement?: { band: Band; validated: boolean };
    };
    if (!res.ok || !json.placement) {
      setMessage(json.error ?? "Could not move the gap.");
      setPositions((current) => {
        const next = { ...current };
        delete next[gapId];
        return next;
      });
      return;
    }
    setBands((current) => ({ ...current, [gapId]: json.placement! }));
    router.refresh();
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, gapId: string) {
    if (!mayPrioritize || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { gapId, startX: event.clientX, startY: event.clientY, moved: false };
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
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
    setSelectedId(drag.gapId);
    const point = pointFromEvent(event);
    if (point) void commit(drag.gapId, point);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, gapId: string, point: Point) {
    const step = event.shiftKey ? 10 : 2;
    // Arrow keys move on screen: left is the favourable end of X, up of Y.
    const delta: Record<string, Point> = {
      ArrowLeft: { x: step, y: 0 },
      ArrowRight: { x: -step, y: 0 },
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
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => void commit(gapId, next), 450);
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
    setBusy(null);
    setMessage(result.ok ? (result.summary ?? null) : (result.error ?? "Re-suggest failed"));
    router.refresh();
  }

  if (editingAxes) {
    return (
      <AxisChooser
        scope={scope}
        scopeLabel={scopeLabel}
        axes={axes}
        initialX={xAxis.id}
        initialY={yAxis.id}
        gapIds={gaps.map((gap) => gap.gap_id)}
        identity={identity}
        mayPrioritize={mayPrioritize}
        submitLabel="Save axes"
        onCancel={() => setEditingAxes(false)}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">
          <span className="text-foreground">{yAxis.label}</span> ×{" "}
          <span className="text-foreground">{xAxis.label}</span> · {validatedCount} of {gaps.length} validated
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {busy ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {busy}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setEditingAxes(true)}
            disabled={!mayPrioritize || Boolean(busy)}
            className="h-7 rounded-md border border-border px-2.5 text-[12px] text-foreground hover:bg-muted disabled:opacity-50"
          >
            Change axes
          </button>
          <button
            type="button"
            onClick={() => void resuggest()}
            disabled={!mayPrioritize || Boolean(busy) || validatedCount === gaps.length}
            className="h-7 rounded-md border border-border px-2.5 text-[12px] text-foreground hover:bg-muted disabled:opacity-50"
            title="Ask the model again for every gap you have not validated yet"
          >
            Re-suggest unvalidated
          </button>
        </div>
      </div>
      {message ? <p className="text-[12px] text-muted-foreground">{message}</p> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <div className="grid min-w-0 gap-2">
          <div className="flex items-stretch gap-2">
            <div className="flex w-5 shrink-0 flex-col items-center justify-between py-1 text-[11px] text-muted-foreground">
              <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap">{favourableLabel(yAxis)}</span>
              <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap text-foreground">{yAxis.label}</span>
              <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap">{unfavourableLabel(yAxis)}</span>
            </div>
            <div
              ref={plotRef}
              className="relative aspect-square w-full max-w-[720px] touch-none select-none overflow-hidden rounded-md border border-border bg-card/40"
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
                    type="button"
                    onPointerDown={(event) => onPointerDown(event, gap.gap_id)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={() => (dragRef.current = null)}
                    onKeyDown={(event) => onKeyDown(event, gap.gap_id, point!)}
                    onClick={() => setSelectedId(gap.gap_id)}
                    aria-label={`${gap.gap_name}: ${band ? BAND_LABELS[band] : "unplaced"}${validated ? ", validated" : ", not validated"}. Arrow keys move it.`}
                    aria-pressed={isSelected}
                    className={cn(
                      "absolute flex max-w-[42%] -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border bg-card/95 px-2 py-0.5 text-[11px] leading-4 text-foreground shadow-sm",
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
                  {busy ?? "No gap is placed yet."}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex max-w-[748px] items-center justify-between pl-7 text-[11px] text-muted-foreground">
            <span>{favourableLabel(xAxis)}</span>
            <span className="text-foreground">{xAxis.label}</span>
            <span>{unfavourableLabel(xAxis)}</span>
          </div>
          <p className="max-w-[748px] pl-7 text-[11px] leading-4 text-muted-foreground">
            Drag a gap to change its priority, or select it and use the arrow keys (Shift for bigger
            steps). A dashed edge means the band is not validated yet.
          </p>
        </div>

        <div className="grid gap-4 xl:sticky xl:top-5">
          {selected && selectedView ? (
            <GapDetail
              gap={{ ...selected, band: selectedView.band, validated: selectedView.validated }}
              xAxis={xAxis}
              yAxis={yAxis}
              identity={identity}
              mayPrioritize={mayPrioritize}
            />
          ) : (
            <p className="border border-dashed border-border p-4 text-[12px] text-muted-foreground">
              Select a gap on the matrix to see why it sits there and validate its band.
            </p>
          )}
          <div className="grid gap-3">
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
                    <ul className="grid gap-0.5">
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
                            <span className="min-w-0 flex-1 truncate text-foreground">{gap.gap_name}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {validated ? "Validated" : "Draft"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
            {unplaced.length > 0 && !busy ? (
              <section aria-label="Gaps not placed yet">
                <h3 className="mb-1 text-[12px] font-medium text-foreground">
                  Not placed yet <span className="font-normal text-muted-foreground">{unplaced.length}</span>
                </h3>
                <p className="mb-1 text-[11px] leading-4 text-muted-foreground">
                  Select one to type its scores or band by hand — no model run needed.
                </p>
                <ul className="grid gap-0.5">
                  {unplaced.map((gap) => (
                    <li key={gap.gap_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(gap.gap_id)}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] hover:bg-muted",
                          gap.gap_id === selectedId && "bg-muted",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-foreground">{gap.gap_name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {gap.band ? `${BAND_LABELS[gap.band]}${gap.validated ? " · validated" : ""}` : "Unplaced"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
