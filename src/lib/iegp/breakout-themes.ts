import { isLiveGap } from "@/lib/iegp/engine";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { assignGapsToBreakoutGroup, createBreakoutGroup, loadState } from "@/lib/iegp/store";
import type { ActorFunction } from "@/lib/iegp/enums";
import type { IegpState } from "@/lib/iegp/types";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

/** The themes a workshop can be split by (owner feedback, KAN-55). */
export const BREAKOUT_THEMES = ["domain", "setting", "priority"] as const;
export type BreakoutTheme = (typeof BREAKOUT_THEMES)[number];

export const BREAKOUT_THEME_LABELS: Record<BreakoutTheme, string> = {
  domain: "Evidence domain",
  setting: "Treatment setting",
  priority: "Priority",
};

const PRIORITY_LABELS: Record<string, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  defer: "Deferred",
};

/** Each theme value with the live gaps in it. A gap with several settings is in each. */
export async function themeBuckets(
  theme: BreakoutTheme,
  state?: IegpState,
): Promise<{ label: string; gap_ids: string[] }[]> {
  const live = (state ?? (await loadState())).gaps.filter(isLiveGap);
  const buckets = new Map<string, string[]>();
  const add = (label: string, id: string) => buckets.set(label, [...(buckets.get(label) ?? []), id]);
  if (theme === "domain") {
    for (const gap of live) add(DOMAIN_LABELS[gap.domain], gap.id);
  } else if (theme === "setting") {
    for (const gap of live) {
      if (gap.settings.length === 0) add("No setting", gap.id);
      for (const tag of gap.settings) add(tag, gap.id);
    }
  } else {
    const bands = new Map((await listPlacements()).filter((row) => row.validated && row.band).map((row) => [row.gap_id, row.band!]));
    for (const gap of live) add(PRIORITY_LABELS[bands.get(gap.id) ?? ""] ?? "Not prioritized", gap.id);
  }
  return [...buckets.entries()]
    .map(([label, gap_ids]) => ({ label, gap_ids }))
    .sort((a, b) => b.gap_ids.length - a.gap_ids.length || a.label.localeCompare(b.label));
}

/**
 * One breakout group per theme value, each starting with its gaps. A value that already has
 * a group of the same name gets the gaps added to it rather than a second group.
 */
export async function createBreakoutGroupsByTheme(args: {
  theme: BreakoutTheme;
  only_unassigned: boolean;
  actor_name: string;
  actor_function: ActorFunction;
}): Promise<{ created: number; assigned: number }> {
  const state = await loadState();
  const grouped = new Set(state.breakout_group_gaps.map((row) => row.gap_id));
  let created = 0;
  let assigned = 0;
  for (const bucket of await themeBuckets(args.theme, state)) {
    const gap_ids = args.only_unassigned ? bucket.gap_ids.filter((id) => !grouped.has(id)) : bucket.gap_ids;
    if (gap_ids.length === 0) continue;
    let group = state.breakout_groups.find((row) => row.name.toLowerCase() === bucket.label.toLowerCase())?.id;
    if (!group) {
      group = await createBreakoutGroup({
        name: bucket.label,
        note: `${BREAKOUT_THEME_LABELS[args.theme]}: ${bucket.label}`,
        actor_name: args.actor_name,
        actor_function: args.actor_function,
      });
      created += 1;
    }
    assigned += await assignGapsToBreakoutGroup({
      group_id: group,
      gap_ids,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
    });
  }
  return { created, assigned };
}
