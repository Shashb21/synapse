/** Clone a selected accuracy workspace state for an isolated experiment. */

import { splitFingerprint, type SplitSnapshot } from "@/accuracy/store/partial-split-store";
import { rebaseCopiedCoverage, type CoverageJoinRow } from "@/accuracy/store/coverage-store";
import { createHash } from "node:crypto";
import { claimFactualRevision, claimValidationFreshness } from "@/accuracy/domain/structured-fields";
import { and, asc, eq, inArray } from "drizzle-orm";
import { accuracyDb, accuracyTransactionActive, ensureAccuracySchema, lockAccuracyWorkspace, withAccuracyTransaction } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { newId, nowIso } from "@/modules/kernel/ids";

export type CopyExperimentWorkspaceArgs = {
  source_workspace_id: string;
  source_file_ids: string[];
};

export type CopyExperimentWorkspaceResult = {
  workspace_id: string;
  org_id: string;
  source_id_map: Record<string, string>;
  block_id_map: Record<string, string>;
  claim_id_map: Record<string, string>;
  source_fingerprint: string;
  baseline_fingerprint: string;
  baseline_snapshot: unknown;
};

export type ExperimentCopyErrorCode =
  | "invalid_source_set"
  | "unknown_workspace"
  | "unknown_source"
  | "cross_workspace_source"
  | "gold_baseline"
  | "unresolved_reference"
  | "nested_transaction";

/** A typed validation error raised before an experiment copy can be committed. */
export class ExperimentCopyError extends Error {
  readonly code: ExperimentCopyErrorCode;

  constructor(code: ExperimentCopyErrorCode, message: string) {
    super(message);
    this.name = "ExperimentCopyError";
    this.code = code;
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return String(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function sortedById<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceReferences(value: unknown): Array<{ source_file_id: string; block_id: string }> {
  const metadata = metadataRecord(value);
  const provenance = metadata.provenance;
  if (!Array.isArray(provenance)) return [];
  return provenance.flatMap((item) => {
    const row = metadataRecord(item);
    const source_file_id = nonBlankString(row.source_file_id);
    const block_id = nonBlankString(row.block_id);
    return source_file_id && block_id ? [{ source_file_id, block_id }] : [];
  });
}

/** Resolve a workspace-owned metadata reference without preserving live IDs. */
function remapReference(key: string, value: unknown, ids: Record<string, string>): string {
  if (typeof value !== "string" || !Object.hasOwn(ids, value)) {
    throw new ExperimentCopyError("unresolved_reference", `Metadata ${key} points outside the selected baseline: ${String(value)}`);
  }
  return ids[value];
}

type ReferenceMaps = {
  source: Record<string, string>;
  block: Record<string, string>;
  claim: Record<string, string>;
  operation?: Record<string, string>;
  workspace?: Record<string, string>;
};
/** Remap supported claim relationships, merge lineage, and source provenance. */
function remapMetadata(value: unknown, maps: ReferenceMaps): unknown {
  if (Array.isArray(value)) return value.map((item) => remapMetadata(item, maps));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const ids = key === "source_file_id" ? maps.source : key === "block_id" ? maps.block
      : ["claim_id", "gap_id", "tactic_id", "parent_gap_id", "merged_into", "addressed_gap_id", "open_residual_gap_id", "stale_claim_id"].includes(key) ? maps.claim
      : ["operation_id", "split_operation_id", "retired_by_rollback"].includes(key) ? maps.operation ?? {}
      : key === "workspace_id" ? maps.workspace ?? {} : null;
    if (ids) return [key, child === null ? null : remapReference(key, child, ids)];
    if (["merged_from", "gap_ids", "depends_on", "addressed_tactic_ids"].includes(key)) {
      if (!Array.isArray(child)) throw new ExperimentCopyError("unresolved_reference", `Metadata ${key} must be an array of claim IDs.`);
      return [key, child.map((item) => remapReference(key, item, maps.claim))];
    }
    return [key, remapMetadata(child, maps)];
  }));
}

/** Translate typed coverage records, including retired/deleted rows retained in history.
 * Revision tokens, actor fields and prose are audit facts, not ID references.
 */
