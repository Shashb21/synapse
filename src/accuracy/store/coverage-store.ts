import { and, eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId } from "@/modules/kernel/ids";
import {
  claimMetadata,
  listClaims,
  setTacticTiming,
  type AccuracyClaimRow,
} from "./claim-store";

export type CoveragePair = {
  id: string;
  gap: AccuracyClaimRow;
  tactic: AccuracyClaimRow;
  overall: string | null;
  rationale: string | null;
  validated: boolean;
  tactic_start: string | null;
  tactic_end: string | null;
};

export async function listCoveragePairs(workspace_id: string): Promise<CoveragePair[]> {
  await ensureAccuracySchema();
  const claims = await listClaims(workspace_id, { limit: 500 });
  const gaps = claims.filter((c) => c.claim_type === "gap");
  const tactics = claims.filter((c) => c.claim_type === "tactic");
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
      const meta = claimMetadata(tactic);
      pairs.push({
        id: existing?.id ?? `pair_${gap.id}_${tactic.id}`,
        gap,
        tactic,
        overall: existing?.overall ?? null,
        rationale: existing?.rationale ?? null,
        validated: existing?.validated ?? false,
        tactic_start: typeof meta.start === "string" ? meta.start : null,
        tactic_end: typeof meta.end === "string" ? meta.end : null,
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
  /** Optional ISO dates written onto the tactic so Gantt projection stays continuous. */
  start?: string | null;
  end?: string | null;
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
  } else {
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

  const start = args.start?.trim() ?? "";
  const end = args.end?.trim() ?? "";
  if (start && end) {
    await setTacticTiming({
      workspace_id: args.workspace_id,
      claim_id: args.tactic_id,
      start,
      end,
      rationale: `Coverage ${args.overall}: ${args.rationale}`,
    });
  }
}
