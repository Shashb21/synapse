"use client";

import { useMemo, type RefObject } from "react";
import type { TimelineActivity, TimelineBand, TimelineModel } from "@/modules/stages/s10-timeline/build";
import { TACTIC_TYPE_LABELS } from "@/lib/iegp/enums";

const LABEL_W = 184;
const HEADER_H = 46;
const LANE_H = 24;
const ROW_H = 34;
const BAR_H = 15;
const PAD_R = 28;
const PAD_B = 10;
const LEGEND_H = 30;

const BANDS: TimelineBand[] = ["high", "medium", "low", "addressed"];

/**
 * Colours are read from the app's CSS tokens at mount so the chart matches the
 * rest of the UI, but they are written onto the SVG as literal attributes: the
 * PNG export serialises this node on its own, with no stylesheet attached.
 */
const FALLBACK = {
  high: "#fb7185",
  medium: "#fbbf24",
  low: "#38bdf8",
  addressed: "#4ade80",
  readout: "#60a5fa",
  today: "#c084fc",
  grid: "#2e2e2e",
  card: "#1e1e1e",
  background: "#181818",
  foreground: "#e4e4e4",
  muted: "#8c8c8c",
};

type Palette = typeof FALLBACK;

const TOKENS: Record<keyof Palette, string> = {
  high: "--chart-5",
  medium: "--chart-4",
  low: "--chart-3",
  addressed: "--known",
  readout: "--opportunity",
  today: "--chart-2",
  grid: "--border",
  card: "--card",
  background: "--background",
  foreground: "--foreground",
  muted: "--muted-foreground",
};

/**
 * Read once at render. The fallbacks mirror the token values in `globals.css`, so
 * the server and client agree; a retheme only changes what the browser paints.
 */
