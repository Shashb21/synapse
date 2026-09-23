import { z } from "zod";
import { mechanicalModule } from "../_factory";
import {
  asTacticLifecycle,
  deriveWorkspaceGapStatuses,
  gapStatusSchema,
  normalizeCoverageOverall,
  type CoverageJoinLite,
  type GapStatus,
  type TacticLite,
} from "./engine";
import {
  claimMetadata,
  isActiveLedgerClaim,
  listClaims,
  persistClaimPatch,
} from "@/accuracy/store/claim-store";
import { listCoverageJoins } from "@/accuracy/store/coverage-store";
import { nowIso } from "@/modules/kernel/ids";

export {
  asTacticLifecycle,
  deriveGapStatus,
  deriveWorkspaceGapStatuses,
  effectiveGapStatus,
  gapStatusSchema,
  normalizeCoverageOverall,
} from "./engine";

const coverageLiteSchema = z.object({
  gap_id: z.string(),
  tactic_id: z.string(),
  overall: z.string(),
  validated: z.boolean(),
});

const tacticLiteSchema = z.object({
  id: z.string(),
  status: z.enum(["completed", "ongoing", "planned", "proposed", "cancelled"]),
});

const inputSchema = z.object({
  workspace_id: z.string(),
  gap_ids: z.array(z.string()).optional(),
  coverages: z.array(coverageLiteSchema).optional(),
  tactics: z.array(tacticLiteSchema).optional(),
  persist: z.boolean().optional(),
});

const statusRowSchema = z.object({
  gap_id: z.string(),
  status: gapStatusSchema,
  computed: gapStatusSchema,
  override: z.boolean(),
});

const outputSchema = z.object({
  statuses: z.array(statusRowSchema),
  open: z.number().int(),
  partial: z.number().int(),
  addressed: z.number().int(),
});

export type StatusDeriveOutput = z.infer<typeof outputSchema>;

function overrideFromMeta(meta: ReturnType<typeof claimMetadata>): GapStatus | null {
  const raw = meta.status_override;
  if (!raw || typeof raw !== "object") return null;
  const status = (raw as { status?: unknown }).status;
  if (status === "open" || status === "partial" || status === "addressed") return status;
  return null;
}

export const statusDeriveModule = mechanicalModule({
  id: "status-derive.engine-v1",
  call_kind: "status_derive",
  title: "Status engine",
  summary: "Compute Open/Partial/Addressed from validated coverage joins.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    const claims = await listClaims(input.workspace_id, { limit: 1000 });
    const active = claims.filter(isActiveLedgerClaim);
    const gapRows = active.filter((row) => row.claim_type === "gap");
    const tacticRows = active.filter((row) => row.claim_type === "tactic");

    const gap_ids =
      input.gap_ids && input.gap_ids.length > 0
        ? input.gap_ids
        : gapRows.map((row) => row.id);

    const tactics: TacticLite[] =
      input.tactics ??
      tacticRows.flatMap((row) => {
        const meta = claimMetadata(row);
        const status = asTacticLifecycle(meta.tactic_status) ?? asTacticLifecycle(row.status);
        if (!status) return [];
        return [{ id: row.id, status }];
      });

    let coverages: CoverageJoinLite[];
    if (input.coverages) {
      coverages = input.coverages.map((row) => ({
        ...row,
        overall: normalizeCoverageOverall(row.overall) ?? "not_relevant",
      }));
    } else {
      const joins = await listCoverageJoins(input.workspace_id);
      coverages = joins.map((join) => ({
        gap_id: join.gap_id,
        tactic_id: join.tactic_id,
        overall: normalizeCoverageOverall(join.overall) ?? "not_relevant",
        validated: join.validated,
      }));
    }

    const overrides: Record<string, GapStatus | null> = {};
    for (const row of gapRows) {
      overrides[row.id] = overrideFromMeta(claimMetadata(row));
    }

    const statuses = deriveWorkspaceGapStatuses({
      gap_ids,
      coverages,
      tactics,
      overrides,
    });

    const persist = input.persist !== false;
    if (persist) {
      const derivedAt = nowIso();
      const gapById = new Map(gapRows.map((row) => [row.id, row]));
      for (const row of statuses) {
        const claim = gapById.get(row.gap_id);
        if (!claim) continue;
        const meta = claimMetadata(claim);
        await persistClaimPatch({
          workspace_id: input.workspace_id,
          claim_id: row.gap_id,
          metadata: {
            ...meta,
            computed_status: row.computed,
            derived_at: derivedAt,
          },
        });
      }
    }

    const open = statuses.filter((s) => s.status === "open").length;
    const partial = statuses.filter((s) => s.status === "partial").length;
    const addressed = statuses.filter((s) => s.status === "addressed").length;
    ctx.run.note("status:derived", { open, partial, addressed, count: statuses.length });
    return {
      output: { statuses, open, partial, addressed },
      summary: `Derived ${statuses.length} gap status(es) — ${open} open, ${partial} partial, ${addressed} addressed`,
    };
  },
});
