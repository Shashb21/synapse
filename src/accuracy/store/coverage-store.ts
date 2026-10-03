import { and, eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId } from "@/modules/kernel/ids";
import { assemblyExecutionScope, withAssemblyWorkspaceLock } from "@/accuracy/kernel/assembly-context";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import {
  claimMetadata,
  getClaimsByIds,
  isDownstreamClaim,
  listDownstreamClaims,
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

async function approvedInventory(workspace_id: string) {
  if (assemblyExecutionScope().kind !== "production") return null;
  const { approvedLiveInventory } = await import("./assembly-review-store");
  return approvedLiveInventory(workspace_id);
}

async function requireApprovedPair(workspace_id: string, gap_id: string, tactic_id: string): Promise<boolean> {
  const live = await approvedInventory(workspace_id);
  if (!live) return false;
  const claims = new Map(live.claims.map((claim) => [claim.id, claim]));
  const gap = claims.get(gap_id);
  const tactic = claims.get(tactic_id);
  if (!gap || gap.claim_type !== "gap" || !tactic || tactic.claim_type !== "tactic") {
    throw new AssemblyReviewError("approval_required", "Coverage requires claims from the current approved assembly.");
  }
  return true;
}

export async function listCoveragePairs(workspace_id: string): Promise<CoveragePair[]> {
  await ensureAccuracySchema();
  const live = await approvedInventory(workspace_id);
  if (live) {
    const claims = new Map(live.claims.map((claim) => [claim.id, claim]));
    const joins = new Map(live.coverage.map((join) => [`${join.gap_id}::${join.tactic_id}`, join]));
    const explicitPairs = new Map<string, { gap_id: string; tactic_id: string }>();
    for (const row of live.coverage) explicitPairs.set(`${row.gap_id}::${row.tactic_id}`, { gap_id: row.gap_id, tactic_id: row.tactic_id });
    for (const row of live.mappings) explicitPairs.set(`${row.gap_id}::${row.tactic_id}`, { gap_id: row.gap_id, tactic_id: row.tactic_id });
    return [...explicitPairs.values()].flatMap(({ gap_id, tactic_id }) => {
      const gap = claims.get(gap_id);
      const tactic = claims.get(tactic_id);
      if (!gap || !tactic) return [];
      const existing = joins.get(`${gap_id}::${tactic_id}`);
      return [{
        id: existing?.id ?? `pair_${gap_id}_${tactic_id}`,
        gap,
        tactic,
        overall: existing?.overall ?? null,
        rationale: existing?.rationale ?? null,
        validated: existing?.validated ?? false,
      }];
    }).slice(0, 80);
  }
  const claims = await listDownstreamClaims(workspace_id, { limit: 500 });
  const gaps = claims.filter((c) => c.claim_type === "gap" && isDownstreamClaim(c));
  const tactics = claims.filter((c) => c.claim_type === "tactic" && isDownstreamClaim(c));
  const joins = await listCoverageJoins(workspace_id);
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
  return pairs.slice(0, 80);
}

export async function upsertCoverageDecision(args: {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  overall: "covers" | "partial" | "none" | "unknown";
  rationale: string;
}): Promise<void> {
  return withAssemblyWorkspaceLock(args.workspace_id, () => upsertCoverageDecisionLocked(args));
}

async function upsertCoverageDecisionLocked(args: {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  overall: "covers" | "partial" | "none" | "unknown";
  rationale: string;
}): Promise<void> {
  await ensureAccuracySchema();
  const approved = await requireApprovedPair(args.workspace_id, args.gap_id, args.tactic_id);
  if (approved) {
    throw new AssemblyReviewError("conflict", "Coverage changes require a revised approved assembly.");
  }
  if (!approved) {
    const claims = await getClaimsByIds(args.workspace_id, [args.gap_id, args.tactic_id]);
    if (claims.length !== 2 || !claims.every(isDownstreamClaim)) throw new Error("Coverage requires eligible claims in this workspace.");
  }
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
  const live = await approvedInventory(workspace_id);
  if (live) return live.coverage;
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
  return withAssemblyWorkspaceLock(args.workspace_id, () => insertCoverageJoinLocked(args));
}

async function insertCoverageJoinLocked(args: {
  workspace_id: string;
  gap_id: string;
  tactic_id: string;
  overall: string;
  validated?: boolean;
  rationale?: string | null;
}): Promise<CoverageJoinRow> {
  await ensureAccuracySchema();
  if (await requireApprovedPair(args.workspace_id, args.gap_id, args.tactic_id)) {
    throw new AssemblyReviewError("conflict", "Coverage changes require a revised approved assembly.");
  }
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
