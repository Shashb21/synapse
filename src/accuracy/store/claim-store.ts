import { and, desc, eq, inArray, or, notInArray, sql } from "drizzle-orm";
import { accuracyDb, accuracyTransactionActive, ensureAccuracySchema, withAccuracyWorkspaceMutation } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import { claimFactualRevision, readStructuredFields, structuredProvenance, validateFieldEvidence,
  gapStructuredFieldsSchema, tacticStructuredFieldsSchema, type GapStructuredFields, type TacticStructuredFields } from "@/accuracy/domain/structured-fields";
import { invalidateAccuracyPriorityValidation } from "./priority-records";
import { provenanceSpanSchema } from "./quote-validator";
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
  factual_revision?: string;
  copied_from_factual_revision?: string;
  stale?: boolean;
  stale_at?: string;
};

export type AccuracyClaimMetadata = {
  structured?: GapStructuredFields | TacticStructuredFields;
  factual_revision?: string;
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
  status_override?: {
    status: string;
    rationale: string;
    at?: string;
    by?: string;
    by_function?: string;
    stale?: boolean;
    stale_at?: string;
  } | null;
  /** Fields a human set by hand. AI re-runs never overwrite these. */
  human_locked?: string[];
  /** Human edit / create / merge / unmerge trail (rationale required). */
  edit_history?: ClaimEditEntry[];
  /** Model-proposed merge a human must confirm (never auto-applied to protected claims). */
  merge_proposal?: ClaimMergeProposal | null;
  /** Claim ids a human decided are NOT duplicates of this one. */
  merge_rejected_with?: string[];
  /** Ledger status before the claim was merged away (restored on unmerge). */
  pre_merge_status?: string | null;
  [key: string]: unknown;
};

export function requireClaimActor(actor: Actor): void {
  if (!actor.name?.trim() || !actor.function?.trim()) throw new Error("An authenticated actor is required.");
}

/** Called only on a factual write; reads never revalidate legacy decisions. */
export function invalidateClaimFacts(previous: AccuracyClaimRow, next: AccuracyClaimRow, at: string): AccuracyClaimRow {
  const revision = claimFactualRevision(next);
  if (claimFactualRevision(previous) === revision) return next;
  const meta = claimMetadata(next);
  const priorValidation = claimMetadata(previous).validation;
  return { ...next, validated: false, status: next.status === "validated" ? "draft" : next.status,
    metadata: { ...meta, factual_revision: revision, factual_validation_stale: true,
      previously_validated: previous.validated || claimMetadata(previous).previously_validated === true,
      ...(priorValidation ? { validation: { ...priorValidation, stale: true, stale_at: at } } : {}),
      ...(meta.status_override ? { status_override: { ...meta.status_override, stale: true, stale_at: at } } : {}),
    } };
}

/** Invalidate only decisions involving this edited claim, retaining rationale and prior metadata. */
export async function invalidateDependentClaimValidation(workspace_id: string, claim_id: string, at: string, database = accuracyDb()): Promise<void> {
  const joins = await database.select().from(t.accuracyCoverageJoins).where(and(
    eq(t.accuracyCoverageJoins.workspace_id, workspace_id),
    or(eq(t.accuracyCoverageJoins.gap_id, claim_id), eq(t.accuracyCoverageJoins.tactic_id, claim_id))));
  await invalidateAccuracyPriorityValidation(workspace_id, [...new Set([claim_id, ...joins.map(join => join.gap_id)])], at, "claim_facts_changed", database);
  for (const join of joins) {
    await database.update(t.accuracyCoverageJoins).set({ validated: false,
      dimensions: { ...(join.dimensions as Record<string, unknown>), validation_stale: true,
        stale_at: at, stale_claim_id: claim_id,
        prior_validated: (join.dimensions as Record<string, unknown>)?.prior_validated ?? join.validated } }).where(and(
      eq(t.accuracyCoverageJoins.workspace_id, workspace_id), eq(t.accuracyCoverageJoins.id, join.id)));
  }
}

