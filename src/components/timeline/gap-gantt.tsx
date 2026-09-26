"use client";

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import {
  daysInMonth,
  MONTH_NAMES,
  monthAt,
  monthPos,
  monthWidthFor,
  parts,
  readPalette,
  truncate,
} from "@/components/timeline/gantt-chart";
import { CreateActivityDialog, ManualDatesDialog, type DragChange } from "@/components/timeline/timeline-dialogs";
import { TACTIC_TYPE_LABELS } from "@/lib/iegp/enums";
import type { TimelineActivity, TimelineBand } from "@/modules/stages/s10-timeline/build";
import type { GapTimelineGroup, GapTimelineItem, GapTimelineView } from "@/modules/stages/s10-timeline/gap-view";

const LABEL_W = 300;
const HEADER_H = 46;
const MARKER_H = 20;
const BAND_H = 24;
const GAP_H = 32;
const ITEM_H = 30;
const SECTION_H = 28;
const EMPTY_H = 24;
const BAR_H = 14;
const PAD_R = 28;
const PAD_B = 10;
const LEGEND_H = 30;
const HANDLE_W = 7;

const BAND_TITLES: Record<"high" | "medium" | "low", string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

const LEGEND: { band: TimelineBand; label: string }[] = [
  { band: "high", label: "High priority" },
  { band: "medium", label: "Medium priority" },
  { band: "low", label: "Low priority" },
  { band: "unprioritized", label: "Not yet prioritized" },
];

type Row =
  | { kind: "band"; key: string; y: number; h: number; band: "high" | "medium" | "low"; count: number }
  | { kind: "section"; key: string; y: number; h: number; section: "not_prioritized" | "other"; label: string; count: number }
  | { kind: "gap"; key: string; y: number; h: number; group: GapTimelineGroup; tone: TimelineBand }
  | { kind: "item"; key: string; y: number; h: number; item: GapTimelineItem; group: GapTimelineGroup | null; tone: TimelineBand }
  | { kind: "empty"; key: string; y: number; h: number; label: string };

type WithoutY<T> = T extends unknown ? Omit<T, "y"> : never;

function buildRows(view: GapTimelineView, top: number, showNotPrioritized: boolean): Row[] {
  const rows: Row[] = [];
  let y = top;
  const push = (row: WithoutY<Row>) => {
    rows.push({ ...row, y } as Row);
    y += row.h;
  };
  const pushGroup = (group: GapTimelineGroup, tone: TimelineBand) => {
    push({ kind: "gap", key: `gap:${group.gap_id}`, h: GAP_H, group, tone });
    for (const item of group.items) push({ kind: "item", key: item.key, h: ITEM_H, item, group, tone });
  };

  for (const band of ["high", "medium", "low"] as const) {
    const groups = view.prioritized.filter((group) => group.band === band);
    if (groups.length === 0) continue;
    push({ kind: "band", key: `band:${band}`, h: BAND_H, band, count: groups.length });
    for (const group of groups) pushGroup(group, band);
  }
  if (view.prioritized.length === 0) {
    push({ kind: "empty", key: "empty:prioritized", h: EMPTY_H, label: "No prioritized gaps yet. Validate bands on Prioritize." });
  }
  if (view.not_prioritized.length > 0) {
    push({
      kind: "section",
      key: "section:not_prioritized",
      h: SECTION_H,
      section: "not_prioritized",
      label: "Not prioritized",
      count: view.not_prioritized.length,
    });
    if (showNotPrioritized) for (const group of view.not_prioritized) pushGroup(group, "unprioritized");
  }
  if (view.other.length > 0) {
    push({ kind: "section", key: "section:other", h: SECTION_H, section: "other", label: "Other activities", count: view.other.length });
    for (const item of view.other) {
      push({ kind: "item", key: item.key, h: ITEM_H, item, group: null, tone: item.activity?.lane ?? "unprioritized" });
    }
  }
  return rows;
}

