import { and, desc, eq, inArray } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import {
  requireIsoDateRange,
  resolveTacticDates,
} from "@/accuracy/modules/gantt-project/dates";

export type AccuracyClaimType = "gap" | "tactic";

export type ClaimValidationAction = "validate" | "reject";

export type ClaimValidationMeta = {
  action: ClaimValidationAction;
  rationale: string;
  at: string;
  by: string;
  by_function: string;
};

export type AccuracyClaimMetadata = {
  source_badge?: string | null;
  origin?: string | null;
  start?: string | null;
  end?: string | null;
  timing?: string | null;
  depends_on?: string[];
  validation?: ClaimValidationMeta | null;
  [key: string]: unknown;
};

export type AccuracyClaimRow = typeof t.accuracyClaims.$inferSelect;

const RATIONALE_MIN = 3;

export function requireValidationRationale(rationale: string | null | undefined): string {
  const trimmed = (rationale ?? "").trim();
  if (trimmed.length < RATIONALE_MIN) {
    throw new Error("A short rationale is required for every validation decision.");
  }
  return trimmed;
}

export async function insertClaim(args: {
  id?: string;
  workspace_id: string;
  claim_type: AccuracyClaimType;
  statement: string;
  status?: string;
  validated?: boolean;
  source_file_id?: string | null;
  metadata?: AccuracyClaimMetadata;
}): Promise<AccuracyClaimRow> {
  await ensureAccuracySchema();
  const now = nowIso();
  const row = {
    id: args.id ?? newId(args.claim_type === "gap" ? "gap" : "tac"),
    workspace_id: args.workspace_id,
    claim_type: args.claim_type,
    statement: args.statement,
    status: args.status ?? "draft",
    validated: args.validated ?? false,
    source_file_id: args.source_file_id ?? null,
    metadata: (args.metadata ?? {}) as Record<string, unknown>,
    created_at: now,
    updated_at: now,
  };
  await accuracyDb().insert(t.accuracyClaims).values(row);
  return row as AccuracyClaimRow;
}

export async function listClaims(
  workspace_id: string,
  opts?: { claim_type?: AccuracyClaimType; limit?: number },
): Promise<AccuracyClaimRow[]> {
  await ensureAccuracySchema();
  const limit = opts?.limit ?? 200;
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyClaims)
    .where(eq(t.accuracyClaims.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyClaims.updated_at))
    .limit(limit);
  if (!opts?.claim_type) return rows;
  return rows.filter((row) => row.claim_type === opts.claim_type);
}