function remapCoverageRecord(value: unknown, maps: ReferenceMaps & { coverage: Map<string, string> }): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    if (key === "id") {
      if (typeof child !== "string" || !child.trim()) {
        throw new ExperimentCopyError("unresolved_reference", "Historical coverage ID must be a nonempty string.");
      }
      // History may retain a join removed by merge/deduplication. Allocate once so
      // every occurrence in live rows and operation snapshots remains identical.
      if (!maps.coverage.has(child)) maps.coverage.set(child, newId("cov"));
      return [key, maps.coverage.get(child)];
    }
    if (key === "dimensions" && child && typeof child === "object" && !Array.isArray(child)) {
      return [key, Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([dimension, fact]) => {
        if (["decision_history", "merge_history", "legacy_duplicates"].includes(dimension) && Array.isArray(fact)) {
          return [dimension, fact.map(row => remapCoverageRecord(row, maps))];
        }
        if (dimension === "legacy_rejection") return [dimension, remapCoverageRecord(fact, maps)];
        if (dimension === "evidence" && Array.isArray(fact)) {
          return [dimension, fact.map(id => remapReference("evidence", id, maps.block))];
        }
        return [dimension, metadataRecord(remapMetadata({ [dimension]: fact }, maps))[dimension]];
      }))];
    }
    return [key, metadataRecord(remapMetadata({ [key]: child }, maps))[key]];
  }));
}

function sourceErrorForRows(args: {
  requested: string[];
  sourceRows: Array<{ id: string; workspace_id: string }>;
  source_workspace_id: string;
}): never | void {
  const found = new Map(args.sourceRows.map((row) => [row.id, row]));
  const missing = args.requested.filter((id) => !found.has(id));
  if (missing.length === 0) return;
  const crossWorkspace = args.sourceRows.filter((row) => row.workspace_id !== args.source_workspace_id).map((row) => row.id);
  if (crossWorkspace.length > 0) {
    throw new ExperimentCopyError("cross_workspace_source", `Source file belongs to another workspace: ${crossWorkspace.join(", ")}`);
  }
  throw new ExperimentCopyError("unknown_source", `Unknown source file: ${missing.join(", ")}`);
}

/**
 * Clone the selected source files and their baseline knowledge-base rows.
 *
 * @param args Source workspace and the exact source file IDs to copy.
 * @returns New workspace IDs, old-to-new maps, deterministic fingerprints, and a copy snapshot.
 * @throws {ExperimentCopyError} If the source set or any baseline reference is invalid.
 */
