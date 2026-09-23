export type GanttTacticInput = {
  id: string;
  validated: boolean;
  start?: string | null;
  end?: string | null;
  /** Evidence-available / readout date from parse or user entry — never synthesized. */
  readout?: string | null;
  /** Other tactic ids this bar waits on. */
  depends_on?: string[];
  tactic_type?: string | null;
  /** Fallback gap ids when coverage joins are not supplied. */
  gap_ids?: string[];
};

export type GanttCoverageJoin = {
  gap_id: string;
  tactic_id: string;
  overall: string;
  validated: boolean;
};

export type GanttGapInput = {
  id: string;
  parent_gap_id?: string | null;
  validated?: boolean;
};

export type GanttActivityOverride = {
  id?: string;
  tactic_id: string;
  start?: string;
  end?: string;
  readout?: string | null;
  depends_on?: string[];
};

export type GanttActivity = {
  id: string;
  tactic_id: string;
  start: string;
  end: string;
  readout: string | null;
  depends_on: string[];
  gap_ids: string[];
};

/** Dissemination waits on generating work that covers the same gap. */
export const GANTT_DISSEMINATION_TYPES = new Set([
  "publication",
  "congress_abstract",
  "evidence_dissemination",
]);

const NON_COUNTING_OVERALL = new Set(["not_relevant", "none", "unknown", ""]);

export function activityIdForTactic(tacticId: string): string {
  return `ACT-${tacticId}`;
}

export function coverageCountsTowardGantt(
  overall: string | null | undefined,
  validated: boolean,
): boolean {
  if (!validated) return false;
  const key = (overall ?? "").trim().toLowerCase();
  if (!key) return false;
  return !NON_COUNTING_OVERALL.has(key);
}

function dayMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function fromDayMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function maxDate(dates: string[]): string | null {
  const valid = dates.filter(Boolean).sort();
  return valid.length ? valid[valid.length - 1]! : null;
}

function normalizeDependsOn(
  dependsOn: string[] | undefined,
  tacticIds: Set<string>,
): string[] {
  if (!dependsOn?.length) return [];
  const mapped = dependsOn.map((ref) => {
    if (ref.startsWith("ACT-")) return ref;
    if (tacticIds.has(ref)) return activityIdForTactic(ref);
    return ref;
  });
  return [...new Set(mapped)].sort();
}

function uniqueSorted(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))].sort();
}

/** Gate a successor waits on: sourced readout, else the bar end. Does not invent a lag. */
export function activityGateDate(activity: Pick<GanttActivity, "readout" | "end">): string {
  const readout = activity.readout?.trim();
  return readout ? readout.slice(0, 10) : activity.end.slice(0, 10);
}

function shiftToGate(
  activity: GanttActivity,
  gate: string,
): Pick<GanttActivity, "start" | "end" | "readout"> {
  const startMs = dayMs(activity.start);
  const gateMs = dayMs(gate);
  const delta = gateMs - startMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(gateMs) || delta <= 0) {
    return { start: activity.start, end: activity.end, readout: activity.readout };
  }
  const endMs = dayMs(activity.end);
  const nextEnd = Number.isFinite(endMs) ? fromDayMs(endMs + delta) : activity.end;
  let nextReadout = activity.readout;
  if (activity.readout) {
    const readoutMs = dayMs(activity.readout);
    nextReadout = Number.isFinite(readoutMs)
      ? fromDayMs(readoutMs + delta)
      : activity.readout;
  }
  return { start: fromDayMs(gateMs), end: nextEnd, readout: nextReadout };
}

/** Activities that participate in a dependency cycle (Kahn leftover). */
function cyclicActivityIds(activities: GanttActivity[]): Set<string> {
  const ids = new Set(activities.map((row) => row.id));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, 0);
    outgoing.set(id, []);
  }
  for (const activity of activities) {
    for (const upstreamId of activity.depends_on) {
      if (!ids.has(upstreamId)) continue;
      outgoing.get(upstreamId)!.push(activity.id);
      incoming.set(activity.id, (incoming.get(activity.id) ?? 0) + 1);
    }
  }
  const queue = [...ids].filter((id) => incoming.get(id) === 0).sort();
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    seen.add(id);
    for (const next of (outgoing.get(id) ?? []).slice().sort()) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  return new Set([...ids].filter((id) => !seen.has(id)));
}

function gapIdsForTactic(
  tactic: GanttTacticInput,
  coverages: GanttCoverageJoin[] | undefined,
): string[] {
  if (coverages) {
    return uniqueSorted(
      coverages
        .filter(
          (row) =>
            row.tactic_id === tactic.id &&
            coverageCountsTowardGantt(row.overall, row.validated),
        )
        .map((row) => row.gap_id),
    );
  }
  return uniqueSorted(tactic.gap_ids ?? []);
}

function inferCoverageDependencies(args: {
  activities: Array<GanttActivity & { tactic_type: string | null }>;
  gaps: GanttGapInput[];
}): Map<string, string[]> {
  const inferred = new Map<string, string[]>();
  const parentByGap = new Map(
    args.gaps
      .filter((gap) => gap.parent_gap_id)
      .map((gap) => [gap.id, gap.parent_gap_id as string]),
  );

  for (const activity of args.activities) {
    const deps = new Set<string>();
    const isDissemination = GANTT_DISSEMINATION_TYPES.has(activity.tactic_type ?? "");
    if (isDissemination) {
      for (const other of args.activities) {
        if (other.id === activity.id) continue;
        if (GANTT_DISSEMINATION_TYPES.has(other.tactic_type ?? "")) continue;
        if (other.gap_ids.some((gapId) => activity.gap_ids.includes(gapId))) {
          deps.add(other.id);
        }
      }
    }
    for (const gapId of activity.gap_ids) {
      const parentId = parentByGap.get(gapId);
      if (!parentId) continue;
      for (const other of args.activities) {
        if (other.id === activity.id) continue;
        if (other.gap_ids.includes(parentId)) deps.add(other.id);
      }
    }
    inferred.set(activity.id, [...deps].sort());
  }
  return inferred;
}

