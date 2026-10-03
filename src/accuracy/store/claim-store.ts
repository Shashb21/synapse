/** Claim persistence, review visibility and protected downstream projections. */
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import { assemblyExecutionScope } from "@/accuracy/kernel/assembly-context";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";

import { isDownstreamClaim } from "@/accuracy/domain/item-history";
export { isDownstreamClaim } from "@/accuracy/domain/item-history";

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
  readout?: string | null;
  readout_date?: string | null;
  evidence_available?: string | null;
  depends_on?: string[];
  tactic_type?: string | null;
  gap_ids?: string[];
  parent_gap_id?: string | null;
  validation?: ClaimValidationMeta | null;
  external_id?: string | null;
  chapter?: string | null;
  si_theme?: string | null;
  reference_pack_id?: string | null;
  tactic_status?: string | null;
  computed_status?: string | null;
  derived_at?: string | null;
  merged_into?: string | null;
  merged_from?: string[];
  merge_reason?: string | null;
  status_override?: { status: string; rationale: string } | null;
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
  await assertManagedClaimMutationAllowed(args.workspace_id, []);
  const now = nowIso();
  const row = {
    id: args.id ?? newId(args.claim_type === "gap" ? "gap" : "tac"),
    workspace_id: args.workspace_id,
    claim_type: args.claim_type,
    statement: args.statement,
    status: args.status ?? "draft",
    validated: args.metadata?.history_only === true ? false : args.validated ?? false,
    source_file_id: args.source_file_id ?? null,
    metadata: (args.metadata ?? {}) as Record<string, unknown>,
    created_at: now,
    updated_at: now,
  };
  await accuracyDb().insert(t.accuracyClaims).values(row);
  return row as AccuracyClaimRow;
}

async function approvedClaimIdsForMutation(workspace_id: string): Promise<Set<string> | null> {
  if (assemblyExecutionScope().kind !== "production") return null;
  const { approvedLiveInventory } = await import("./assembly-review-store");
  const live = await approvedLiveInventory(workspace_id);
  return live ? new Set(live.claims.map((claim) => claim.id)) : null;
}

async function assertManagedClaimMutationAllowed(workspace_id: string, claim_ids: string[]): Promise<void> {
  const approved = await approvedClaimIdsForMutation(workspace_id);
  if (!approved) return;
  if (claim_ids.length === 0) {
    throw new AssemblyReviewError("approval_required", "Claim changes require a revised approved assembly.");
  }
  const unknown = claim_ids.filter((id) => !approved.has(id));
  if (unknown.length > 0) {
    throw new AssemblyReviewError("approval_required", "Claim changes require claims from the current approved assembly.");
  }
}

const APPROVED_METADATA_OVERLAY_KEYS = new Set([
  "start",
  "end",
  "readout",
  "readout_date",
  "evidence_available",
  "validation",
  "computed_status",
  "derived_at",
  "status_override",
  "priority",
  "priority_band",
  "priority_rationale",
  "priority_origin",
]);

