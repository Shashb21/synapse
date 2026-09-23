import { z } from "zod";
import { eq } from "drizzle-orm";
import { mechanicalModule } from "../_factory";
import {
  deriveGapStatus,
  gapStatusSchema,
  type CoverageJoinLite,
  type GapStatus,
  type TacticLite,
} from "./engine";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import {
  claimMetadata,
  listClaims,
  updateClaimStatus,
  type AccuracyClaimRow,
} from "@/accuracy/store/claim-store";
import { nowIso } from "@/modules/kernel/ids";

const inputSchema = z.object({
  workspace_id: z.string(),
  gap_ids: z.array(z.string()).optional(),
  coverages: z
    .array(
      z.object({
        gap_id: z.string(),
        tactic_id: z.string(),
        overall: z.enum(["full", "partial", "limited", "not_relevant"]),
        validated: z.boolean(),
      }),
    )
    .optional(),
  tactics: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(["completed", "ongoing", "planned", "proposed", "cancelled"]),
      }),
    )
    .optional(),
  /** When true (default), persist derived status onto gap claims in the workspace. */
  persist: z.boolean().optional().default(true),
});

const outputSchema = z.object({
  statuses: z.array(z.object({ gap_id: z.string(), status: gapStatusSchema })),
  updated: z.number().int(),
});

/** Map coverage-join overall (UI or schema-locked) onto status-engine enums. */
export function normalizeCoverageOverall(
  overall: string | null | undefined,
): CoverageJoinLite["overall"] | null {
  switch ((overall ?? "").trim().toLowerCase()) {
    case "full":
    case "covers":
      return "full";
    case "partial":
      return "partial";
    case "limited":
      return "limited";
    case "not_relevant":
    case "none":
      return "not_relevant";
    case "unknown":
    case "":
      return null;
    default:
      return null;
  }
}

function tacticStatusFromClaim(status: string): TacticLite["status"] {
  switch (status) {
    case "completed":
    case "ongoing":
    case "planned":
    case "proposed":
    case "cancelled":
      return status;
    default:
      return "proposed";
  }
}

export async function loadStatusDeriveInputs(workspace_id: string): Promise<{
  gap_ids: string[];
  coverages: CoverageJoinLite[];
  tactics: TacticLite[];
  gaps: AccuracyClaimRow[];
}> {
  await ensureAccuracySchema();
  const claims = await listClaims(workspace_id, { limit: 500 });
  const gaps = claims.filter((c) => c.claim_type === "gap" && c.status !== "rejected");
  const tacticRows = claims.filter((c) => c.claim_type === "tactic" && c.status !== "rejected");
  const joins = await accuracyDb()
    .select()
    .from(t.accuracyCoverageJoins)
    .where(eq(t.accuracyCoverageJoins.workspace_id, workspace_id));

  const coverages: CoverageJoinLite[] = [];
  for (const join of joins) {
    const overall = normalizeCoverageOverall(join.overall);
    if (!overall) continue;
    coverages.push({
      gap_id: join.gap_id,
      tactic_id: join.tactic_id,
      overall,
      validated: join.validated,
    });
  }

  return {
    gap_ids: gaps.map((g) => g.id),
    coverages,
    tactics: tacticRows.map((row) => ({
      id: row.id,
      status: tacticStatusFromClaim(row.status),
    })),
    gaps,
  };
}

/**
 * Persist Open/Partial/Addressed onto gap claims.
 * Rejected gaps are left alone; other gaps receive the derived coverage status.
 */
export async function applyDerivedGapStatuses(args: {
  workspace_id: string;
  gaps: AccuracyClaimRow[];
  statuses: Array<{ gap_id: string; status: GapStatus }>;
}): Promise<number> {
  const byId = new Map(args.statuses.map((s) => [s.gap_id, s.status]));
  let updated = 0;
  for (const gap of args.gaps) {
    if (gap.status === "rejected") continue;
    const next = byId.get(gap.id);
    if (!next) continue;
    const meta = claimMetadata(gap);
    if (gap.status === next && meta.derived_status === next) continue;
    await updateClaimStatus({
      workspace_id: args.workspace_id,
      claim_id: gap.id,
      status: next,
      metadata: {
        ...meta,
        derived_status: next,
        derived_at: nowIso(),
      },
    });
    updated += 1;
  }
  return updated;
}

export const statusDeriveModule = mechanicalModule({
  id: "status-derive.engine-v1",
  call_kind: "status_derive",
  title: "Status engine",
  summary: "Compute Open/Partial/Addressed from validated coverage joins.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    const hasInline =
      Array.isArray(input.coverages) &&
      Array.isArray(input.tactics) &&
      Array.isArray(input.gap_ids);

    const loaded = hasInline
      ? {
          gap_ids: input.gap_ids!,
          coverages: input.coverages!,
          tactics: input.tactics!,
          gaps: [] as AccuracyClaimRow[],
        }
      : await loadStatusDeriveInputs(input.workspace_id);

    const gap_ids = input.gap_ids?.length ? input.gap_ids : loaded.gap_ids;
    const coverages = input.coverages ?? loaded.coverages;
    const tactics = input.tactics ?? loaded.tactics;

    const statuses = gap_ids.map((gap_id) => ({
      gap_id,
      status: deriveGapStatus({
        gap_id,
        coverages,
        tactics,
      }),
    }));
    ctx.run.note("status:derived", statuses);

    let updated = 0;
    if (input.persist !== false) {
      const gaps =
        loaded.gaps.length > 0
          ? loaded.gaps.filter((g) => gap_ids.includes(g.id))
          : (await listClaims(input.workspace_id, { claim_type: "gap", limit: 500 })).filter((g) =>
              gap_ids.includes(g.id),
            );
      updated = await applyDerivedGapStatuses({
        workspace_id: input.workspace_id,
        gaps,
        statuses,
      });
    }

    return {
      output: { statuses, updated },
      summary: `Derived ${statuses.length} gap statuses (${updated} persisted)`,
    };
  },
});

export { deriveGapStatus, gapStatusSchema } from "./engine";
export type { GapStatus, CoverageJoinLite, TacticLite } from "./engine";