export async function copyExperimentWorkspace(
  args: CopyExperimentWorkspaceArgs,
): Promise<CopyExperimentWorkspaceResult> {
  if (args.source_file_ids.length === 0 || new Set(args.source_file_ids).size !== args.source_file_ids.length) {
    throw new ExperimentCopyError("invalid_source_set", "At least one distinct source file is required.");
  }
  if (accuracyTransactionActive()) {
    throw new ExperimentCopyError(
      "nested_transaction",
      "copyExperimentWorkspace requires a top-level accuracy transaction for repeatable-read isolation.",
    );
  }

  await ensureAccuracySchema();
  return withAccuracyTransaction(async () => {
    const db = accuracyDb();
    // Match extraction-batch and omission-review mutations so the baseline is read
    // after all earlier workspace writes and no coordinated write can interleave.
    await lockAccuracyWorkspace(args.source_workspace_id);
    const workspaceRows = await db.select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.id, args.source_workspace_id)).limit(1);
    const sourceWorkspace = workspaceRows[0];
    if (!sourceWorkspace) throw new ExperimentCopyError("unknown_workspace", `Unknown workspace: ${args.source_workspace_id}`);
    const orgRows = await db.select().from(t.accuracyOrganizations).where(eq(t.accuracyOrganizations.id, sourceWorkspace.org_id)).limit(1);
    const sourceOrg = orgRows[0];
    if (!sourceOrg) throw new ExperimentCopyError("unknown_workspace", `Workspace organization is missing: ${sourceWorkspace.org_id}`);

    const allSourceRows = await db.select().from(t.accuracySourceFiles).where(inArray(t.accuracySourceFiles.id, args.source_file_ids));
    const requestedSourceRows = allSourceRows.filter((row) => row.workspace_id === args.source_workspace_id);
    const crossWorkspaceRows = allSourceRows.filter((row) => row.workspace_id !== args.source_workspace_id);
    if (crossWorkspaceRows.length > 0) {
      throw new ExperimentCopyError("cross_workspace_source", `Source file belongs to another workspace: ${crossWorkspaceRows.map((row) => row.id).join(", ")}`);
    }
    if (requestedSourceRows.length !== args.source_file_ids.length) {
      const missing = args.source_file_ids.filter((id) => !requestedSourceRows.some((row) => row.id === id));
      throw new ExperimentCopyError("unknown_source", `Unknown source file: ${missing.join(", ")}`);
    }
    sourceErrorForRows({ requested: args.source_file_ids, sourceRows: allSourceRows, source_workspace_id: args.source_workspace_id });
    const selectedSourceIds = new Set(args.source_file_ids);
    if (requestedSourceRows.some((row) => nonBlankString(row.reference_pack_id))) {
      throw new ExperimentCopyError("gold_baseline", "Gold reference-pack sources cannot be used as experiment baselines.");
    }

    const sourceRows = sortedById(requestedSourceRows);
    const source_id_map = Object.fromEntries(sourceRows.map((row) => [row.id, newId("src")]));
    const blockRows = await db.select().from(t.accuracyParseBlocks)
      .where(and(eq(t.accuracyParseBlocks.workspace_id, args.source_workspace_id), inArray(t.accuracyParseBlocks.source_file_id, args.source_file_ids)))
      .orderBy(asc(t.accuracyParseBlocks.source_file_id), asc(t.accuracyParseBlocks.index), asc(t.accuracyParseBlocks.id));
    const block_id_map = Object.fromEntries(blockRows.map((row) => [row.id, newId("block")]));
    const blockById = new Map(blockRows.map((row) => [row.id, row]));

    const provenanceRows = await db.select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, args.source_workspace_id));
    const claimRows = await db.select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, args.source_workspace_id));
    const claimIdsForSources = new Set(claimRows.filter((row) => row.source_file_id && selectedSourceIds.has(row.source_file_id)).map((row) => row.id));
    for (const row of provenanceRows) {
      if (selectedSourceIds.has(row.source_file_id)) claimIdsForSources.add(row.claim_id);
    }
    for (const claim of claimRows) {
      const refs = sourceReferences(claim.metadata);
      if (refs.some((ref) => selectedSourceIds.has(ref.source_file_id))) claimIdsForSources.add(claim.id);
    }
    const copiedClaimRows = sortedById(claimRows.filter((row) => claimIdsForSources.has(row.id)));
    const claim_id_map = Object.fromEntries(copiedClaimRows.map((row) => [row.id, newId(row.claim_type === "gap" ? "gap" : "tac")]));
    const copiedClaimIds = new Set(copiedClaimRows.map((row) => row.id));

    for (const claim of copiedClaimRows) {
      const metadata = metadataRecord(claim.metadata);
      if (nonBlankString(metadata.reference_pack_id) && nonBlankString(metadata.source_badge)) {
        throw new ExperimentCopyError("gold_baseline", `Gold-seeded claim cannot be used as a baseline: ${claim.id}`);
      }
      if (claim.source_file_id && !selectedSourceIds.has(claim.source_file_id)) {
        throw new ExperimentCopyError("unresolved_reference", `Claim ${claim.id} points to an omitted source file.`);
      }
      for (const ref of sourceReferences(metadata)) {
        if (!selectedSourceIds.has(ref.source_file_id)) {
          throw new ExperimentCopyError("unresolved_reference", `Claim ${claim.id} points to an omitted source file: ${ref.source_file_id}`);
        }
        const block = blockById.get(ref.block_id);
        if (!block || block.source_file_id !== ref.source_file_id) {
          throw new ExperimentCopyError("unresolved_reference", `Claim ${claim.id} points to an unresolved or crossed parse block: ${ref.block_id}`);
        }
      }
    }

    const copiedProvenanceRows = sortedById(provenanceRows.filter((row) => copiedClaimIds.has(row.claim_id)));
    const provenance_id_map = Object.fromEntries(copiedProvenanceRows.map((row) => [row.id, newId("prov")]));
    for (const row of copiedProvenanceRows) {
      const block = blockById.get(row.block_id);
      if (!selectedSourceIds.has(row.source_file_id) || !block || block.source_file_id !== row.source_file_id) {
        throw new ExperimentCopyError("unresolved_reference", `Provenance ${row.id} points outside the selected source set.`);
      }
    }
    for (const row of provenanceRows) {
      if (selectedSourceIds.has(row.source_file_id) && !copiedClaimIds.has(row.claim_id)) {
        throw new ExperimentCopyError("unresolved_reference", `Provenance ${row.id} points to an omitted claim.`);
      }
    }

    const coverageRows = await db.select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, args.source_workspace_id));
    const copiedCoverageRows = sortedById(coverageRows.filter((row) => copiedClaimIds.has(row.gap_id) || copiedClaimIds.has(row.tactic_id)));
    const coverage_id_map = new Map(copiedCoverageRows.map((row) => [row.id, newId("cov")]));
    for (const row of copiedCoverageRows) {
      if (!copiedClaimIds.has(row.gap_id) || !copiedClaimIds.has(row.tactic_id)) {
        throw new ExperimentCopyError("unresolved_reference", `Coverage join ${row.id} points to an omitted claim.`);
      }
    }
    let copiedCoverage = copiedCoverageRows.filter((row) => copiedClaimIds.has(row.gap_id) && copiedClaimIds.has(row.tactic_id));

    const splitRows = await db.select().from(t.accuracySplitOperations).where(eq(t.accuracySplitOperations.workspace_id, args.source_workspace_id));
    const copiedSplitRows = sortedById(splitRows.filter(op => [op.parent_gap_id, op.addressed_gap_id, op.open_residual_gap_id].some(id => copiedClaimIds.has(id))));
    const operation_id_map = Object.fromEntries(copiedSplitRows.map(op => [op.id, newId("split")]));
    for (const op of copiedSplitRows) {
      const snapshot = op.snapshot as SplitSnapshot;
      if ([op.parent_gap_id, op.addressed_gap_id, op.open_residual_gap_id, ...snapshot.dependencies.map(d => d.id)].some(id => !copiedClaimIds.has(id))) {
        throw new ExperimentCopyError("unresolved_reference", `Split ${op.id} points to omitted claims or supporting tactics.`);
      }
    }
    const org_id = newId("org");
    const workspace_id = newId("ws");
    const referenceMaps = { source: source_id_map, block: block_id_map, claim: claim_id_map,
      operation: operation_id_map, workspace: { [args.source_workspace_id]: workspace_id }, coverage: coverage_id_map };
    const copiedMetadata = new Map(copiedClaimRows.map((claim) => [claim.id,
      remapMetadata(claim.metadata, { source: source_id_map, block: block_id_map, claim: claim_id_map, operation: operation_id_map, workspace: { [args.source_workspace_id]: workspace_id } }) as Record<string, unknown>,
    ]));

    // A trusted, isomorphic baseline copy changes IDs rather than facts. Translate
    // current human decision tokens only; never freshen legacy or stale decisions.
    for (const claim of copiedClaimRows) {
      if (claimValidationFreshness(claim) !== "current") continue;
      const metadata = copiedMetadata.get(claim.id)!;
      const revision = claimFactualRevision({ ...claim, id: claim_id_map[claim.id], workspace_id,
        source_file_id: claim.source_file_id ? source_id_map[claim.source_file_id] : null, metadata });
      const validation = metadata.validation as Record<string, unknown>;
      metadata.factual_revision = revision;
      metadata.validation = { ...validation, copied_from_factual_revision: validation.factual_revision, factual_revision: revision };
    }
    const claimsById = new Map(copiedClaimRows.map((claim) => [claim.id, claim]));
    const copiedClaim = (claim: typeof t.accuracyClaims.$inferSelect) => ({ ...claim, id: claim_id_map[claim.id], workspace_id,
      source_file_id: claim.source_file_id ? source_id_map[claim.source_file_id] : null, metadata: copiedMetadata.get(claim.id)! });
    const copyCoverage = (join: CoverageJoinRow, gap: typeof t.accuracyClaims.$inferSelect, tactic: typeof t.accuracyClaims.$inferSelect,
      copied_gap: typeof t.accuracyClaims.$inferSelect, copied_tactic: typeof t.accuracyClaims.$inferSelect): CoverageJoinRow => {
      const translated = remapCoverageRecord(join, referenceMaps) as CoverageJoinRow;
      const rebased = rebaseCopiedCoverage({ join, gap, tactic, copied_gap, copied_tactic, block_id_map });
      if (rebased === join) return translated;
      const tokens = metadataRecord(rebased.dimensions);
      return { ...translated, dimensions: { ...metadataRecord(translated.dimensions),
        gap_revision: tokens.gap_revision, tactic_revision: tokens.tactic_revision, copied_from_revisions: tokens.copied_from_revisions } };
    };
    copiedCoverage = copiedCoverage.map((join) => {
      const gap = claimsById.get(join.gap_id)!, tactic = claimsById.get(join.tactic_id)!;
      return copyCoverage(join, gap, tactic, copiedClaim(gap), copiedClaim(tactic));
    });
    // Rebase the historical snapshot itself, never replace it with current rows:
    // later edits must continue to block rollback in the isolated copy.
    const snapshotClaim = (claim: typeof t.accuracyClaims.$inferSelect) => {
      const metadata = remapMetadata(claim.metadata, { source: source_id_map, block: block_id_map, claim: claim_id_map, operation: operation_id_map, workspace: { [args.source_workspace_id]: workspace_id } }) as Record<string, unknown>;
      const row = { ...claim, id: claim_id_map[claim.id], workspace_id, source_file_id: claim.source_file_id ? source_id_map[claim.source_file_id] : null, metadata };
      if (claimValidationFreshness(claim) === "current") {
        const validation = metadata.validation as Record<string, unknown>;
        const revision = claimFactualRevision(row);
        metadata.factual_revision = revision;
        metadata.validation = { ...validation, copied_from_factual_revision: validation.factual_revision, factual_revision: revision };
      }
      return row;
    };
    const copiedSplits = copiedSplitRows.map(op => {
      const snapshot = op.snapshot as SplitSnapshot;
      const after_claims = sortedById(snapshot.after_claims.map(snapshotClaim));
      const after_coverage = snapshot.after_coverage.map(join => {
        const gap = snapshot.after_claims.find(c => c.id === join.gap_id)!;
        const tactic = claimsById.get(join.tactic_id)!;
        // Historical coverage can refer to later-retired children; preserve history
        // and rebase only factual tokens known to match the saved inputs.
        return copyCoverage(join, gap, tactic, snapshotClaim(gap), copiedClaim(tactic));
      });
      const after_provenance = snapshot.after_provenance.map(row => ({ ...row, id: provenance_id_map[row.id] ?? newId("prov"), workspace_id,
        claim_id: claim_id_map[row.claim_id], source_file_id: source_id_map[row.source_file_id], block_id: block_id_map[row.block_id] }));
      const dependencies = snapshot.dependencies.map(d => {
        const original = claimsById.get(d.id)!;
        return { id: claim_id_map[d.id], revision: d.revision === claimFactualRevision(original) ? claimFactualRevision(copiedClaim(original)) : d.revision };
      });
      const copied_snapshot: SplitSnapshot = { before_parent: snapshotClaim(snapshot.before_parent), after_claims, after_coverage, after_provenance, dependencies,
        evidence_state: { blocks: sortedById(snapshot.evidence_state.blocks.map(row => ({ ...row, id: block_id_map[row.id], workspace_id, source_file_id: source_id_map[row.source_file_id] }))),
          sources: sortedById(snapshot.evidence_state.sources.map(row => ({ ...row, id: source_id_map[row.id], workspace_id, org_id }))) } };
      return { ...op, id: operation_id_map[op.id], workspace_id, parent_gap_id: claim_id_map[op.parent_gap_id],
        addressed_gap_id: claim_id_map[op.addressed_gap_id], open_residual_gap_id: claim_id_map[op.open_residual_gap_id],
        // Historical requests remain audit data, never authorization to replay a source-workspace request.
        operation_key: `copied:${operation_id_map[op.id]}`, request_fingerprint: splitFingerprint({ copied_from: op.request_fingerprint, workspace_id }),
        snapshot: copied_snapshot, audit: remapMetadata(op.audit, { source: source_id_map, block: block_id_map, claim: claim_id_map, operation: operation_id_map, workspace: { [args.source_workspace_id]: workspace_id } }) };
    });
    const created_at = nowIso();
    await db.insert(t.accuracyOrganizations).values({ id: org_id, name: `${sourceOrg.name} (experiment)`, created_at });
    await db.insert(t.accuracyWorkspaces).values({
      id: workspace_id,
      org_id,
      name: `${sourceWorkspace.name} (experiment)`,
      slug: `${sourceWorkspace.slug}-experiment-${workspace_id.slice(-8)}`,
      planning_context: sourceWorkspace.planning_context,
      created_at,
      archived_at: null,
    });
    await db.insert(t.accuracySourceFiles).values(sourceRows.map((row) => ({
      id: source_id_map[row.id], workspace_id, org_id, filename: row.filename, mime: row.mime,
      doc_role: row.doc_role, checksum: row.checksum, uploaded_at: row.uploaded_at, reference_pack_id: null,
    })));
    if (blockRows.length > 0) {
      await db.insert(t.accuracyParseBlocks).values(blockRows.map((row) => ({
        id: block_id_map[row.id], workspace_id, source_file_id: source_id_map[row.source_file_id], index: row.index,
        kind: row.kind, heading: row.heading, text: row.text, parser: row.parser, created_at: row.created_at,
      })));
    }
    if (copiedClaimRows.length > 0) {
      await db.insert(t.accuracyClaims).values(copiedClaimRows.map((row) => ({
        id: claim_id_map[row.id], workspace_id, claim_type: row.claim_type, statement: row.statement, status: row.status,
        validated: row.validated, source_file_id: row.source_file_id ? source_id_map[row.source_file_id] : null,
        metadata: copiedMetadata.get(row.id)!,
        created_at: row.created_at, updated_at: row.updated_at,
      })));
    }
    if (copiedProvenanceRows.length > 0) {
      await db.insert(t.accuracyProvenance).values(copiedProvenanceRows.map((row) => ({
        id: provenance_id_map[row.id], workspace_id, claim_id: claim_id_map[row.claim_id], source_file_id: source_id_map[row.source_file_id],
        block_id: block_id_map[row.block_id], quote: row.quote,
      })));
    }
    if (copiedCoverage.length > 0) {
      await db.insert(t.accuracyCoverageJoins).values(copiedCoverage);
    }

    if (copiedSplits.length) await db.insert(t.accuracySplitOperations).values(copiedSplits);

    const baseline_snapshot = {
      split_operations: copiedSplits,
      source_files: sourceRows.map((row) => ({ original_id: row.id, copied_id: source_id_map[row.id], ...row, id: source_id_map[row.id], workspace_id, org_id })),
      parse_blocks: blockRows.map((row) => ({ original_id: row.id, copied_id: block_id_map[row.id], ...row, id: block_id_map[row.id], workspace_id, source_file_id: source_id_map[row.source_file_id] })),
      claims: copiedClaimRows.map((row) => ({ original_id: row.id, copied_id: claim_id_map[row.id], ...row, id: claim_id_map[row.id], workspace_id, source_file_id: row.source_file_id ? source_id_map[row.source_file_id] : null, metadata: copiedMetadata.get(row.id)! })),
      provenance: copiedProvenanceRows.map((row) => ({ original_id: row.id, copied_id: provenance_id_map[row.id], ...row, id: provenance_id_map[row.id], workspace_id, claim_id: claim_id_map[row.claim_id], source_file_id: source_id_map[row.source_file_id], block_id: block_id_map[row.block_id] })),
      coverage_joins: copiedCoverage.map((row, index) => ({ original_id: copiedCoverageRows[index].id, copied_id: row.id, ...row })),
    };
    const source_fingerprint = fingerprint(sourceRows);
    const baseline_fingerprint = fingerprint({
      source_files: sourceRows,
      parse_blocks: blockRows,
      claims: copiedClaimRows,
      provenance: copiedProvenanceRows,
      // Fingerprint the source facts, not the randomly allocated copied references.
      coverage_joins: copiedCoverageRows,
      split_operations: copiedSplitRows,
    });
    return { workspace_id, org_id, source_id_map, block_id_map, claim_id_map, source_fingerprint, baseline_fingerprint, baseline_snapshot };
  }, { isolationLevel: "repeatable read" });
}