/** Index new structured claims in the existing provenance table so parse edits keep their evidence intact. */
export async function syncClaimProvenance(claim: AccuracyClaimRow, database = accuracyDb()): Promise<void> {
  if (!claimMetadata(claim).structured) return;
  const meta = claimMetadata(claim);
  const spans = [...(Array.isArray(meta.provenance) ? meta.provenance.flatMap(raw => {
    const span = provenanceSpanSchema.safeParse(raw);
    return span.success ? [span.data] : [];
  }) : []), ...structuredProvenance(readStructuredFields(claim))];
  const unique = new Map(spans.map(span => [JSON.stringify([span.source_file_id, span.block_id, span.quote]), span]));
  await database.delete(t.accuracyProvenance).where(and(eq(t.accuracyProvenance.workspace_id, claim.workspace_id),
    eq(t.accuracyProvenance.claim_id, claim.id)));
  for (const span of unique.values()) await database.insert(t.accuracyProvenance).values({ id: newId("prov"),
    workspace_id: claim.workspace_id, claim_id: claim.id, source_file_id: span.source_file_id, block_id: span.block_id, quote: span.quote });
}

export type AccuracyClaimRow = typeof t.accuracyClaims.$inferSelect;

export type ClaimEditAction =
  | "create"
  | "edit"
  | "promote"
  | "merge"
  | "unmerge"
  | "merge_dismiss"
  | "split"
  | "rollback";

export type ClaimEditEntry = {
  id: string;
  action: ClaimEditAction;
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rationale: string;
  at: string;
  by: string;
  by_function: string;
};

export type ClaimMergeProposal = {
  survivor_id: string;
  reason: string;
  keys: string[];
  rationale: string | null;
  proposed_at: string;
};

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
    validated: args.metadata?.history_only === true ? false : args.validated ?? false,
    source_file_id: args.source_file_id ?? null,
    metadata: (args.metadata ?? {}) as Record<string, unknown>,
    created_at: now,
    updated_at: now,
  };
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
      await assertManagedClaimMutationAllowed(args.workspace_id, []);
      await accuracyDb().insert(t.accuracyClaims).values(row);
      await syncClaimProvenance(row as AccuracyClaimRow);
      return row as AccuracyClaimRow;
  });
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
  "priority_origin", "priority_scoring",
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
  opts?: { for_update?: boolean },
): Promise<AccuracyClaimRow[]> {
  await ensureAccuracySchema();
  if (opts?.for_update && !accuracyTransactionActive()) throw new Error("Source claim locks require an Accuracy transaction.");
  const query = accuracyDb()
    .select()
    .from(t.accuracyClaims)
    .where(and(
      eq(t.accuracyClaims.workspace_id, workspace_id),
      eq(t.accuracyClaims.source_file_id, source_file_id),
      inArray(t.accuracyClaims.claim_type, ["gap", "tactic"]),
    ));
  const rows = await (opts?.for_update ? query.for("update") : query);
  return rows.filter(row => isActiveLedgerClaim(row) && isDownstreamClaim(row));
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
  requireClaimActor(args.actor);
  if (args.claim_ids.length === 0) {
    throw new Error("At least one claim_id is required.");
  }

  await ensureAccuracySchema();
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    await assertManagedClaimMutationAllowed(args.workspace_id, args.claim_ids);
    const existing = await accuracyDb().select().from(t.accuracyClaims).where(and(
      eq(t.accuracyClaims.workspace_id, args.workspace_id), inArray(t.accuracyClaims.id, args.claim_ids))).for("update");
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
      if (validated && prevMeta.structured) {
        const structured = (claim.claim_type === "tactic" ? tacticStructuredFieldsSchema : gapStructuredFieldsSchema).parse(prevMeta.structured);
        const { readParseBlocksByIds } = await import("./parse-store");
        const { listSourceFiles } = await import("./source-store");
        const spans = structuredProvenance(structured);
        const blocks = await readParseBlocksByIds(args.workspace_id, [...new Set(spans.map(span => span.block_id))]);
        const sources = await listSourceFiles(args.workspace_id);
        const error = validateFieldEvidence({ structured, provenance: [], source_file_id: claim.source_file_id ?? "manual", blocks,
          source_file_ids: new Set(sources.map(source => source.id)), resolved_source_ids: new Set(sources.map(source => source.id)) });
        if (error) throw new Error(`${error.field}: ${error.reason}`);
      }
      const lifecycle = ["completed", "ongoing", "planned", "proposed", "cancelled", "unknown"].includes(claim.status) ? claim.status : "unknown";
      const normalized = claim.claim_type === "tactic" && !prevMeta.tactic_status ? { ...prevMeta, tactic_status: lifecycle } : prevMeta;
      const factual_revision = claimFactualRevision({ ...claim, metadata: normalized });
      const metadata: AccuracyClaimMetadata = {
        ...normalized,
        factual_revision,
        validation_history: [...(Array.isArray(prevMeta.validation_history) ? prevMeta.validation_history : []), ...(prevMeta.validation ? [prevMeta.validation] : [])],
        validation: {
          ...(prevMeta.validation ?? {}),
          factual_revision,
          stale: false,
          action: args.action,
          rationale,
          at: now,
          by: args.actor.name,
          by_function: args.actor.function,
        },
        factual_validation_stale: false,
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
      if (!validated) {
        const joins = await accuracyDb().select().from(t.accuracyCoverageJoins).where(and(eq(t.accuracyCoverageJoins.workspace_id, args.workspace_id), eq(t.accuracyCoverageJoins.tactic_id, claim.id)));
        await invalidateAccuracyPriorityValidation(args.workspace_id, [claim.id, ...joins.map(join => join.gap_id)], now, "claim_validation_rejected");
      }
      updated.push({
        ...claim,
        validated,
        status: nextStatus,
        metadata,
        updated_at: now,
      });
    }

    return { updated: updated.length, claims: updated };
  });
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
  /** Merge a sparse patch under the workspace lock; replacement remains the default. */
  merge?: boolean;
}): Promise<AccuracyClaimRow> {
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const existing = args.merge ? await getClaim(args.workspace_id, args.claim_id) : null;
    return persistClaimPatch({ workspace_id: args.workspace_id, claim_id: args.claim_id,
      metadata: { ...(existing ? claimMetadata(existing) : {}), ...args.metadata } });
  });
}

