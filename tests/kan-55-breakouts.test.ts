import { beforeAll, describe, expect, it } from "vitest";
import "@/modules";
import {
  assignGapsToBreakoutGroup,
  createBreakoutGroup,
  loadState,
  moveGapToBreakoutGroup,
  resetDemo,
  updateBreakoutGroup,
} from "@/lib/iegp/store";
import { isLiveGap } from "@/lib/iegp/engine";
import { createBreakoutGroupsByTheme, themeBuckets } from "@/lib/iegp/breakout-themes";

const ACTOR = { actor_name: "Breakout Test", actor_function: "medical_affairs" as const };

describe("breakout groups (KAN-55)", () => {
  let liveIds: string[] = [];

  beforeAll(async () => {
    await resetDemo();
    liveIds = (await loadState()).gaps.filter(isLiveGap).map((gap) => gap.id);
    expect(liveIds.length).toBeGreaterThan(3);
  }, 60_000);

  it("adds several gaps at once, skipping ones already in the group, and refuses an unknown gap", async () => {
    const group = await createBreakoutGroup({ name: "Payer evidence", ...ACTOR });
    expect(await assignGapsToBreakoutGroup({ group_id: group, gap_ids: liveIds.slice(0, 3), ...ACTOR })).toBe(3);
    expect(await assignGapsToBreakoutGroup({ group_id: group, gap_ids: liveIds.slice(0, 4), ...ACTOR })).toBe(1);
    await expect(assignGapsToBreakoutGroup({ group_id: group, gap_ids: ["GAP-NOPE"], ...ACTOR })).rejects.toThrow(/not found/);
  });

  it("renames a group and moves a gap to another group", async () => {
    const a = await createBreakoutGroup({ name: "Group A", ...ACTOR });
    const b = await createBreakoutGroup({ name: "Group B", ...ACTOR });
    await updateBreakoutGroup({ group_id: a, name: "Group A renamed", note: "Covers HTA", ...ACTOR });
    await expect(updateBreakoutGroup({ group_id: a, name: " ", ...ACTOR })).rejects.toThrow(/needs a name/);
    await assignGapsToBreakoutGroup({ group_id: a, gap_ids: [liveIds[0]!], ...ACTOR });
    await moveGapToBreakoutGroup({ gap_id: liveIds[0]!, from_group_id: a, to_group_id: b, ...ACTOR });
    const state = await loadState();
    expect(state.breakout_groups.find((row) => row.id === a)).toMatchObject({ name: "Group A renamed", note: "Covers HTA" });
    const rows = state.breakout_group_gaps.filter((row) => row.gap_id === liveIds[0]);
    expect(rows.some((row) => row.group_id === b)).toBe(true);
    expect(rows.some((row) => row.group_id === a)).toBe(false);
  });

  it("groups gaps by domain: one group per domain, each with its gaps; a rerun adds, never duplicates", async () => {
    await resetDemo();
    const buckets = await themeBuckets("domain");
    expect(buckets.reduce((sum, bucket) => sum + bucket.gap_ids.length, 0)).toBe(liveIds.length);
    const first = await createBreakoutGroupsByTheme({ theme: "domain", only_unassigned: true, ...ACTOR });
    expect(first.created).toBe(buckets.length);
    expect(first.assigned).toBe(liveIds.length);
    const again = await createBreakoutGroupsByTheme({ theme: "domain", only_unassigned: false, ...ACTOR });
    expect(again).toEqual({ created: 0, assigned: 0 });
    const state = await loadState();
    expect(state.breakout_groups).toHaveLength(buckets.length);
    expect(new Set(state.breakout_group_gaps.map((row) => row.gap_id)).size).toBe(liveIds.length);
  });

  it("buckets by setting and by priority", async () => {
    const settings = await themeBuckets("setting");
    expect(settings.length).toBeGreaterThan(0);
    const priority = await themeBuckets("priority");
    expect(priority.map((bucket) => bucket.label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/priority|Not prioritized|Deferred/)]),
    );
  });
});