const APPROVED_PATCH_STATUS_VALUES = new Set(["validated", "rejected"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function approvedOverlayMetadata(existing: AccuracyClaimMetadata, requested: AccuracyClaimMetadata): AccuracyClaimMetadata {
  const next: AccuracyClaimMetadata = { ...existing };
  for (const [key, value] of Object.entries(requested)) {
    if (!APPROVED_METADATA_OVERLAY_KEYS.has(key)) {
      if (!sameJson(value, existing[key])) {
        throw new AssemblyReviewError("conflict", "Approved claim metadata changes are limited to documented workflow overlays.");
      }
      continue;
    }
    next[key] = value;
  }
  if (existing.history_only === true) next.history_only = true;
  return next;
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
    .where(and(eq(t.accuracyClaims.workspace_id, workspace_id),
      opts?.claim_type ? eq(t.accuracyClaims.claim_type, opts.claim_type) : undefined))
    .orderBy(desc(t.accuracyClaims.updated_at))
    .limit(limit);
  return rows;
}

/** Read downstream inventory with eligibility and item type applied before the SQL cap. */
export async function listDownstreamClaims(
  workspace_id: string,
  opts?: { claim_type?: AccuracyClaimType; source_file_id?: string; limit?: number | null },
): Promise<AccuracyClaimRow[]> {
  if (assemblyExecutionScope().kind === "production") {
    const { approvedLiveInventory } = await import("./assembly-review-store");
    const live = await approvedLiveInventory(workspace_id);
    if (live) {
      const rows = live.claims.filter((claim) =>
        (!opts?.claim_type || claim.claim_type === opts.claim_type)
        && (opts?.source_file_id === undefined || claim.source_file_id === opts.source_file_id));
      const ordered = rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return opts?.limit === null ? ordered : ordered.slice(0, opts?.limit ?? 200);
    }
  }
  return listRawDownstreamClaims(workspace_id, opts);
}

async function listRawDownstreamClaims(
  workspace_id: string,
  opts?: { claim_type?: AccuracyClaimType; source_file_id?: string; limit?: number | null },
): Promise<AccuracyClaimRow[]> {
  await ensureAccuracySchema();
  const query = accuracyDb().select().from(t.accuracyClaims).where(and(
    eq(t.accuracyClaims.workspace_id, workspace_id),
    notInArray(t.accuracyClaims.status, ["merged", "rejected"]),
    sql`${t.accuracyClaims.metadata}->'history_only' IS DISTINCT FROM 'true'::jsonb`,
    opts?.claim_type ? eq(t.accuracyClaims.claim_type, opts.claim_type) : inArray(t.accuracyClaims.claim_type, ["gap", "tactic"]),
    opts?.source_file_id !== undefined ? eq(t.accuracyClaims.source_file_id, opts.source_file_id) : undefined,
  )).orderBy(desc(t.accuracyClaims.updated_at));
  return opts?.limit === null ? query : query.limit(opts?.limit ?? 200);
}

/** Return eligible source inventory for extraction completeness, without the UI list limit. */
export async function listActiveSourceClaims(
  workspace_id: string,
  source_file_id: string,
): Promise<AccuracyClaimRow[]> {
  return listRawDownstreamClaims(workspace_id, { source_file_id, limit: null });
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
  await assertManagedClaimMutationAllowed(args.workspace_id, args.claim_ids);
  const existing = await getClaimsByIds(args.workspace_id, args.claim_ids);
  if (existing.length !== args.claim_ids.length) {
    const found = new Set(existing.map((row) => row.id));
    const missing = args.claim_ids.filter((id) => !found.has(id));
    throw new Error(`Unknown claim(s) in workspace: ${missing.join(", ")}`);
  }

  if (args.action === "validate" && existing.some(claim => claimMetadata(claim).history_only === true)) {
    throw new Error("History-only alternatives cannot be validated; approval requires a separate assembly decision.");
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
  const managed = await approvedClaimIdsForMutation(args.workspace_id);
  if (managed && !managed.has(args.claim_id)) {
    throw new AssemblyReviewError("approval_required", "Claim changes require claims from the current approved assembly.");
  }
  const existing = await getClaim(args.workspace_id, args.claim_id);
  if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
  const existingMeta = claimMetadata(existing);
  const metadata = managed
    ? approvedOverlayMetadata(existingMeta, args.metadata)
    : existingMeta.history_only === true ? { ...args.metadata, history_only: true } : args.metadata;
  const now = nowIso();
  await accuracyDb()
    .update(t.accuracyClaims)
    .set({ metadata: metadata as Record<string, unknown>, updated_at: now })
    .where(
      and(
        eq(t.accuracyClaims.id, args.claim_id),
        eq(t.accuracyClaims.workspace_id, args.workspace_id),
      ),
    );
  return { ...existing, metadata: metadata as Record<string, unknown>, updated_at: now };
}

export function claimMetadata(claim: AccuracyClaimRow): AccuracyClaimMetadata {
  return (claim.metadata ?? {}) as AccuracyClaimMetadata;
}

/** Active ledger rows — skip merged duplicates and rejected claims. */
export function isActiveLedgerClaim(claim: Pick<AccuracyClaimRow, "status">): boolean {
  return claim.status !== "merged" && claim.status !== "rejected";
}

export async function persistClaimPatch(args: {
  workspace_id: string;
  claim_id: string;
  status?: string;
  metadata?: AccuracyClaimMetadata;
}): Promise<AccuracyClaimRow> {
  await ensureAccuracySchema();
  const managed = await approvedClaimIdsForMutation(args.workspace_id);
  if (managed && !managed.has(args.claim_id)) {
    throw new AssemblyReviewError("approval_required", "Claim changes require claims from the current approved assembly.");
  }
  const existing = await getClaim(args.workspace_id, args.claim_id);
  if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
  if (managed && args.status !== undefined && !APPROVED_PATCH_STATUS_VALUES.has(args.status)) {
    throw new AssemblyReviewError("conflict", "Approved claim status changes are limited to documented workflow values.");
  }
  const now = nowIso();
  const existingMeta = claimMetadata(existing);
  const metadata = managed
    ? approvedOverlayMetadata(existingMeta, args.metadata ?? existingMeta)
    : { ...(args.metadata ?? existingMeta),
      ...(existingMeta.history_only === true ? { history_only: true } : {}) };
  const status = args.status ?? existing.status;
  await accuracyDb()
    .update(t.accuracyClaims)
    .set({
      status,
      metadata: metadata as Record<string, unknown>,
      updated_at: now,
    })
    .where(
      and(
        eq(t.accuracyClaims.id, args.claim_id),
        eq(t.accuracyClaims.workspace_id, args.workspace_id),
      ),
    );
  return { ...existing, status, metadata: metadata as Record<string, unknown>, updated_at: now };
}

function metaString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metaStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Map tactic claims into inputs for `projectGanttFromTactics`. */
export function tacticsForGantt(claims: AccuracyClaimRow[]) {
  const excludedIds = new Set(claims.filter(row => !isDownstreamClaim(row)).map(row => row.id));
  return claims
    .filter((row) => row.claim_type === "tactic" && isDownstreamClaim(row))
    .map((row) => {
      const meta = claimMetadata(row);
      return {
        id: row.id,
        validated: row.validated,
        start: metaString(meta.start),
        end: metaString(meta.end),
        readout:
          metaString(meta.readout) ??
          metaString(meta.readout_date) ??
          metaString(meta.evidence_available),
        depends_on: metaStringList(meta.depends_on).filter(id => !excludedIds.has(id)),
        tactic_type: metaString(meta.tactic_type),
        gap_ids: metaStringList(meta.gap_ids).filter(id => !excludedIds.has(id)),
      };
    });
}

/** Map gap claims into parent links for Gantt coverage continuity. */
export function gapsForGantt(claims: AccuracyClaimRow[]) {
  const excludedIds = new Set(claims.filter(row => !isDownstreamClaim(row)).map(row => row.id));
  return claims
    .filter((row) => row.claim_type === "gap" && isDownstreamClaim(row))
    .map((row) => {
      const meta = claimMetadata(row);
      const parentId = metaString(meta.parent_gap_id);
      return {
        id: row.id,
        parent_gap_id: parentId && excludedIds.has(parentId) ? null : parentId,
        validated: row.validated,
      };
    });
}