function readPalette(): Palette {
  if (typeof document === "undefined") return FALLBACK;
  const computed = getComputedStyle(document.documentElement);
  const next = { ...FALLBACK };
  for (const key of Object.keys(TOKENS) as (keyof Palette)[]) {
    const value = computed.getPropertyValue(TOKENS[key]).trim();
    if (value) next[key] = value;
  }
  return next;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string) {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return { year: year ?? 2026, month: month ?? 1, day: day ?? 1 };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Position of a date in months (fractional) from the first day of the window month. */
function monthPos(originIso: string, iso: string) {
  const origin = parts(originIso);
  const target = parts(iso);
  const whole = (target.year - origin.year) * 12 + (target.month - origin.month);
  return whole + (target.day - 1) / daysInMonth(target.year, target.month);
}

function monthAt(originIso: string, index: number) {
  const origin = parts(originIso);
  const zero = origin.month - 1 + index;
  return { year: origin.year + Math.floor(zero / 12), month: (((zero % 12) + 12) % 12) + 1 };
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function monthWidthFor(months: number) {
  if (months <= 8) return 94;
  if (months <= 14) return 72;
  if (months <= 24) return 52;
  if (months <= 40) return 38;
  return 28;
}

export type ChartRow = {
  kind: "lane" | "activity" | "empty";
  y: number;
  height: number;
  lane: TimelineBand;
  label: string;
  count?: number;
  activity?: TimelineActivity;
};

function buildRows(model: TimelineModel): ChartRow[] {
  const rows: ChartRow[] = [];
  let y = HEADER_H;
  for (const band of BANDS) {
    const lane = model.lanes.find((candidate) => candidate.id === band);
    const activities = model.activities
      .filter((activity) => activity.lane === band)
      .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.tactic_name.localeCompare(b.tactic_name));
    rows.push({
      kind: "lane",
      y,
      height: LANE_H,
      lane: band,
      label: lane?.label ?? band,
      count: activities.length,
    });
    y += LANE_H;
    if (activities.length === 0) {
      rows.push({ kind: "empty", y, height: ROW_H - 8, lane: band, label: "No activities in this lane" });
      y += ROW_H - 8;
      continue;
    }
    for (const activity of activities) {
      rows.push({ kind: "activity", y, height: ROW_H, lane: band, label: activity.tactic_name, activity });
      y += ROW_H;
    }
  }
  return rows;
}

export function GanttChart({
  model,
  today,
  selectedId,
  onSelect,
  svgRef,
}: {
  model: TimelineModel;
  today: string;
  selectedId: string | null;
  onSelect: (activity: TimelineActivity) => void;
  svgRef: RefObject<SVGSVGElement | null>;
}) {
  const palette = useMemo(() => readPalette(), []);
  const origin = model.window.start;
  const months = Math.max(1, model.window.months);
  const monthWidth = monthWidthFor(months);
  const rows = useMemo(() => buildRows(model), [model]);
  const bodyHeight = rows.reduce((sum, row) => sum + row.height, 0);
  const width = LABEL_W + months * monthWidth + PAD_R;
  const height = HEADER_H + bodyHeight + PAD_B + LEGEND_H;

  const x = (iso: string) => LABEL_W + monthPos(origin, iso) * monthWidth;
  const bandColour = (band: TimelineBand) => palette[band];

  const geometry = new Map<string, { x1: number; x2: number; cy: number }>();
  for (const row of rows) {
    if (row.kind !== "activity" || !row.activity) continue;
    const x1 = x(row.activity.start_date);
    const x2 = Math.max(x1 + 6, x(row.activity.end_date));
    geometry.set(row.activity.id, { x1, x2, cy: row.y + 11 });
  }

  const todayX = x(today);
  const todayVisible = todayX >= LABEL_W && todayX <= LABEL_W + months * monthWidth;

  const dependencyPaths: { key: string; d: string }[] = [];
  for (const row of rows) {
    const activity = row.kind === "activity" ? row.activity : undefined;
    if (!activity) continue;
    const target = geometry.get(activity.id);
    if (!target) continue;
    for (const upstreamId of activity.depends_on) {
      const source = geometry.get(upstreamId);
      if (!source) continue;
      const turn =
        target.x1 - 10 > source.x2 + 10 ? source.x2 + Math.max(10, (target.x1 - source.x2) / 2) : source.x2 + 10;
      dependencyPaths.push({
        key: `${upstreamId}->${activity.id}`,
        d: `M ${source.x2} ${source.cy} H ${turn} V ${target.cy} H ${target.x1 - 6}`,
      });
    }
  }

  const legendY = HEADER_H + bodyHeight + PAD_B + 12;

  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Gantt timeline with ${model.activities.length} activities from ${model.window.start} to ${model.window.end}`}
      style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" }}
    >
      <defs>
        <marker id="synapse-dep-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M 0 0 L 7 3.5 L 0 7 z" fill={palette.muted} />
        </marker>
      </defs>
      <rect x={0} y={0} width={width} height={height} fill={palette.background} />

      {/* Ruler: quarters over months */}
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
              y2={HEADER_H + bodyHeight}
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
      <line
        x1={0}
        y1={HEADER_H - 2}
        x2={width}
        y2={HEADER_H - 2}
        stroke={palette.grid}
        strokeWidth={1}
      />
      <line x1={LABEL_W} y1={4} x2={LABEL_W} y2={HEADER_H + bodyHeight} stroke={palette.grid} strokeWidth={1} />
      <text x={8} y={37} fill={palette.muted} fontSize={10}>
        Activity · gap
      </text>

      {/* Lane bands and rows */}
      {rows.map((row, index) => {
        if (row.kind === "lane") {
          return (
            <g key={`lane-${row.lane}`}>
              <rect x={0} y={row.y} width={width} height={row.height} fill={palette.card} />
              <rect x={0} y={row.y} width={3} height={row.height} fill={bandColour(row.lane)} />
              <text x={10} y={row.y + 16} fill={palette.foreground} fontSize={11} letterSpacing={0.3}>
                {row.label.toUpperCase()}
              </text>
              <text x={LABEL_W - 12} y={row.y + 16} fill={palette.muted} fontSize={10} textAnchor="end">
                {row.count === 1 ? "1 activity" : `${row.count} activities`}
              </text>
            </g>
          );
        }
        if (row.kind === "empty") {
          return (
            <text
              key={`empty-${row.lane}`}
              x={12}
              y={row.y + 15}
              fill={palette.muted}
              fontSize={10}
              fontStyle="italic"
            >
              {row.label}
            </text>
          );
        }
        const activity = row.activity!;
        const geo = geometry.get(activity.id)!;
        const selected = selectedId === activity.id;
        const barWidth = Math.max(6, geo.x2 - geo.x1);
        const readoutX = activity.readout_date ? x(activity.readout_date) : null;
        const insideChars = Math.floor((barWidth - 12) / 5.6);
        const barLabel = insideChars >= 6 ? truncate(TACTIC_TYPE_LABELS[activity.tactic_type], insideChars) : "";
        return (
          <g
            key={activity.id}
            role="button"
            tabIndex={0}
            aria-label={`${activity.tactic_name}, ${activity.start_date} to ${activity.end_date}`}
            className="cursor-pointer focus:outline-none"
            onClick={() => onSelect(activity)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(activity);
              }
            }}
          >
            <title>{`${activity.tactic_name} · ${activity.start_date} → ${activity.end_date}${
              activity.readout_date ? ` · readout ${activity.readout_date}` : ""
            }`}</title>
            <rect
              x={0}
              y={row.y}
              width={width}
              height={row.height}
              fill={selected ? bandColour(row.lane) : palette.background}
              opacity={selected ? 0.09 : index % 2 === 0 ? 0.35 : 0}
            />
            <text x={12} y={row.y + 13} fill={palette.foreground} fontSize={11}>
              {truncate(activity.tactic_name, 27)}
            </text>
            <text x={12} y={row.y + 25} fill={palette.muted} fontSize={9.5}>
              {truncate(
                activity.gap_names.length > 1
                  ? `${activity.gap_names[0]} +${activity.gap_names.length - 1}`
                  : (activity.gap_names[0] ?? "No gap"),
                32,
              )}
            </text>
            <rect
              x={geo.x1}
              y={row.y + 11 - BAR_H / 2}
              width={barWidth}
              height={BAR_H}
              rx={3}
              fill={bandColour(row.lane)}
              fillOpacity={activity.meta.counts_toward_addressing ? 0.28 : 0.14}
              stroke={bandColour(row.lane)}
              strokeWidth={selected ? 1.8 : 1}
              strokeDasharray={activity.tactic_status === "proposed" ? "3 2" : undefined}
            />
            {barLabel ? (
              <text x={geo.x1 + 6} y={row.y + 15} fill={palette.foreground} fontSize={9.5}>
                {barLabel}
              </text>
            ) : null}
            {readoutX !== null ? (
              <g>
                {readoutX > geo.x2 + 2 ? (
                  <line
                    x1={geo.x2}
                    y1={geo.cy}
                    x2={readoutX - 4}
                    y2={geo.cy}
                    stroke={palette.readout}
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    opacity={0.8}
                  />
                ) : null}
                <polygon
                  points={`${readoutX},${geo.cy - 5} ${readoutX + 5},${geo.cy} ${readoutX},${geo.cy + 5} ${readoutX - 5},${geo.cy}`}
                  fill={palette.readout}
                  stroke={palette.background}
                  strokeWidth={0.75}
                />
              </g>
            ) : null}
            <text x={geo.x2 + (readoutX !== null ? 16 : 8)} y={row.y + 25} fill={palette.muted} fontSize={9}>
              {activity.readout_date ? `readout ${activity.readout_date.slice(0, 7)}` : activity.end_date.slice(0, 7)}
            </text>
          </g>
        );
      })}

      {/* Interdependencies */}
      {dependencyPaths.map((path) => (
        <path
          key={path.key}
          d={path.d}
          fill="none"
          stroke={palette.muted}
          strokeWidth={1}
          strokeDasharray="4 3"
          markerEnd="url(#synapse-dep-arrow)"
          opacity={0.85}
        />
      ))}

      {todayVisible ? (
        <g>
          <line
            x1={todayX}
            y1={HEADER_H - 12}
            x2={todayX}
            y2={HEADER_H + bodyHeight}
            stroke={palette.today}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <rect x={todayX - 20} y={HEADER_H - 24} width={40} height={13} rx={3} fill={palette.today} opacity={0.18} />
          <text x={todayX} y={HEADER_H - 14} fill={palette.today} fontSize={9} textAnchor="middle">
            Today
          </text>
        </g>
      ) : null}

      {/* Legend travels with the exported image */}
      <g>
        {BANDS.map((band, index) => (
          <g key={`legend-${band}`} transform={`translate(${12 + index * 116}, ${legendY})`}>
            <rect x={0} y={-7} width={14} height={9} rx={2} fill={bandColour(band)} fillOpacity={0.28} stroke={bandColour(band)} />
            <text x={20} y={1} fill={palette.muted} fontSize={9.5}>
              {band === "addressed" ? "Addressed" : `${band[0]!.toUpperCase()}${band.slice(1)} priority`}
            </text>
          </g>
        ))}
        <g transform={`translate(${12 + 4 * 116}, ${legendY})`}>
          <polygon points="5,-8 10,-3 5,2 0,-3" fill={palette.readout} />
          <text x={16} y={1} fill={palette.muted} fontSize={9.5}>
            Readout
          </text>
        </g>
        <g transform={`translate(${12 + 4 * 116 + 80}, ${legendY})`}>
          <path d="M 0 -3 H 16" stroke={palette.muted} strokeWidth={1} strokeDasharray="4 3" markerEnd="url(#synapse-dep-arrow)" />
          <text x={26} y={1} fill={palette.muted} fontSize={9.5}>
            Depends on
          </text>
        </g>
        <text x={12 + 4 * 116 + 190} y={legendY + 1} fill={palette.muted} fontSize={9.5}>
          Dashed bar outline = proposed tactic
        </text>
      </g>
    </svg>
  );
}
