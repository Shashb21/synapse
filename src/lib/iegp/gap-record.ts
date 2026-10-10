import { inArray, sql } from "drizzle-orm";
import { db } from "./db";
import * as kernel from "@/modules/kernel/schema";
import { gapCandidates } from "@/modules/stages/s2-gap-extract/schema";
import { loadState } from "./store";
import { gapVersionsFor, lastResetAt } from "./gap-history";
import { entityHistory, type HistoryEntry } from "./entity-history";
import { isLiveGap } from "./engine";
import type { IegpState } from "./types";

type Gap = IegpState["gaps"][0];

/**
 * Everything about one gap, from one place (KAN-97): its wording and details,
 * the objective it serves, who confirmed it, its needs with their sources,
 * quotes and S2 provenance, its mappings, priority, ideas, timeline
 * activities, breakout groups, pending suggestions, leftovers, versions and
 * history. The gap page reads it, and GET /api/gaps/[id] exports it.
 */
export type GapRecord = {
  gap: Gap;
  objective: IegpState["objectives"][0] | null;
  confirmation: {
    confirmed: boolean;
    by: Gap["validated_by"];
    at: string | null;
    rationale: string | null;
  };
  parent: Pick<Gap, "id" | "name" | "number"> | null;
  origin: Pick<Gap, "id" | "name" | "number"> | null;
  children: Pick<Gap, "id" | "name" | "number" | "status">[];
  related: Pick<Gap, "id" | "name" | "number">[];
  needs: {
    need: IegpState["needs"][0];
    role: "primary" | "supporting";
    source: Pick<IegpState["sources"][0], "id" | "title" | "filename" | "source_type"> | null;
    block: Pick<IegpState["blocks"][0], "id" | "heading" | "location"> | null;
    candidate: typeof gapCandidates.$inferSelect | null;
  }[];
  /** S2 candidate rows that became or joined this gap. */
  candidates: (typeof gapCandidates.$inferSelect)[];
  coverages: (IegpState["coverages"][0] & {
    tactic: Pick<IegpState["tactics"][0], "id" | "name" | "type" | "status"> | null;
    expansion: Pick<IegpState["expansions"][0], "id" | "status" | "scope"> | null;
  })[];
  expansions: IegpState["expansions"];
  mapping_rejections: IegpState["mapping_suggestions"];
  priority: typeof kernel.priorityPlacements.$inferSelect | null;
  ideas: (typeof kernel.ideationProposals.$inferSelect)[];
  timeline: (typeof kernel.timelineActivities.$inferSelect)[];
  breakout_groups: IegpState["breakout_groups"];
  pending_suggestions: IegpState["gap_suggestions"];
  residuals: IegpState["residuals"];
  versions: IegpState["gap_versions"];
  history: HistoryEntry[];
};

const brief = (gap: Gap | undefined) => (gap ? { id: gap.id, name: gap.name, number: gap.number } : null);