function applyDateContinuity(activities: GanttActivity[]): void {
  const byId = new Map(activities.map((row) => [row.id, row]));
  const cyclic = cyclicActivityIds(activities);
  let changed = true;
  let guard = activities.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    const ordered = [...activities].sort((a, b) => a.id.localeCompare(b.id));
    for (const activity of ordered) {
      if (cyclic.has(activity.id)) continue;
      const upstreams = activity.depends_on
        .map((id) => byId.get(id))
        .filter((row): row is GanttActivity => row != null && !cyclic.has(row.id));
      if (upstreams.length === 0) continue;
      const gate = maxDate(upstreams.map(activityGateDate));
      if (!gate || gate <= activity.start.slice(0, 10)) continue;
      const shifted = shiftToGate(activity, gate);
      if (
        shifted.start !== activity.start ||
        shifted.end !== activity.end ||
        shifted.readout !== activity.readout
      ) {
        activity.start = shifted.start;
        activity.end = shifted.end;
        activity.readout = shifted.readout;
        changed = true;
      }
    }
  }
}

/** True when every successor starts on or after each resolvable upstream gate. */
export function dependenciesRespectReadouts(activities: GanttActivity[]): boolean {
  const byId = new Map(activities.map((row) => [row.id, row]));
  const cyclic = cyclicActivityIds(activities);
  for (const activity of activities) {
    if (cyclic.has(activity.id)) continue;
    for (const upstreamId of activity.depends_on) {
      const upstream = byId.get(upstreamId);
      if (!upstream || cyclic.has(upstream.id)) continue;
      if (activity.start.slice(0, 10) < activityGateDate(upstream)) return false;
    }
  }
  return true;
}

/**
 * Deterministic Gantt projection from validated tactics only.
 * Does not synthesize bars or dates — tactics without start+end are omitted.
 * Coverage joins and explicit depends_on keep successor bars/readouts continuous
 * by shifting (never inventing) sourced timing.
 */
export function projectGanttFromTactics(args: {
  tactics: GanttTacticInput[];
  activities?: GanttActivityOverride[];
  coverages?: GanttCoverageJoin[];
  gaps?: GanttGapInput[];
}): GanttActivity[] {
  const tacticIds = new Set(args.tactics.map((t) => t.id));
  const overrideByTactic = new Map(
    (args.activities ?? []).map((row) => [row.tactic_id, row]),
  );
  const tacticTypeById = new Map(
    args.tactics.map((t) => [t.id, t.tactic_type ?? null]),
  );

  const working: Array<GanttActivity & { tactic_type: string | null }> = [];
  const sortedTactics = [...args.tactics].sort((a, b) => a.id.localeCompare(b.id));

  for (const tactic of sortedTactics) {
    if (!tactic.validated) continue;

    const override = overrideByTactic.get(tactic.id);
    const start = override?.start ?? tactic.start ?? null;
    const end = override?.end ?? tactic.end ?? null;
    if (!start || !end) continue;

    const readoutSource =
      override && "readout" in override ? override.readout : tactic.readout;
    const readout = readoutSource?.trim() ? readoutSource.trim() : null;

    working.push({
      id: override?.id ?? activityIdForTactic(tactic.id),
      tactic_id: tactic.id,
      start,
      end,
      readout,
      depends_on: normalizeDependsOn(override?.depends_on ?? tactic.depends_on, tacticIds),
      gap_ids: gapIdsForTactic(tactic, args.coverages),
      tactic_type: tacticTypeById.get(tactic.id) ?? null,
    });
  }

  const inferred = inferCoverageDependencies({
    activities: working,
    gaps: args.gaps ?? [],
  });
  for (const activity of working) {
    activity.depends_on = uniqueSorted([
      ...activity.depends_on,
      ...(inferred.get(activity.id) ?? []),
    ]);
  }

  applyDateContinuity(working);

  const projected: GanttActivity[] = working.map(
    ({ tactic_type: _tacticType, ...activity }) => activity,
  );

  return projected.sort(
    (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
  );
}

export function assertActivitiesHaveTacticId(
  activities: { tactic_id?: string | null | undefined }[],
): void {
  for (const [index, row] of activities.entries()) {
    const id = row.tactic_id?.trim();
    if (!id) {
      throw new Error(`Activity at index ${index} is missing tactic_id`);
    }
  }
}

/**
 * Save-final guard: every bar must bind to a validated tactic id.
 * Rejects invented or draft-only bindings before a snapshot is persisted.
 */
export function assertSaveFinalActivities(
  activities: GanttActivity[],
  validatedTacticIds: Iterable<string>,
): void {
  const allowed = new Set(
    [...validatedTacticIds].map((id) => id.trim()).filter(Boolean),
  );
  if (activities.length === 0) {
    throw new Error("Cannot save final: no activities projected from validated tactics");
  }
  for (const [index, row] of activities.entries()) {
    const tacticId = row.tactic_id?.trim();
    if (!tacticId) {
      throw new Error(`Activity at index ${index} is missing tactic_id`);
    }
    if (!allowed.has(tacticId)) {
      throw new Error(
        `Activity ${row.id} binds to tactic ${tacticId} which is not validated`,
      );
    }
  }
}
