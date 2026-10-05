/** Exact model-origin candidate validation and copy-only inventory replacement. */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { assemblyFingerprint, type Assembly } from "@/accuracy/domain/assembly";
import { generatedItemFingerprint } from "@/accuracy/domain/item-history";
import { readAssembly, resolveAssemblyItems } from "@/accuracy/store/assembly-store";
import { accuracyDb, withAccuracyTransaction } from "@/accuracy/store/db";
import { insertClaim } from "@/accuracy/store/claim-store";
import { validateProvenance, provenanceSpanSchema, type ParseBlock } from "@/accuracy/store/quote-validator";
import { lockAssemblyWorkspace, withAssemblyExperiment } from "@/accuracy/kernel/assembly-context";
import * as t from "@/accuracy/store/schema";
import { newId } from "@/modules/kernel/ids";
import type { CopyExperimentWorkspaceResult } from "./copy-workspace";
import { MIXED_PIPELINE_STAGES, MixedComparisonError, mixedComparisonRequestSchema, mixedCandidateEvidenceSchema, mixedOriginalAssemblySchema,
  type MixedComparisonRequest, type MixedCandidateEvidence, type MixedItemLineage, type MixedSourceInventory } from "./mixed-types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function identical(a: unknown, b: unknown) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function invalid(message: string): never { throw new MixedComparisonError("invalid_input", message); }

// Extraction payloads carry source/block spans. Downstream links cannot retain
// live identities or be rewritten without changing the exact payload contract.
const unsupportedReferences = new Set(["workspace_id", "claim_id", "gap_id", "tactic_id", "parent_gap_id", "merged_into", "merged_from", "gap_ids", "depends_on", "source_file_ids", "block_ids", "quote_block_ids"]);
function requireSupportedReferences(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(requireSupportedReferences); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (unsupportedReferences.has(key)) invalid(`Unsupported selected payload reference ${key}.`);
    requireSupportedReferences(child);
  }
}

async function validateAssembly(assembly: Assembly, workspace_id: string, source_file_ids: string[], expected: string) {
  if (assembly.workspace_id !== workspace_id || assembly.fingerprint !== expected || assemblyFingerprint(assembly) !== expected ||
    !identical([...assembly.source_file_ids].sort(), [...source_file_ids].sort()) || !assembly.items.length ||
    assembly.items.some(item => item.human_origin || !item.run_id)) invalid("Invalid assembly identity, source scope, or model origin.");
  const resolved = await resolveAssemblyItems(workspace_id, assembly.items.map(item => ({ item_version_id: item.id, reason: item.reason }))).catch(() => invalid("Original assembly lineage no longer resolves exactly."));
  if (!identical(resolved, assembly.items)) invalid("Original assembly lineage no longer resolves exactly.");
  if (!identical(assembly.output, { gaps: assembly.items.filter(item => item.claim_type === "gap").map(item => item.payload),
    tactics: assembly.items.filter(item => item.claim_type === "tactic").map(item => item.payload) })) invalid("Assembly output differs from selected payloads.");
  const db = accuracyDb();
  const [workspace] = await db.select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.id, workspace_id));
  const sources = await db.select().from(t.accuracySourceFiles).where(and(eq(t.accuracySourceFiles.workspace_id, workspace_id), inArray(t.accuracySourceFiles.id, source_file_ids)));
  if (!workspace || sources.length !== source_file_ids.length || sources.some(source => source.org_id !== workspace.org_id || source.reference_pack_id)) invalid("Source set is missing, crossed, or gold-seeded.");
  const versions = await db.select().from(t.accuracyItemVersions).where(and(eq(t.accuracyItemVersions.workspace_id, workspace_id),
    inArray(t.accuracyItemVersions.id, assembly.items.map(item => item.id))));
  if (versions.length !== assembly.items.length || versions.some(version =>
    version.fingerprint !== generatedItemFingerprint(version.claim_type as "gap" | "tactic", version.payload))) invalid("Selected item fingerprint is stale.");
  const blocks = await db.select().from(t.accuracyParseBlocks).where(and(eq(t.accuracyParseBlocks.workspace_id, workspace_id), inArray(t.accuracyParseBlocks.source_file_id, source_file_ids)));
  for (const item of assembly.items) {
    requireSupportedReferences(item.payload);
    if (!source_file_ids.includes(item.source_file_id) || !Array.isArray(item.payload.provenance) || !item.payload.provenance.length) invalid("Selected item has missing source provenance.");
    for (const span of item.payload.provenance) {
      const parsed = provenanceSpanSchema.safeParse(span);
      if (!parsed.success || parsed.data.source_file_id !== item.source_file_id) invalid("Selected provenance crosses its source.");
      const block = blocks.find(row => row.id === parsed.data.block_id);
      if (!block || !validateProvenance({ block: block as ParseBlock, span: parsed.data }).ok) invalid("Selected provenance does not resolve to an original source quote.");
    }
  }
  // Do not permit two selected versions to collapse onto one copied claim.
  if (new Set(assembly.items.map(item => item.claim_id)).size !== assembly.items.length) invalid("Selected claims must be distinct.");
  mixedOriginalAssemblySchema.parse(assembly);
  return { workspace, sources, blocks };
}