export async function getClaimsByIds(
  workspace_id: string,
  claim_ids: string[],
): Promise<AccuracyClaimRow[]> {
  if (claim_ids.length === 0) return [];
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyClaims)
    .where(
      and(
        eq(t.accuracyClaims.workspace_id, workspace_id),
        inArray(t.accuracyClaims.id, claim_ids),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return claim_ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Persist validate/reject on claims. Updates `validated` and records rationale in metadata.
 */
export async function applyClaimValidation(args: {
  workspace_id: string;
  claim_ids: string[];
  action: ClaimValidationAction;
  rationale: string;
  actor: Actor;
}): Promise<{ updated: number; claims: AccuracyClaimRow[] }> {
  const rationale = requireValidationRationale(args.rationale);
  if (args.claim_ids.length === 0) {
    throw new Error("At least one claim_id is required.");
  }

  await ensureAccuracySchema();
  const existing = await getClaimsByIds(args.workspace_id, args.claim_ids);
  if (existing.length !== args.claim_ids.length) {
    const found = new Set(existing.map((row) => row.id));
    const missing = args.claim_ids.filter((id) => !found.has(id));
    throw new Error(`Unknown claim(s) in workspace: ${missing.join(", ")}`);
  }

  const now = nowIso();
  const validated = args.action === "validate";
  const nextStatus = args.action === "validate" ? "validated" : "rejected";
  const updated: AccuracyClaimRow[] = [];

  for (const claim of existing) {
    const prevMeta = (claim.metadata ?? {}) as AccuracyClaimMetadata;
    const metadata: AccuracyClaimMetadata = {
      ...prevMeta,
      validation: {
        action: args.action,
        rationale,
        at: now,
        by: args.actor.name,
        by_function: args.actor.function,
      },
    };
    await accuracyDb()
      .update(t.accuracyClaims)
      .set({
        validated,
        status: nextStatus,
        metadata,
        updated_at: now,
      })
      .where(
        and(
          eq(t.accuracyClaims.id, claim.id),
          eq(t.accuracyClaims.workspace_id, args.workspace_id),
        ),
      );
    updated.push({
      ...claim,
      validated,
      status: nextStatus,
      metadata,
      updated_at: now,
    });
  }

  return { updated: updated.length, claims: updated };
}

export async function getClaim(
  workspace_id: string,
  claim_id: string,
): Promise<AccuracyClaimRow | null> {
  const rows = await getClaimsByIds(workspace_id, [claim_id]);
  return rows[0] ?? null;
}

export async function updateClaimMetadata(args: {
  workspace_id: string;
  claim_id: string;
  metadata: AccuracyClaimMetadata;
}): Promise<AccuracyClaimRow> {
  await ensureAccuracySchema();
  const existing = await getClaim(args.workspace_id, args.claim_id);
  if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
  const now = nowIso();
  await accuracyDb()
    .update(t.accuracyClaims)
    .set({ metadata: args.metadata as Record<string, unknown>, updated_at: now })
    .where(
      and(
        eq(t.accuracyClaims.id, args.claim_id),
        eq(t.accuracyClaims.workspace_id, args.workspace_id),
      ),
    );
  return { ...existing, metadata: args.metadata as Record<string, unknown>, updated_at: now };
}

export function claimMetadata(claim: AccuracyClaimRow): AccuracyClaimMetadata {
  return (claim.metadata ?? {}) as AccuracyClaimMetadata;
}

/** Map tactic claims into inputs for `projectGanttFromTactics`. */
export function tacticsForGantt(claims: AccuracyClaimRow[]) {
  return claims
    .filter((row) => row.claim_type === "tactic")
    .map((row) => {
      const meta = claimMetadata(row);
      const timing =
        typeof meta.timing === "string"
          ? meta.timing
          : typeof meta.horizon === "string"
            ? meta.horizon
            : null;
      const resolved = resolveTacticDates({
        start: typeof meta.start === "string" ? meta.start : null,
        end: typeof meta.end === "string" ? meta.end : null,
        timing,
      });
      return {
        id: row.id,
        validated: row.validated,
        start: resolved?.start ?? null,
        end: resolved?.end ?? null,
        depends_on: Array.isArray(meta.depends_on) ? meta.depends_on : [],
      };
    });
}

/**
 * Persist start/end on a tactic claim so coverage/plan decisions continue into Gantt.
 * Requires a short rationale (hillclimb). Does not invent dates.
 */
export async function setTacticTiming(args: {
  workspace_id: string;
  claim_id: string;
  start: string;
  end: string;
  rationale: string;
  actor?: Actor;
}): Promise<AccuracyClaimRow> {
  const rationale = requireValidationRationale(args.rationale);
  const dates = requireIsoDateRange(args.start, args.end);
  const existing = await getClaim(args.workspace_id, args.claim_id);
  if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
  if (existing.claim_type !== "tactic") {
    throw new Error("Timing can only be set on tactic claims.");
  }
  const prev = claimMetadata(existing);
  const actor = args.actor ?? { name: "system", function: "accuracy" };
  return updateClaimMetadata({
    workspace_id: args.workspace_id,
    claim_id: args.claim_id,
    metadata: {
      ...prev,
      start: dates.start,
      end: dates.end,
      timing: undefined,
      timing_edit: {
        rationale,
        at: nowIso(),
        by: actor.name,
        by_function: actor.function,
        before: { start: prev.start ?? null, end: prev.end ?? null },
        after: { start: dates.start, end: dates.end },
      },
    },
  });
}
