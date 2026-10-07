import { and, desc, eq, inArray, or } from "drizzle-orm";
import { accuracyDb, accuracyTransactionActive, ensureAccuracySchema, withAccuracyTransaction } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import { claimFactualRevision, readStructuredFields, structuredProvenance, validateFieldEvidence,
  gapStructuredFieldsSchema, tacticStructuredFieldsSchema, type GapStructuredFields, type TacticStructuredFields } from "@/accuracy/domain/structured-fields";
import { provenanceSpanSchema } from "./quote-validator";

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
  | "merge_dismiss";

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
    validated: args.validated ?? false,
    source_file_id: args.source_file_id ?? null,
    metadata: (args.metadata ?? {}) as Record<string, unknown>,
    created_at: now,
    updated_at: now,
  };
  return withAccuracyTransaction(async () => {
      await accuracyDb().insert(t.accuracyClaims).values(row);
      await syncClaimProvenance(row as AccuracyClaimRow);
      return row as AccuracyClaimRow;
  });
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

/** Return every active gap and tactic for one source file, without the UI list limit. */
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
  return rows.filter(isActiveLedgerClaim);
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
  return withAccuracyTransaction(async () => {
    const existing = await accuracyDb().select().from(t.accuracyClaims).where(and(
      eq(t.accuracyClaims.workspace_id, args.workspace_id), inArray(t.accuracyClaims.id, args.claim_ids))).for("update");
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
}): Promise<AccuracyClaimRow> {
  return persistClaimPatch({ workspace_id: args.workspace_id, claim_id: args.claim_id, metadata: args.metadata });
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
  statement?: string;
  metadata?: AccuracyClaimMetadata;
  at?: string;
  expected_factual_revision?: string;
}): Promise<AccuracyClaimRow> {
  return withAccuracyTransaction(async () => {
      const [existing] = await accuracyDb().select().from(t.accuracyClaims).where(and(
        eq(t.accuracyClaims.id, args.claim_id), eq(t.accuracyClaims.workspace_id, args.workspace_id))).for("update");
      if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
      if (args.expected_factual_revision !== undefined && claimFactualRevision(existing) !== args.expected_factual_revision) {
        throw new Error("Claim factual inputs changed; reload before saving.");
      }
      const at = args.at ?? nowIso();
      const next = invalidateClaimFacts(existing, { ...existing, statement: args.statement ?? existing.statement,
        metadata: args.metadata ?? existing.metadata, status: args.status ?? existing.status, updated_at: at }, at);
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
  return claims
    .filter((row) => row.claim_type === "tactic")
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
        depends_on: metaStringList(meta.depends_on),
        tactic_type: metaString(meta.tactic_type),
        gap_ids: metaStringList(meta.gap_ids),
      };
    });
}

/** Map gap claims into parent links for Gantt coverage continuity. */
export function gapsForGantt(claims: AccuracyClaimRow[]) {
  return claims
    .filter((row) => row.claim_type === "gap")
    .map((row) => {
      const meta = claimMetadata(row);
      return {
        id: row.id,
        parent_gap_id: metaString(meta.parent_gap_id),
        validated: row.validated,
      };
    });
}
