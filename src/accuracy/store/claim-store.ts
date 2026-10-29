/** Stores ledger claims, validation decisions, and durable source evidence. */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { ProvenanceValidationError, validateClaimProvenance, validateClaimProvenanceChange, withProvenanceTransaction, type AccuracyTransaction } from "./provenance-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";

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
  status_override?: {
    status: string;
    rationale: string;
    at?: string;
    by?: string;
    by_function?: string;
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

type ClaimInsert = {
  id?: string;
  workspace_id: string;
  claim_type: AccuracyClaimType;
  statement: string;
  status?: string;
  validated?: boolean;
  source_file_id?: string | null;
  metadata?: AccuracyClaimMetadata;
};

/** Insert extraction/raw claims only after every citation has been verified. */
export async function insertClaim(args: ClaimInsert): Promise<AccuracyClaimRow> {
  return insertClaimWithEvidence(args, false);
}

/**
 * Human-create owner boundary: keep unsupported human annotations as metadata,
 * while persisting only verified citations as trusted evidence. Raw metadata
 * cannot opt into this policy through `insertClaim`.
 */
export async function insertHumanAuthoredClaim(args: ClaimInsert): Promise<AccuracyClaimRow> {
  return insertClaimWithEvidence(args, true);
}

/** Save a claim and its verified evidence in one workspace-locked transaction. */
async function insertClaimWithEvidence(args: ClaimInsert, allowHumanAnnotations: boolean): Promise<AccuracyClaimRow> {
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
  return withProvenanceTransaction(args.workspace_id, async (db) => {
    // Even human-created claims must name a source in their own workspace.
    const strictSpans = await validateClaimProvenance(db, {
      workspace_id: args.workspace_id,
      source_file_id: args.source_file_id,
      provenance: allowHumanAnnotations ? [] : args.metadata?.provenance,
    });
    const spans = allowHumanAnnotations
      ? await validateClaimProvenanceChange(db, row as AccuracyClaimRow, row.metadata, true)
      : strictSpans;
    await db.insert(t.accuracyClaims).values(row);
    const unique = new Map(spans.map((span) => [JSON.stringify([span.source_file_id, span.block_id, span.quote]), span]));
    if (unique.size) await db.insert(t.accuracyProvenance).values([...unique.values()].map((span) => ({
      id: newId("prov"), workspace_id: args.workspace_id, claim_id: row.id,
      source_file_id: span.source_file_id, block_id: span.block_id, quote: span.quote,
    })));
    return row as AccuracyClaimRow;
  });
}

/**
 * List workspace claims, filtering by type before limiting the newest rows.
 * Omitted limits retain the 200-row default; `null` explicitly loads all matches.
 */
export async function listClaims(
  workspace_id: string,
  opts?: { claim_type?: AccuracyClaimType; limit?: number | null },
): Promise<AccuracyClaimRow[]> {
  await ensureAccuracySchema();
  const limit = opts?.limit === undefined ? 200 : opts.limit;
  const query = accuracyDb()
    .select()
    .from(t.accuracyClaims)
    .where(
      and(
        eq(t.accuracyClaims.workspace_id, workspace_id),
        opts?.claim_type ? eq(t.accuracyClaims.claim_type, opts.claim_type) : undefined,
      ),
    )
    .orderBy(desc(t.accuracyClaims.updated_at));
  return limit === null ? query : query.limit(limit);
}

/** Read requested claims; a merge transaction also locks them until its commit. */
export async function getClaimsByIds(
  workspace_id: string,
  claim_ids: string[],
  transaction?: AccuracyTransaction,
): Promise<AccuracyClaimRow[]> {
  if (claim_ids.length === 0) return [];
  await ensureAccuracySchema();
  const query = (transaction ?? accuracyDb())
    .select()
    .from(t.accuracyClaims)
    .where(
      and(
        eq(t.accuracyClaims.workspace_id, workspace_id),
        inArray(t.accuracyClaims.id, claim_ids),
      ),
    );
  const rows = transaction ? await query.for("update") : await query;
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

  const validation: ClaimValidationMeta = {
    action: args.action, rationale, at: now,
    by: args.actor.name, by_function: args.actor.function,
  };
  for (const claim of existing) {
    const [row] = await accuracyDb()
      .update(t.accuracyClaims)
      .set({
        validated,
        status: nextStatus,
        // Update this field on the database's current JSON, never a prior read.
        metadata: sql`jsonb_set(coalesce(${t.accuracyClaims.metadata}, '{}'::jsonb), '{validation}', ${JSON.stringify(validation)}::jsonb)`,
        updated_at: now,
      })
      .where(and(eq(t.accuracyClaims.id, claim.id), eq(t.accuracyClaims.workspace_id, args.workspace_id)))
      .returning();
    if (!row) throw new Error(`Unknown claim: ${claim.id}`);
    updated.push(row);
  }

  return { updated: updated.length, claims: updated };
}

export async function getClaim(
  workspace_id: string,
  claim_id: string,
  transaction?: AccuracyTransaction,
): Promise<AccuracyClaimRow | null> {
  const rows = await getClaimsByIds(workspace_id, [claim_id], transaction);
  return rows[0] ?? null;
}

export async function updateClaimMetadata(args: {
  workspace_id: string;
  claim_id: string;
  metadata: AccuracyClaimMetadata;
}): Promise<AccuracyClaimRow> {
  return persistClaimPatch(args);
}

export function claimMetadata(claim: AccuracyClaimRow): AccuracyClaimMetadata {
  return (claim.metadata ?? {}) as AccuracyClaimMetadata;
}

/** Active ledger rows — skip merged duplicates and rejected claims. */
export function isActiveLedgerClaim(claim: Pick<AccuracyClaimRow, "status">): boolean {
  return claim.status !== "merged" && claim.status !== "rejected";
}

/**
 * Persist ordinary fields without replacing current evidence. Intentional evidence
 * changes supply the prior snapshot, then validate and replace rows atomically.
 */
export async function persistClaimPatch(args: {
  workspace_id: string;
  claim_id: string;
  statement?: string;
  status?: string;
  metadata?: AccuracyClaimMetadata;
  at?: string;
  provenance_update?: { previous: unknown; allow_human_annotations?: boolean };
  /** Reuse the caller's workspace-locked transaction for coupled merge writes. */
  transaction?: AccuracyTransaction;
}): Promise<AccuracyClaimRow> {
  await ensureAccuracySchema();
  const now = args.at ?? nowIso();
  const fields = {
    ...(args.statement !== undefined ? { statement: args.statement } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    updated_at: now,
  };
  const where = and(eq(t.accuracyClaims.id, args.claim_id), eq(t.accuracyClaims.workspace_id, args.workspace_id));
  if (args.provenance_update) {
    const update = args.provenance_update;
    if (!args.metadata) throw new ProvenanceValidationError("missing_metadata");
    const metadata = args.metadata;
    const replace = async (db: AccuracyTransaction) => {
      const [existing] = await db.select().from(t.accuracyClaims).where(where);
      if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
      const [matching] = await db.select({ id: t.accuracyClaims.id }).from(t.accuracyClaims).where(and(where,
        sql`coalesce(${t.accuracyClaims.metadata}->'provenance', 'null'::jsonb) = ${JSON.stringify(update.previous ?? null)}::jsonb`,
      ));
      if (!matching) throw new ProvenanceValidationError("stale_provenance_retry");
      const spans = await validateClaimProvenanceChange(db, existing, metadata, update.allow_human_annotations);
      await db.delete(t.accuracyProvenance).where(and(eq(t.accuracyProvenance.workspace_id, args.workspace_id), eq(t.accuracyProvenance.claim_id, args.claim_id)));
      const unique = new Map(spans.map((span) => [JSON.stringify([span.source_file_id, span.block_id, span.quote]), span]));
      if (unique.size) await db.insert(t.accuracyProvenance).values([...unique.values()].map((span) => ({
        id: newId("prov"), workspace_id: args.workspace_id, claim_id: args.claim_id,
        source_file_id: span.source_file_id, block_id: span.block_id, quote: span.quote,
      })));
      const [row] = await db.update(t.accuracyClaims).set({ ...fields, metadata }).where(where).returning();
      return row!;
    };
    return args.transaction ? replace(args.transaction) : withProvenanceTransaction(args.workspace_id, replace);
  }
  const metadataPatch = args.metadata ? { ...args.metadata } : undefined;
  if (metadataPatch) delete metadataPatch.provenance;
  const preservedFields = sql`case when coalesce(${t.accuracyClaims.metadata}, '{}'::jsonb) ? 'provenance' then jsonb_build_object('provenance', ${t.accuracyClaims.metadata}->'provenance') else '{}'::jsonb end`;
  const [row] = await (args.transaction ?? accuracyDb()).update(t.accuracyClaims).set({
    ...fields,
    ...(metadataPatch ? {
      // A caller may have prepared a complete snapshot before a split/merge.
      // Keep evidence from the database's current row.
      metadata: sql`${JSON.stringify(metadataPatch)}::jsonb || ${preservedFields}`,
    } : {}),
  }).where(where).returning();
  if (!row) throw new Error(`Unknown claim: ${args.claim_id}`);
  return row;
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