/** Resolve both explicit nominations before any copy can be written. */
export async function resolveMixedCandidates(args: MixedComparisonRequest): Promise<{ mixed: Assembly; baseline: Assembly }> {
  const parsed = mixedComparisonRequestSchema.safeParse(args);
  if (!parsed.success) invalid(parsed.error.message);
  const request = parsed.data;
  return withAccuracyTransaction(async () => {
    await lockAssemblyWorkspace(request.source_workspace_id);
    const mixed = await readAssembly(request.source_workspace_id, request.mixed.assembly_id);
    const baseline = await readAssembly(request.source_workspace_id, request.baseline.assembly_id);
    if (!mixed || !baseline) invalid("An explicit nominated assembly is missing in the source workspace.");
    await validateAssembly(mixed, request.source_workspace_id, request.source_file_ids, request.mixed.fingerprint);
    await validateAssembly(baseline, request.source_workspace_id, request.source_file_ids, request.baseline.fingerprint);
    return { mixed, baseline };
  });
}

function remapPayload(value: unknown, copy: CopyExperimentWorkspaceResult): unknown {
  if (Array.isArray(value)) return value.map(child => remapPayload(child, copy));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const map = key === "source_file_id" ? copy.source_id_map : key === "block_id" ? copy.block_id_map : null;
    if (map) {
      if (typeof child !== "string" || !Object.hasOwn(map, child)) invalid(`Unresolved copied ${key}.`);
      return [key, map[child]];
    }
    return [key, remapPayload(child, copy)];
  }));
}
function requireMap(map: Record<string, string>, originalIds: string[]) {
  if (!identical(Object.keys(map).sort(), [...originalIds].sort()) || new Set(Object.values(map)).size !== originalIds.length ||
    Object.values(map).some(id => !id || originalIds.includes(id))) invalid("Copy map is incomplete, crossed, or noninjective.");
}