/** The gap's full record, or null when no gap has that id. */
export async function gapRecord(gapId: string, preloaded?: IegpState): Promise<GapRecord | null> {
  const state = preloaded ?? (await loadState());
  const gap = state.gaps.find((row) => row.id === gapId);
  if (!gap) return null;
  const links = state.need_gap_links.filter((link) => link.gap_id === gap.id);
  const needIds = links.map((link) => link.need_id);
  const candidateRowIds = state.needs.filter((n) => needIds.includes(n.id) && n.candidate_row_id).map((n) => n.candidate_row_id!);
  const d = db();
  const [placements, ideas, timeline, candidates] = await Promise.all([
    d.select().from(kernel.priorityPlacements).where(sql`${kernel.priorityPlacements.gap_id} = ${gap.id}`),
    d.select().from(kernel.ideationProposals).where(sql`${kernel.ideationProposals.gap_id} = ${gap.id}`),
    d.select().from(kernel.timelineActivities).where(sql`${kernel.timelineActivities.gap_ids} @> ${JSON.stringify([gap.id])}::jsonb`),
    d.select().from(gapCandidates).where(
      candidateRowIds.length
        ? sql`${gapCandidates.committed_gap_id} = ${gap.id} OR ${inArray(gapCandidates.id, candidateRowIds)}`
        : sql`${gapCandidates.committed_gap_id} = ${gap.id}`,
    ),
  ]);
  const candidateById = new Map(candidates.map((row) => [row.id, row]));
  const coverages = state.coverages.filter((c) => c.gap_id === gap.id);
  const residuals = state.residuals.filter((r) => r.gap_id === gap.id);
  const groupIds = new Set(state.breakout_group_gaps.filter((row) => row.gap_id === gap.id).map((row) => row.group_id));
  const history = await entityHistory(
    [gap.id, ...coverages.map((c) => c.id), ...residuals.map((r) => r.id)],
    { since: lastResetAt(state) },
  );
  return {
    gap,
    objective: state.objectives.find((o) => o.id === gap.objective_id) ?? null,
    confirmation: {
      confirmed: gap.human_validated,
      by: gap.validated_by ?? null,
      at: gap.validated_at ?? null,
      rationale: gap.validation_rationale ?? null,
    },
    parent: brief(state.gaps.find((g) => g.id === gap.parent_gap_id)),
    origin: brief(state.gaps.find((g) => g.id === gap.origin_gap_id)),
    children: state.gaps.filter((g) => g.parent_gap_id === gap.id).map((g) => ({ id: g.id, name: g.name, number: g.number, status: g.status })),
    related: (gap.related_gap_ids ?? []).map((id) => brief(state.gaps.find((g) => g.id === id))).filter((row) => row !== null),
    needs: links.flatMap((link) => {
      const need = state.needs.find((n) => n.id === link.need_id);
      if (!need) return [];
      const source = state.sources.find((s) => s.id === need.source_id);
      const block = need.block_id ? state.blocks.find((b) => b.id === need.block_id) : undefined;
      return [{
        need,
        role: link.role,
        source: source ? { id: source.id, title: source.title, filename: source.filename, source_type: source.source_type } : null,
        block: block ? { id: block.id, heading: block.heading, location: block.location } : null,
        candidate: need.candidate_row_id ? candidateById.get(need.candidate_row_id) ?? null : null,
      }];
    }),
    candidates,
    coverages: coverages.map((c) => {
      const tactic = state.tactics.find((x) => x.id === c.tactic_id);
      const expansion = c.expansion_id ? state.expansions.find((e) => e.id === c.expansion_id) : undefined;
      return {
        ...c,
        tactic: tactic ? { id: tactic.id, name: tactic.name, type: tactic.type, status: tactic.status } : null,
        expansion: expansion ? { id: expansion.id, status: expansion.status, scope: expansion.scope } : null,
      };
    }),
    expansions: state.expansions.filter((e) => e.gap_ids.includes(gap.id)),
    mapping_rejections: state.mapping_suggestions.filter((m) => m.gap_id === gap.id && m.status === "rejected"),
    priority: placements[0] ?? null,
    ideas,
    timeline,
    breakout_groups: state.breakout_groups.filter((g) => groupIds.has(g.id)),
    pending_suggestions: state.gap_suggestions.filter((row) => row.gap_id === gap.id && row.status === "pending"),
    residuals,
    versions: gapVersionsFor(state, gap.id),
    history,
  };
}

/** One row that points at a gap it should not: a retired one, or none at all. */
export type GapOrphan = { kind: string; id: string; gap_id: string; reason: "retired" | "missing" };

/**
 * Rows that should follow a live gap but point at a retired or missing one
 * (KAN-97). History (versions, audit, edit records) and coverages a split left
 * behind on the retired gap are allowed to stay; everything a person acts on
 * next is not.
 */
export async function findGapOrphans(preloaded?: IegpState): Promise<GapOrphan[]> {
  const state = preloaded ?? (await loadState());
  const byId = new Map(state.gaps.map((g) => [g.id, g]));
  const check = (gapId: string): GapOrphan["reason"] | null => {
    const gap = byId.get(gapId);
    if (!gap) return "missing";
    return gap.retired ? "retired" : null;
  };
  const orphans: GapOrphan[] = [];
  const add = (kind: string, id: string, gapId: string) => {
    const reason = check(gapId);
    if (reason) orphans.push({ kind, id, gap_id: gapId, reason });
  };
  const d = db();
  const [placements, ideas, timeline] = await Promise.all([
    d.select({ gap_id: kernel.priorityPlacements.gap_id }).from(kernel.priorityPlacements),
    d.select({ id: kernel.ideationProposals.id, gap_id: kernel.ideationProposals.gap_id, status: kernel.ideationProposals.status }).from(kernel.ideationProposals),
    d.select({ id: kernel.timelineActivities.id, gap_ids: kernel.timelineActivities.gap_ids }).from(kernel.timelineActivities),
  ]);
  for (const row of placements) add("priority_placement", row.gap_id, row.gap_id);
  // A decided idea is history; only open ones must follow the gap.
  for (const row of ideas) if (row.status === "proposed") add("ideation_proposal", row.id, row.gap_id);
  for (const row of timeline) for (const gapId of (row.gap_ids as string[]) ?? []) add("timeline_activity", row.id, gapId);
  for (const row of state.breakout_group_gaps) add("breakout_group", row.group_id, row.gap_id);
  for (const row of state.gap_suggestions) if (row.status === "pending") add("gap_suggestion", row.id, row.gap_id);
  for (const row of state.residuals) if (row.review_status !== "rejected") add("residual", row.id, row.gap_id);
  for (const row of state.expansions) {
    if (row.status === "cancelled") continue;
    for (const gapId of row.gap_ids) add("tactic_expansion", row.id, gapId);
  }
  for (const gap of state.gaps.filter(isLiveGap)) {
    for (const id of gap.related_gap_ids ?? []) add("related_gap", gap.id, id);
  }
  for (const link of state.need_gap_links) {
    if (!byId.has(link.gap_id)) orphans.push({ kind: "need_link", id: link.need_id, gap_id: link.gap_id, reason: "missing" });
  }
  return orphans;
}
