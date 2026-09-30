import { BREAKOUTS_ENABLED } from "@/lib/breakouts-enabled";
import { redirect } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import {
  BreakoutsOverview,
  type BreakoutGapRow,
  type BreakoutGroupRow,
  type ThemePreview,
} from "@/components/breakouts/breakouts-overview";
import { BREAKOUT_THEMES, BREAKOUT_THEME_LABELS, themeBuckets } from "@/lib/iegp/breakout-themes";
import { isLiveGap } from "@/lib/iegp/engine";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

export const dynamic = "force-dynamic";

const PRIORITY_LABELS: Record<string, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  defer: "Deferred",
};

export default async function BreakoutsPage() {
  if (!BREAKOUTS_ENABLED) redirect("/");
  const [state, placements] = await Promise.all([loadState(), listPlacements().catch(() => [])]);
  const bands = new Map(placements.filter((row) => row.validated && row.band).map((row) => [row.gap_id, row.band!]));
  const groupsOf = (gapId: string) =>
    state.breakout_group_gaps.filter((row) => row.gap_id === gapId).map((row) => row.group_id);

  const gaps: BreakoutGapRow[] = state.gaps.filter(isLiveGap).map((gap) => ({
    id: gap.id,
    name: gap.name,
    domain: DOMAIN_LABELS[gap.domain],
    settings: gap.settings,
    priority: PRIORITY_LABELS[bands.get(gap.id) ?? ""] ?? "Not prioritized",
    group_ids: groupsOf(gap.id),
  }));
  const live = new Set(gaps.map((gap) => gap.id));
  const groups: BreakoutGroupRow[] = state.breakout_groups.map((group) => ({
    id: group.id,
    name: group.name,
    note: group.note,
    gap_ids: state.breakout_group_gaps.filter((row) => row.group_id === group.id && live.has(row.gap_id)).map((row) => row.gap_id),
  }));
  const grouped = new Set(gaps.filter((gap) => gap.group_ids.length > 0).map((gap) => gap.id));
  const themes: ThemePreview[] = await Promise.all(
    BREAKOUT_THEMES.map(async (theme) => ({
      theme,
      label: BREAKOUT_THEME_LABELS[theme],
      buckets: (await themeBuckets(theme, state)).map((bucket) => ({
        label: bucket.label,
        count: bucket.gap_ids.length,
        unassigned: bucket.gap_ids.filter((id) => !grouped.has(id)).length,
      })),
    })),
  );

  return (
    <AppShell active="breakouts">
      <PageIntro kicker="Workshop day" title="Breakout groups">
        Split the gaps into groups for the workshop: create a group by hand, or group the gaps by domain, treatment
        setting or priority in one step. Open a group to work its gaps; open it in a new window so another consultant
        can facilitate it on their own screen.
      </PageIntro>
      <BreakoutsOverview groups={groups} gaps={gaps} themes={themes} />
    </AppShell>
  );
}