/** Replace only a fresh isolated copy; immutable original payloads remain separate evidence. */
export async function materializeMixedCandidate(args: { label: "mixed" | "baseline"; assembly: Assembly; copy: CopyExperimentWorkspaceResult }): Promise<MixedCandidateEvidence> {
  return withAssemblyExperiment(() => withAccuracyTransaction(async () => {
    const { assembly, copy } = args;
    if (args.label !== "mixed" && args.label !== "baseline") invalid("An explicit candidate label is required.");
    if (copy.workspace_id === assembly.workspace_id) invalid("Materialization requires an isolated copied workspace.");
    await lockAssemblyWorkspace(assembly.workspace_id);
    await lockAssemblyWorkspace(copy.workspace_id);
    const origin = await validateAssembly(assembly, assembly.workspace_id, assembly.source_file_ids, assembly.fingerprint);
    const stored = await readAssembly(assembly.workspace_id, assembly.id);
    if (!identical(stored, assembly)) invalid("Candidate does not match its immutable stored assembly.");
    const db = accuracyDb();
    const [workspace] = await db.select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.id, copy.workspace_id));
    if (!workspace || workspace.org_id !== copy.org_id || workspace.org_id === origin.workspace.org_id) invalid("Copy tenant is not isolated from the source.");
    requireMap(copy.source_id_map, assembly.source_file_ids);
    requireMap(copy.block_id_map, origin.blocks.map(row => row.id));
    const sources = await db.select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, copy.workspace_id));
    const blocks = await db.select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, copy.workspace_id));
    if (sources.length !== origin.sources.length || blocks.length !== origin.blocks.length) invalid("Copy source inventory differs from original.");
    for (const source of origin.sources) {
      const target = sources.find(row => row.id === copy.source_id_map[source.id]);
      if (!target || !identical(target, { ...source, id: target.id, workspace_id: workspace.id, org_id: workspace.org_id, reference_pack_id: null })) invalid("Copied source content or tenant differs from original.");
    }
    for (const block of origin.blocks) {
      const target = blocks.find(row => row.id === copy.block_id_map[block.id]);
      if (!target || !identical(target, { ...block, id: target.id, workspace_id: workspace.id, source_file_id: copy.source_id_map[block.source_file_id] })) invalid("Copied parse block differs from original.");
    }
    // Fresh copies never contain generated history or published assemblies. Reject
    // those workspaces rather than deleting their immutable history or approval rows.
    for (const table of [t.accuracyItemVersions, t.accuracyAssemblies, t.accuracyModuleRuns]) {
      if ((await db.select({ id: table.id }).from(table).where(eq(table.workspace_id, workspace.id)).limit(1)).length) invalid("Copy has already been used; materialization requires a fresh copy.");
    }
    const claims = await db.select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace.id));
    for (const claim of claims) {
      const baseline = (claim.metadata as Record<string, unknown>).baseline_origin as { workspace_id?: string; claim_id?: string } | undefined;
      if (baseline?.workspace_id !== assembly.workspace_id || !baseline.claim_id || copy.claim_id_map[baseline.claim_id] !== claim.id) invalid("Copy inventory contains rows without original copy lineage.");
    }
    const claim_id_map = Object.fromEntries(assembly.items.map(item => [item.claim_id, newId(item.claim_type === "gap" ? "gap" : "tac")]));
    const provenance_id_map: Record<string, string> = {};
    const lineage: MixedItemLineage[] = [];
    const inventory: MixedSourceInventory = [];
    // Compute and validate all remapped payloads before removing copied rows.
    const selected = assembly.items.map(item => {
      const copied_claim_id = claim_id_map[item.claim_id];
      const remapped = remapPayload(item.payload, copy) as Record<string, unknown>;
      const payload = Object.hasOwn(item.payload, "id") ? { ...remapped, id: copied_claim_id } : remapped;
      const provenance = (item.payload.provenance as unknown[]).map(span => {
        const { source_file_id, block_id, quote } = provenanceSpanSchema.parse(span);
        return { source_file_id, block_id, quote };
      });
      const copiedProvenance = provenance.map((span, index) => {
        const id = newId("prov");
        provenance_id_map[`${item.id}:${index}`] = id;
        return { id, workspace_id: workspace.id, claim_id: copied_claim_id, source_file_id: copy.source_id_map[span.source_file_id], block_id: copy.block_id_map[span.block_id], quote: span.quote };
      });
      const statement = item.claim_type === "gap" ? payload.statement : payload.name;
      if (typeof statement !== "string" || !statement.trim()) invalid("Selected payload has no claim text.");
      return { item, payload, provenance, copiedProvenance, copied_claim_id, statement };
    });
    for (const table of [t.accuracyCoverageJoins, t.accuracyProvenance, t.accuracyMissFlagActions, t.accuracyClaims]) {
      await db.delete(table).where(eq(table.workspace_id, workspace.id));
    }
    for (const row of selected) {
      await insertClaim({ id: row.copied_claim_id, workspace_id: workspace.id, claim_type: row.item.claim_type, statement: row.statement,
        source_file_id: copy.source_id_map[row.item.source_file_id], metadata: { ...row.payload, ...(row.item.claim_type === "tactic" ? {
          tactic_type: typeof row.payload.type === "string" ? row.payload.type : null,
          tactic_status: typeof row.payload.status === "string" ? row.payload.status : null,
        } : {}) }, validated: false });
      await db.insert(t.accuracyProvenance).values(row.copiedProvenance);
      lineage.push({ kind: "selected", original_item_version_id: row.item.id, original_claim_id: row.item.claim_id, original_run_id: row.item.run_id!,
        original_snapshot_id: row.item.snapshot_id, original_iteration: row.item.iteration, original_item_index: row.item.item_index,
        selection_reason: row.item.reason, copied_claim_id: row.copied_claim_id, copied_evidence_ids: row.copiedProvenance.map(span => span.id),
        original_payload: row.item.payload as MixedSourceInventory[number]["payload"], copied_payload: row.payload as MixedSourceInventory[number]["payload"] });
      inventory.push({ claim_id: row.copied_claim_id, claim_type: row.item.claim_type, payload: row.payload as MixedSourceInventory[number]["payload"],
        original_item_version_ids: [row.item.id], original_provenance: row.provenance });
    }
    return mixedCandidateEvidenceSchema.parse({ label: args.label, status: "pending", primary_error: null, attempt_id: null, setup: null,
      copied_workspace_id: workspace.id, original_assembly: assembly,
      copy: { source_id_map: copy.source_id_map, block_id_map: copy.block_id_map, claim_id_map, provenance_id_map,
        original_content_fingerprint: assembly.fingerprint,
        remapped_content_fingerprint: createHash("sha256").update(JSON.stringify(canonical(inventory))).digest("hex") },
      lineage, entry_source_inventory: inventory, final_source_inventory: null, final_outputs: null, gates: [],
      stages: MIXED_PIPELINE_STAGES.map(stage => ({ stage, status: "pending" })) });
  }));
}
