import { and, eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId } from "@/modules/kernel/ids";
import {
  claimMetadata,
  getClaimsByIds,
  isActiveLedgerClaim,
  listClaims,
  type AccuracyClaimRow,
} from "./claim-store";

export type CoverageJoinRow = typeof t.accuracyCoverageJoins.$inferSelect;

export type CoveragePair = {
  id: string;
  gap: AccuracyClaimRow;
  tactic: AccuracyClaimRow;
  overall: string | null;
  rationale: string | null;
  validated: boolean;
};

export async function listCoveragePairs(workspace_id: string): Promise<CoveragePair[]> {
  await ensureAccuracySchema();
  const claims = await listClaims(workspace_id, { limit: 500 });
  const gaps = claims.filter((c) => c.claim_type === "gap" && isActiveLedgerClaim(c));
  const tactics = claims.filter((c) => c.claim_type === "tactic" && isActiveLedgerClaim(c));
  const joins = await accuracyDb()
    .select()
    .from(t.accuracyCoverageJoins)
    .where(eq(t.accuracyCoverageJoins.workspace_id, workspace_id));
  const joinKey = new Map(joins.map((j) => [`${j.gap_id}::${j.tactic_id}`, j]));

  const pairs: CoveragePair[] = [];
  for (const gap of gaps) {
    const gapMeta = claimMetadata(gap);
    const gapExternal =
      typeof gapMeta.external_id === "string" ? gapMeta.external_id : gap.id.replace(/^gap_/, "");
    const related = tactics.filter((tac) => {
      const meta = claimMetadata(tac);
      const ids = Array.isArray(meta.gap_ids) ? (meta.gap_ids as string[]) : [];
      if (ids.length === 0) return false;
      return ids.includes(gapExternal) || ids.includes(gap.id);
    });
    const candidates = related.length > 0 ? related : tactics.slice(0, 3);
    for (const tactic of candidates) {
      const existing = joinKey.get(`${gap.id}::${tactic.id}`);
      pairs.push({
        id: existing?.id ?? `pair_${gap.id}_${tactic.id}`,
        gap,
        tactic,
        overall: existing?.overall ?? null,
        rationale: existing?.rationale ?? null,
        validated: existing?.validated ?? false,
      });
    }
  }
  // Decisions a user made on any pair (manual pair picker) always stay visible,
  // even when the pair is not one of the heuristic candidates above.
  const listed = new Set(pairs.map((pair) => `${pair.gap.id}::${pair.tactic.id}`));
  const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
  const tacticById = new Map(tactics.map((tactic) => [tactic.id, tactic]));
  const decided: CoveragePair[] = [];
  for (const join of joins) {
    const key = `${join.gap_id}::${join.tactic_id}`;
    if (listed.has(key)) continue;
    const gap = gapById.get(join.gap_id);
    const tactic = tacticById.get(join.tactic_id);
    if (!gap || !tactic) continue;
    listed.add(key);
    decided.push({
      id: join.id,
      gap,
      tactic,
      overall: join.overall,
      rationale: join.rationale,
      validated: join.validated,
    });
  }
  return [...pairs.slice(0, 80), ...decided];
}

/** Throws unless gap_id is an active gap and tactic_id an active tactic in the workspace. */
export async function requireCoveragePairClaims(args: {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
}): Promise<{ gap: AccuracyClaimRow; tactic: AccuracyClaimRow }> {
  const rows = await getClaimsByIds(args.workspace_id, [args.gap_id, args.tactic_id]);
  const gap = rows.find((row) => row.id === args.gap_id);
  const tactic = rows.find((row) => row.id === args.tactic_id);
  if (!gap || gap.claim_type !== "gap") throw new Error(`Unknown gap: ${args.gap_id}`);
  if (!tactic || tactic.claim_type !== "tactic") {
    throw new Error(`Unknown tactic: ${args.tactic_id}`);
  }
  if (!isActiveLedgerClaim(gap) || !isActiveLedgerClaim(tactic)) {
    throw new Error("Coverage can only be decided between active (not merged / rejected) claims.");
  }
  return { gap, tactic };
}

export async function upsertCoverageDecision(args: {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  overall: "covers" | "partial" | "none" | "unknown";
  rationale: string;
}): Promise<void> {
  await ensureAccuracySchema();
  const existing = await accuracyDb()
    .select()
    .from(t.accuracyCoverageJoins)
    .where(
      and(
        eq(t.accuracyCoverageJoins.workspace_id, args.workspace_id),
        eq(t.accuracyCoverageJoins.gap_id, args.gap_id),
        eq(t.accuracyCoverageJoins.tactic_id, args.tactic_id),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await accuracyDb()
      .update(t.accuracyCoverageJoins)
      .set({
        overall: args.overall,
        rationale: args.rationale,
        validated: true,
        dimensions: {},
      })
      .where(eq(t.accuracyCoverageJoins.id, existing[0].id));
    return;
  }
  await accuracyDb().insert(t.accuracyCoverageJoins).values({
    id: newId("cov"),
    workspace_id: args.workspace_id,
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    overall: args.overall,
    dimensions: {},
    confidence: null,
    validated: true,
    rationale: args.rationale,
  });
}

export async function listCoverageJoins(workspace_id: string): Promise<CoverageJoinRow[]> {
  await ensureAccuracySchema();
  return accuracyDb()
    .select()
    .from(t.accuracyCoverageJoins)
    .where(eq(t.accuracyCoverageJoins.workspace_id, workspace_id));
}

export async function insertCoverageJoin(args: {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  overall: string;
  validated?: boolean;
  rationale?: string | null;
}): Promise<CoverageJoinRow> {
  await ensureAccuracySchema();
  const row = {
    id: newId("cov"),
    workspace_id: args.workspace_id,
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    overall: args.overall,
    dimensions: {} as Record<string, unknown>,
    confidence: null,
    validated: args.validated ?? true,
    rationale: args.rationale ?? null,
  };
  await accuracyDb().insert(t.accuracyCoverageJoins).values(row);
  return row as CoverageJoinRow;
}

/** After merge, point joins at the surviving claim id. */
export async function reassignCoverageClaimId(args: {
  workspace_id: string;
  from_id: string;
  to_id: string;
  role: "gap" | "tactic";
}): Promise<number> {
  if (args.from_id === args.to_id) return 0;
  const joins = await listCoverageJoins(args.workspace_id);
  let updated = 0;
  for (const join of joins) {
    const fromGap = args.role === "gap" && join.gap_id === args.from_id;
    const fromTactic = args.role === "tactic" && join.tactic_id === args.from_id;
    if (!fromGap && !fromTactic) continue;
    const nextGap = fromGap ? args.to_id : join.gap_id;
    const nextTactic = fromTactic ? args.to_id : join.tactic_id;
    const collision = joins.find(
      (row) => row.id !== join.id && row.gap_id === nextGap && row.tactic_id === nextTactic,
    );
    if (collision) {
      await accuracyDb()
        .delete(t.accuracyCoverageJoins)
        .where(eq(t.accuracyCoverageJoins.id, join.id));
    } else {
      await accuracyDb()
        .update(t.accuracyCoverageJoins)
        .set({ gap_id: nextGap, tactic_id: nextTactic })
        .where(eq(t.accuracyCoverageJoins.id, join.id));
    }
    updated += 1;
  }
  return updated;
}
