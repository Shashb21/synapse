/** Clone a selected accuracy workspace state for an isolated experiment. */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withAccuracyTransaction, accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
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
  | "unresolved_reference";

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

function remapMetadata(value: unknown, maps: {
  source: Record<string, string>;
  block: Record<string, string>;
  claim: Record<string, string>;
}): unknown {
  if (Array.isArray(value)) return value.map((item) => remapMetadata(item, maps));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    if (typeof child === "string") {
      if (key === "source_file_id") return [key, maps.source[child] ?? child];
      if (key === "block_id") return [key, maps.block[child] ?? child];
      if (["claim_id", "gap_id", "tactic_id", "merged_into"].includes(key)) {
        return [key, maps.claim[child] ?? child];
      }
    }
    if (key === "merged_from" || key === "gap_ids") {
      return [key, Array.isArray(child) ? child.map((item) => typeof item === "string" ? maps.claim[item] ?? item : item) : child];
    }
    return [key, remapMetadata(child, maps)];
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

  await ensureAccuracySchema();
  return withAccuracyTransaction(async () => {
    const db = accuracyDb();
    // Ordinary claim/source/coverage writers do not all take the advisory lock.
    // Repeatable-read fixes the transaction snapshot even when one commits between reads.
    await db.execute(sql`set transaction isolation level repeatable read`);
    // Match extraction-batch and omission-review mutations so the baseline is read
    // after all earlier workspace writes and no coordinated write can interleave.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omission:${args.source_workspace_id}`}, 0))`);
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
    const coverage_id_map = Object.fromEntries(copiedCoverageRows.map((row) => [row.id, newId("cov")]));
    for (const row of copiedCoverageRows) {
      if (!copiedClaimIds.has(row.gap_id) || !copiedClaimIds.has(row.tactic_id)) {
        throw new ExperimentCopyError("unresolved_reference", `Coverage join ${row.id} points to an omitted claim.`);
      }
    }
    const copiedCoverage = copiedCoverageRows.filter((row) => copiedClaimIds.has(row.gap_id) && copiedClaimIds.has(row.tactic_id));

    const org_id = newId("org");
    const workspace_id = newId("ws");
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
    await db.insert(t.accuracyClaims).values(copiedClaimRows.map((row) => ({
      id: claim_id_map[row.id], workspace_id, claim_type: row.claim_type, statement: row.statement, status: row.status,
      validated: row.validated, source_file_id: row.source_file_id ? source_id_map[row.source_file_id] : null,
      metadata: remapMetadata(row.metadata, { source: source_id_map, block: block_id_map, claim: claim_id_map }) as Record<string, unknown>,
      created_at: row.created_at, updated_at: row.updated_at,
    })));
    if (copiedProvenanceRows.length > 0) {
      await db.insert(t.accuracyProvenance).values(copiedProvenanceRows.map((row) => ({
        id: provenance_id_map[row.id], workspace_id, claim_id: claim_id_map[row.claim_id], source_file_id: source_id_map[row.source_file_id],
        block_id: block_id_map[row.block_id], quote: row.quote,
      })));
    }
    if (copiedCoverage.length > 0) {
      await db.insert(t.accuracyCoverageJoins).values(copiedCoverage.map((row) => ({
        id: coverage_id_map[row.id], workspace_id, gap_id: claim_id_map[row.gap_id], tactic_id: claim_id_map[row.tactic_id],
        overall: row.overall, dimensions: row.dimensions, confidence: row.confidence, validated: row.validated, rationale: row.rationale,
      })));
    }

    const baseline_snapshot = {
      source_files: sourceRows.map((row) => ({ original_id: row.id, copied_id: source_id_map[row.id], ...row, id: source_id_map[row.id], workspace_id, org_id })),
      parse_blocks: blockRows.map((row) => ({ original_id: row.id, copied_id: block_id_map[row.id], ...row, id: block_id_map[row.id], workspace_id, source_file_id: source_id_map[row.source_file_id] })),
      claims: copiedClaimRows.map((row) => ({ original_id: row.id, copied_id: claim_id_map[row.id], ...row, id: claim_id_map[row.id], workspace_id, source_file_id: row.source_file_id ? source_id_map[row.source_file_id] : null, metadata: remapMetadata(row.metadata, { source: source_id_map, block: block_id_map, claim: claim_id_map }) })),
      provenance: copiedProvenanceRows.map((row) => ({ original_id: row.id, copied_id: provenance_id_map[row.id], ...row, id: provenance_id_map[row.id], workspace_id, claim_id: claim_id_map[row.claim_id], source_file_id: source_id_map[row.source_file_id], block_id: block_id_map[row.block_id] })),
      coverage_joins: copiedCoverage.map((row) => ({ original_id: row.id, copied_id: coverage_id_map[row.id], ...row, id: coverage_id_map[row.id], workspace_id, gap_id: claim_id_map[row.gap_id], tactic_id: claim_id_map[row.tactic_id] })),
    };
    const source_fingerprint = fingerprint(sourceRows);
    const baseline_fingerprint = fingerprint({
      source_files: sourceRows,
      parse_blocks: blockRows,
      claims: copiedClaimRows,
      provenance: copiedProvenanceRows,
      coverage_joins: copiedCoverage,
    });
    return { workspace_id, org_id, source_id_map, block_id_map, claim_id_map, source_fingerprint, baseline_fingerprint, baseline_snapshot };
  });
}
