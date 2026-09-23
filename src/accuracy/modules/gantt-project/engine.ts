export type GanttTacticInput = {
  id: string;
  validated: boolean;
  start?: string | null;
  end?: string | null;
  /** Other tactic ids this bar waits on. */
  depends_on?: string[];
};

export type GanttActivityOverride = {
  id?: string;
  tactic_id: string;
  start?: string;
  end?: string;
  depends_on?: string[];
};

export type GanttActivity = {
  id: string;
  tactic_id: string;
  start: string;
  end: string;
  depends_on: string[];
};

export function activityIdForTactic(tacticId: string): string {
  return `ACT-${tacticId}`;
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

/**
 * Deterministic Gantt projection from validated tactics only.
 * Does not synthesize bars or dates — tactics without start+end are omitted.
 */
export function projectGanttFromTactics(args: {
  tactics: GanttTacticInput[];
  activities?: GanttActivityOverride[];
}): GanttActivity[] {
  const tacticById = new Map(args.tactics.map((t) => [t.id, t]));
  const tacticIds = new Set(args.tactics.map((t) => t.id));
  const overrideByTactic = new Map(
    (args.activities ?? []).map((row) => [row.tactic_id, row]),
  );

  const projected: GanttActivity[] = [];

  const sortedTactics = [...args.tactics].sort((a, b) => a.id.localeCompare(b.id));

  for (const tactic of sortedTactics) {
    if (!tactic.validated) continue;

    const override = overrideByTactic.get(tactic.id);
    const start = override?.start ?? tactic.start ?? null;
    const end = override?.end ?? tactic.end ?? null;
    if (!start || !end) continue;

    const dependsSource = override?.depends_on ?? tactic.depends_on;
    projected.push({
      id: override?.id ?? activityIdForTactic(tactic.id),
      tactic_id: tactic.id,
      start,
      end,
      depends_on: normalizeDependsOn(dependsSource, tacticIds),
    });
  }

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