export function claimMetadata(claim: AccuracyClaimRow): AccuracyClaimMetadata {
  return (claim.metadata ?? {}) as AccuracyClaimMetadata;
}

/** Active ledger rows — skip merged duplicates and rejected claims. */
export function isActiveLedgerClaim(claim: Pick<AccuracyClaimRow, "status">): boolean {
  return !["merged", "rejected", "retired", "split"].includes(claim.status);
}

export async function persistClaimPatch(args: {
  workspace_id: string;
  claim_id: string;
  status?: string;
  statement?: string;
  metadata?: AccuracyClaimMetadata;
  at?: string;
  expected_factual_revision?: string;
}): Promise<AccuracyClaimRow> {
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
      const [existing] = await accuracyDb().select().from(t.accuracyClaims).where(and(
        eq(t.accuracyClaims.id, args.claim_id), eq(t.accuracyClaims.workspace_id, args.workspace_id))).for("update");
      if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
      if (args.expected_factual_revision !== undefined && claimFactualRevision(existing) !== args.expected_factual_revision) {
        throw new Error("Claim factual inputs changed; reload before saving.");
      }
      const managed = await approvedClaimIdsForMutation(args.workspace_id);
      if (managed && !managed.has(args.claim_id)) throw new AssemblyReviewError("approval_required", "Claim changes require claims from the current approved assembly.");
      if (managed && args.statement !== undefined && args.statement !== existing.statement) throw new AssemblyReviewError("conflict", "Claim content changes require a revised approved assembly.");
      if (managed && args.status !== undefined && !APPROVED_PATCH_STATUS_VALUES.has(args.status)) throw new AssemblyReviewError("conflict", "Approved claim status changes are limited to documented workflow values.");
      const metadata = managed ? approvedOverlayMetadata(claimMetadata(existing), args.metadata ?? claimMetadata(existing))
        : { ...(args.metadata ?? claimMetadata(existing)), ...(claimMetadata(existing).history_only === true ? { history_only: true } : {}) };
      const at = args.at ?? nowIso();
      const next = invalidateClaimFacts(existing, { ...existing, statement: args.statement ?? existing.statement,
        metadata, status: args.status ?? existing.status, updated_at: at }, at);
      await accuracyDb().update(t.accuracyClaims).set({ statement: next.statement, status: next.status,
        validated: next.validated, metadata: next.metadata, updated_at: at }).where(and(
        eq(t.accuracyClaims.id, args.claim_id), eq(t.accuracyClaims.workspace_id, args.workspace_id)));
      if (claimFactualRevision(existing) !== claimFactualRevision(next)) {
        await invalidateDependentClaimValidation(args.workspace_id, args.claim_id, at);
        await syncClaimProvenance(next);
      }
      return next;
  });
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
      const locked = metaStringList(meta.human_locked);
      return {
        id: row.id,
        validated: row.validated,
        /** Keep a previously reviewed human schedule visible while its facts await revalidation. */
        schedule_visible: !row.validated && meta.previously_validated === true
          && meta.factual_validation_stale === true && (locked.includes("start") || locked.includes("end")),
        /** Human-entered dates are pinned: gantt continuity never shifts them. */
        dates_locked: locked.includes("start") || locked.includes("end"),
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