/** The date at a fractional month position from the window's first month: the inverse of monthPos. */
export function dateAtPos(originIso: string, pos: number): string {
  const whole = Math.floor(pos);
  const { year, month } = monthAt(originIso, whole);
  const days = daysInMonth(year, month);
  const day = Math.min(days, Math.max(1, Math.floor((pos - whole) * days) + 1));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The first of the window's month, so the ruler starts on a month boundary. */
function monthStart(iso: string) {
  const { year, month } = parts(iso);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

type Drag = {
  id: string;
  mode: "move" | "start" | "end";
  originX: number;
  start: string;
  end: string;
  dx: number;
};

/**
 * The owner's timeline: every prioritized gap as a group row (high → low, then
 * name), its tactics beneath it as bars. Undated tactics read "Unscheduled"
 * with a quick "Set dates"; bars drag to move and their ends drag to resize.
 * A drag only proposes dates: `onDragCommit` asks the person to confirm them.
 */
export function GapGantt({
  view,
  activities,
  today,
  selectedId,
  onSelect,
  svgRef,
  editable,
  canCreate,
  identity,
  onDragCommit,
}: {
  view: GapTimelineView;
  activities: TimelineActivity[];
  today: string;
  selectedId: string | null;
  onSelect: (activityId: string) => void;
  svgRef: RefObject<SVGSVGElement | null>;
  /** Dates and dependencies may be changed (not a viewer). */
  editable: boolean;
  /** New activities may be created under a gap. */
  canCreate: boolean;
  identity: ActionIdentity;
  onDragCommit: (change: DragChange) => void;
}) {
  const palette = useMemo(() => readPalette(), []);
  const [showNotPrioritized, setShowNotPrioritized] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragged = useRef(false);

  const origin = monthStart(view.window.start);
  const months = Math.max(1, view.window.months);
  const monthWidth = monthWidthFor(months);
  const top = HEADER_H + (view.markers.length > 0 ? MARKER_H : 0);
  const rows = useMemo(() => buildRows(view, top, showNotPrioritized), [view, top, showNotPrioritized]);
  const bodyBottom = rows.length > 0 ? rows[rows.length - 1]!.y + rows[rows.length - 1]!.h : top;
  const trackW = months * monthWidth;
  const width = LABEL_W + trackW + PAD_R;
  const height = bodyBottom + PAD_B + LEGEND_H;

  const x = (iso: string) => LABEL_W + monthPos(origin, iso) * monthWidth;
  const dateAtX = (px: number) => dateAtPos(origin, Math.max(0, (px - LABEL_W) / monthWidth));

  /** An activity's dates, with a drag in progress applied. */
  const datesOf = (activity: TimelineActivity) => {
    if (!drag || drag.id !== activity.id || drag.dx === 0) return { start: activity.start_date, end: activity.end_date };
    const shift = (iso: string) => dateAtX(x(iso) + drag.dx);
    if (drag.mode === "move") return { start: shift(drag.start), end: shift(drag.end) };
    if (drag.mode === "start") {
      const start = shift(drag.start);
      return { start: start > drag.end ? drag.end : start, end: drag.end };
    }
    const end = shift(drag.end);
    return { start: drag.start, end: end < drag.start ? drag.start : end };
  };

  const conflictKeys = new Set(view.conflicts.map((conflict) => `${conflict.predecessor_id}->${conflict.successor_id}`));
  const conflicted = new Set(view.conflicts.flatMap((conflict) => [conflict.predecessor_id, conflict.successor_id]));

  // Geometry of each activity's first row, for dependency arrows.
  const geometry = new Map<string, { x1: number; x2: number; cy: number }>();
  for (const row of rows) {
    if (row.kind !== "item" || !row.item.activity || geometry.has(row.item.activity_id)) continue;
    const { start, end } = datesOf(row.item.activity);
    const x1 = x(start);
    geometry.set(row.item.activity_id, { x1, x2: Math.max(x1 + 6, x(end)), cy: row.y + row.h / 2 });
  }
  const arrows: { key: string; d: string; broken: boolean }[] = [];
  for (const activity of activities) {
    const target = geometry.get(activity.id);
    if (!target) continue;
    for (const upstreamId of activity.depends_on) {
      const source = geometry.get(upstreamId);
      if (!source) continue;
      const key = `${upstreamId}->${activity.id}`;
      const turn =
        target.x1 - 10 > source.x2 + 10 ? source.x2 + Math.max(10, (target.x1 - source.x2) / 2) : source.x2 + 10;
      arrows.push({
        key,
        d: `M ${source.x2} ${source.cy} H ${turn} V ${target.cy} H ${target.x1 - 6}`,
        broken: conflictKeys.has(key),
      });
    }
  }

  const todayX = x(today);
  const todayVisible = todayX >= LABEL_W && todayX <= LABEL_W + trackW;
  const legendY = bodyBottom + PAD_B + 12;
  const colour = (band: TimelineBand) => palette[band];

  function beginDrag(event: ReactPointerEvent<SVGElement>, activity: TimelineActivity, mode: Drag["mode"]) {
    if (!editable || event.button !== 0) return;
    event.stopPropagation();
    dragged.current = false;
    svgRef.current?.setPointerCapture(event.pointerId);
    setDrag({ id: activity.id, mode, originX: event.clientX, start: activity.start_date, end: activity.end_date, dx: 0 });
  }

  function moveDrag(event: ReactPointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const dx = event.clientX - drag.originX;
    if (Math.abs(dx) >= 3) dragged.current = true;
    setDrag({ ...drag, dx: dragged.current ? dx : 0 });
  }

  function endDrag() {
    if (!drag) return;
    const activity = activities.find((row) => row.id === drag.id);
    const moved = dragged.current && activity;
    const next = activity ? datesOf(activity) : null;
    setDrag(null);
    if (moved && next && (next.start !== activity.start_date || next.end !== activity.end_date)) {
      onDragCommit({ activity, start_date: next.start, end_date: next.end });
    } else if (!dragged.current && activity) {
      // Pointer capture retargets the click to the chart, so a press without a drag selects here.
      onSelect(activity.id);
    }
    // Let the click that follows pointerup see that this was a drag.
    window.setTimeout(() => {
      dragged.current = false;
    }, 0);
  }

  const select = (id: string) => {
    if (dragged.current) return;
    onSelect(id);
  };

  return (
    <div className="relative" style={{ width }}>
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Gantt timeline with ${view.counts.dated} activities by gap, ${view.prioritized.length} prioritized gap(s), from ${view.window.start} to ${view.window.end}`}
        style={{
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif",
          touchAction: drag ? "none" : undefined,
          userSelect: "none",
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => setDrag(null)}
      >
        <defs>
          <marker id="synapse-gap-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M 0 0 L 7 3.5 L 0 7 z" fill={palette.muted} />
          </marker>
          <marker id="synapse-gap-arrow-broken" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M 0 0 L 7 3.5 L 0 7 z" fill={palette.conflict} />
          </marker>
        </defs>
        <rect x={0} y={0} width={width} height={height} fill={palette.background} />

        {Array.from({ length: months }, (_, index) => {
          const month = monthAt(origin, index);
          const left = LABEL_W + index * monthWidth;
          const quarterStart = (month.month - 1) % 3 === 0;
          return (
            <g key={`ruler-${index}`}>
              <line
                x1={left}
                y1={quarterStart ? 4 : 22}
                x2={left}
                y2={bodyBottom}
                stroke={palette.grid}
                strokeWidth={quarterStart ? 1 : 0.5}
                opacity={quarterStart ? 0.9 : 0.55}
              />
              {quarterStart ? (
                <text x={left + 5} y={15} fill={palette.muted} fontSize={10} letterSpacing={0.4}>
                  {`Q${Math.floor((month.month - 1) / 3) + 1} ${month.year}`}
                </text>
              ) : null}
              <text
                x={left + monthWidth / 2}
                y={37}
                fill={month.month === 1 ? palette.foreground : palette.muted}
                fontSize={monthWidth < 40 ? 9 : 10}
                textAnchor="middle"
              >
                {monthWidth < 40 ? MONTH_NAMES[month.month - 1]!.slice(0, 1) : MONTH_NAMES[month.month - 1]}
              </text>
            </g>
          );
        })}
        <line x1={0} y1={HEADER_H - 2} x2={width} y2={HEADER_H - 2} stroke={palette.grid} strokeWidth={1} />
        <line x1={LABEL_W} y1={4} x2={LABEL_W} y2={bodyBottom} stroke={palette.grid} strokeWidth={1} />
        <text x={8} y={37} fill={palette.muted} fontSize={10}>
          Gap · activity
        </text>

        {rows.map((row, index) => {
          if (row.kind === "band") {
            return (
              <g key={row.key}>
                <rect x={0} y={row.y} width={width} height={row.h} fill={palette.card} />
                <rect x={0} y={row.y} width={3} height={row.h} fill={colour(row.band)} />
                <text x={10} y={row.y + 16} fill={palette.foreground} fontSize={11} letterSpacing={0.3}>
                  {BAND_TITLES[row.band].toUpperCase()}
                </text>
                <text x={LABEL_W - 10} y={row.y + 16} fill={palette.muted} fontSize={10} textAnchor="end">
                  {`${row.count} gap(s)`}
                </text>
              </g>
            );
          }
          if (row.kind === "section") {
            return (
              <g key={row.key}>
                <rect x={0} y={row.y} width={width} height={row.h} fill={palette.card} />
                <rect x={0} y={row.y} width={3} height={row.h} fill={palette.unprioritized} />
                <text x={30} y={row.y + 18} fill={palette.foreground} fontSize={11} letterSpacing={0.3}>
                  {`${row.label.toUpperCase()} · ${row.count}`}
                </text>
              </g>
            );
          }
          if (row.kind === "empty") {
            return (
              <text key={row.key} x={12} y={row.y + 16} fill={palette.muted} fontSize={10} fontStyle="italic">
                {row.label}
              </text>
            );
          }
          if (row.kind === "gap") {
            const group = row.group;
            const tone = colour(row.tone);
            return (
              <g key={row.key} aria-label={`Gap ${group.gap_name}`}>
                <title>{`${group.gap_name} · ${group.statement}`}</title>
                <rect x={0} y={row.y} width={width} height={row.h} fill={palette.background} />
                <line x1={0} y1={row.y} x2={width} y2={row.y} stroke={palette.grid} strokeWidth={0.5} />
                <rect x={6} y={row.y + 9} width={4} height={14} rx={1} fill={tone} />
                <text x={16} y={row.y + 14} fill={palette.foreground} fontSize={11.5} fontWeight={600}>
                  {truncate(group.gap_name, canCreate && editable ? 30 : 42)}
                </text>
                <text x={16} y={row.y + 26} fill={palette.muted} fontSize={9.5}>
                  {`${group.gap_id} · ${group.items.length} activit${group.items.length === 1 ? "y" : "ies"}`}
                </text>
                {group.start && group.end ? (
                  <rect
                    x={x(group.start)}
                    y={row.y + row.h / 2 - 3}
                    width={Math.max(6, x(group.end) - x(group.start))}
                    height={6}
                    rx={2}
                    fill={tone}
                    opacity={0.55}
                  />
                ) : (
                  <text x={LABEL_W + 10} y={row.y + 20} fill={palette.muted} fontSize={10} fontStyle="italic">
                    Unscheduled
                  </text>
                )}
              </g>
            );
          }
          const item = row.item;
          const activity = item.activity;
          const indent = row.group ? 26 : 16;
          if (!activity) {
            return (
              <g key={row.key} aria-label={`${item.tactic_name}, unscheduled`}>
                <title>{`${item.tactic_name} · unscheduled${item.pending ? ` · ${item.pending.reason}` : ""}`}</title>
                <rect x={0} y={row.y} width={width} height={row.h} fill={palette.background} opacity={index % 2 ? 0 : 0.35} />
                <text x={indent} y={row.y + 18} fill={palette.muted} fontSize={11}>
                  {truncate(item.tactic_name, 40)}
                </text>
                <text x={LABEL_W + 10} y={row.y + 19} fill={palette.muted} fontSize={10} fontStyle="italic">
                  Unscheduled
                </text>
              </g>
            );
          }
          const { start, end } = datesOf(activity);
          const x1 = x(start);
          const barWidth = Math.max(6, x(end) - x1);
          const cy = row.y + row.h / 2;
          const selected = selectedId === activity.id;
          const tone = colour(row.tone);
          const broken = conflicted.has(activity.id);
          const readoutX = activity.readout_date ? x(activity.readout_date) : null;
          const insideChars = Math.floor((barWidth - 12) / 5.6);
          const barLabel = insideChars >= 6 ? truncate(TACTIC_TYPE_LABELS[activity.tactic_type], insideChars) : "";
          const dragging = drag?.id === activity.id;
          return (
            <g
              key={row.key}
              role="button"
              tabIndex={0}
              aria-label={`${activity.tactic_name}, ${start} to ${end}`}
              data-activity-id={activity.id}
              className="cursor-pointer focus:outline-none"
              onClick={() => select(activity.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(activity.id);
                }
              }}
            >
              <title>{`${activity.tactic_name} · ${start} → ${end}${activity.readout_date ? ` · readout ${activity.readout_date}` : ""}${
                editable ? " · drag to move, drag an end to resize" : ""
              }`}</title>
              <rect
                x={0}
                y={row.y}
                width={width}
                height={row.h}
                fill={selected ? tone : palette.background}
                opacity={selected ? 0.09 : index % 2 === 0 ? 0.35 : 0}
              />
              <text x={indent} y={row.y + 13} fill={palette.foreground} fontSize={11}>
                {truncate(activity.tactic_name, 40)}
              </text>
              <text x={indent} y={row.y + 25} fill={palette.muted} fontSize={9.5}>
                {`${start} → ${end}`}
              </text>
              <rect
                data-bar="body"
                x={x1}
                y={cy - BAR_H / 2}
                width={barWidth}
                height={BAR_H}
                rx={3}
                fill={tone}
                fillOpacity={activity.meta.counts_toward_addressing ? 0.28 : 0.14}
                stroke={broken ? palette.conflict : tone}
                strokeWidth={selected || dragging ? 1.8 : broken ? 1.4 : 1}
                strokeDasharray={activity.tactic_status === "proposed" ? "3 2" : undefined}
                style={editable ? { cursor: dragging ? "grabbing" : "grab" } : undefined}
                onPointerDown={(event) => beginDrag(event, activity, "move")}
              />
              {barLabel ? (
                <text x={x1 + 6} y={cy + 3.5} fill={palette.foreground} fontSize={9.5} pointerEvents="none">
                  {barLabel}
                </text>
              ) : null}
              {editable ? (
                <>
                  <rect
                    data-bar="start"
                    x={x1 - 2}
                    y={cy - BAR_H / 2}
                    width={HANDLE_W}
                    height={BAR_H}
                    fill="transparent"
                    style={{ cursor: "ew-resize" }}
                    onPointerDown={(event) => beginDrag(event, activity, "start")}
                  />
                  <rect
                    data-bar="end"
                    x={x1 + barWidth - HANDLE_W + 2}
                    y={cy - BAR_H / 2}
                    width={HANDLE_W}
                    height={BAR_H}
                    fill="transparent"
                    style={{ cursor: "ew-resize" }}
                    onPointerDown={(event) => beginDrag(event, activity, "end")}
                  />
                </>
              ) : null}
              {readoutX !== null ? (
                <polygon
                  points={`${readoutX},${cy - 5} ${readoutX + 5},${cy} ${readoutX},${cy + 5} ${readoutX - 5},${cy}`}
                  fill={palette.readout}
                  stroke={palette.background}
                  strokeWidth={0.75}
                  pointerEvents="none"
                />
              ) : null}
              {broken ? (
                <text x={x1 + barWidth + (readoutX !== null ? 14 : 6)} y={cy + 4} fill={palette.conflict} fontSize={11} fontWeight={700}>
                  !
                </text>
              ) : null}
            </g>
          );
        })}

        {arrows.map((arrow) => (
          <path
            key={arrow.key}
            data-dependency={arrow.key}
            data-broken={arrow.broken ? "true" : undefined}
            d={arrow.d}
            fill="none"
            stroke={arrow.broken ? palette.conflict : palette.muted}
            strokeWidth={arrow.broken ? 1.4 : 1}
            strokeDasharray="4 3"
            markerEnd={arrow.broken ? "url(#synapse-gap-arrow-broken)" : "url(#synapse-gap-arrow)"}
            opacity={0.9}
            pointerEvents="none"
          />
        ))}

        {view.markers.map((marker) => {
          const mx = x(marker.date);
          if (mx < LABEL_W || mx > LABEL_W + trackW) return null;
          return (
            <g key={marker.id} aria-label={`${marker.detail}: ${marker.label}, ${marker.date}`}>
              <title>{`${marker.detail}: ${marker.label} · ${marker.date}`}</title>
              <line x1={mx} y1={HEADER_H + 4} x2={mx} y2={bodyBottom} stroke={palette.readout} strokeWidth={1} strokeDasharray="1 3" />
              <polygon
                points={`${mx},${HEADER_H + 2} ${mx + 5},${HEADER_H + 8} ${mx},${HEADER_H + 14} ${mx - 5},${HEADER_H + 8}`}
                fill={marker.kind === "key_decision" ? palette.today : palette.readout}
              />
              <text x={mx + 8} y={HEADER_H + 12} fill={palette.muted} fontSize={9}>
                {truncate(marker.label, 28)}
              </text>
            </g>
          );
        })}

        {todayVisible ? (
          <g pointerEvents="none">
            <line x1={todayX} y1={HEADER_H - 12} x2={todayX} y2={bodyBottom} stroke={palette.today} strokeWidth={1} strokeDasharray="3 3" />
            <rect x={todayX - 20} y={HEADER_H - 24} width={40} height={13} rx={3} fill={palette.today} opacity={0.18} />
            <text x={todayX} y={HEADER_H - 14} fill={palette.today} fontSize={9} textAnchor="middle">
              Today
            </text>
          </g>
        ) : null}

        <g>
          {LEGEND.map((entry, index) => (
            <g key={`legend-${entry.band}`} transform={`translate(${12 + index * 116}, ${legendY})`}>
              <rect x={0} y={-7} width={14} height={9} rx={2} fill={colour(entry.band)} fillOpacity={0.28} stroke={colour(entry.band)} />
              <text x={20} y={1} fill={palette.muted} fontSize={9.5}>
                {entry.label}
              </text>
            </g>
          ))}
          <g transform={`translate(${12 + LEGEND.length * 116}, ${legendY})`}>
            <polygon points="5,-8 10,-3 5,2 0,-3" fill={palette.readout} />
            <text x={16} y={1} fill={palette.muted} fontSize={9.5}>
              Readout
            </text>
          </g>
          <g transform={`translate(${12 + LEGEND.length * 116 + 72}, ${legendY})`}>
            <path d="M 0 -3 H 16" stroke={palette.muted} strokeWidth={1} strokeDasharray="4 3" markerEnd="url(#synapse-gap-arrow)" />
            <text x={26} y={1} fill={palette.muted} fontSize={9.5}>
              Depends on
            </text>
          </g>
          <g transform={`translate(${12 + LEGEND.length * 116 + 164}, ${legendY})`}>
            <path d="M 0 -3 H 16" stroke={palette.conflict} strokeWidth={1.4} strokeDasharray="4 3" markerEnd="url(#synapse-gap-arrow-broken)" />
            <text x={26} y={1} fill={palette.muted} fontSize={9.5}>
              Broken dependency
            </text>
          </g>
          <g transform={`translate(${12 + LEGEND.length * 116 + 286}, ${legendY})`}>
            <polygon points="5,-9 10,-4 5,1 0,-4" fill={palette.today} />
            <text x={16} y={1} fill={palette.muted} fontSize={9.5}>
              Key decision
            </text>
          </g>
          <text x={12 + LEGEND.length * 116 + 380} y={legendY + 1} fill={palette.muted} fontSize={9.5}>
            Dashed bar outline = proposed tactic
          </text>
        </g>
      </svg>

      {/* Controls sit over the chart, row-aligned, so the PNG export carries none of them. */}
      <div className="pointer-events-none absolute inset-0">
        {rows.map((row) => {
          if (row.kind === "section" && row.section === "not_prioritized") {
            return (
              <div key={row.key} className="pointer-events-auto absolute left-1" style={{ top: row.y + 3 }}>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-expanded={showNotPrioritized}
                  aria-label={showNotPrioritized ? "Collapse not prioritized gaps" : "Show not prioritized gaps"}
                  onClick={() => setShowNotPrioritized((open) => !open)}
                >
                  {showNotPrioritized ? <ChevronDown /> : <ChevronRight />}
                </Button>
              </div>
            );
          }
          if (!editable) return null;
          if (row.kind === "gap") {
            const group = row.group;
            const undated = group.items.filter((item) => !item.activity);
            return (
              <div key={row.key} data-testid={`gap-actions-${group.gap_id}`}>
                {canCreate ? (
                  <div className="pointer-events-auto absolute" style={{ top: row.y + 4, left: LABEL_W - 96 }}>
                    <CreateActivityDialog identity={identity} gap={group} />
                  </div>
                ) : null}
                {!group.start ? (
                  <div className="pointer-events-auto absolute" style={{ top: row.y + 4, left: LABEL_W + 84 }}>
                    {undated.length > 0 ? (
                      <ManualDatesDialog
                        identity={identity}
                        tactics={undated.map((item) => ({ tactic_id: item.tactic_id, name: item.tactic_name }))}
                        label="Set dates"
                        title={`Set dates for an activity under ${group.gap_name}`}
                        small
                      />
                    ) : canCreate ? (
                      <CreateActivityDialog identity={identity} gap={group} label="Set dates" />
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          }
          if (row.kind === "item" && !row.item.activity) {
            return (
              <div
                key={row.key}
                data-testid={`item-actions-${row.item.key}`}
                className="pointer-events-auto absolute flex gap-1"
                style={{ top: row.y + 3, left: LABEL_W + 84 }}
              >
                <ManualDatesDialog
                  identity={identity}
                  tacticId={row.item.tactic_id}
                  label="Set dates"
                  title={`Set dates for ${row.item.tactic_name}`}
                  small
                />
                <ActionDialog
                  endpoint="/api/plan"
                  payload={{ action: "remove_activity", id: row.item.activity_id }}
                  label="Remove"
                  title={`Remove ${row.item.tactic_name} from the timeline`}
                  description="It stays off on every rebuild until someone adds it back. The tactic itself is not changed."
                  confirmLabel="Remove"
                  identity={identity}
                  trigger={<Button size="xs" variant="ghost" />}
                />
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
