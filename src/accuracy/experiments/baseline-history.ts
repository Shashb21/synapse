/** Typed audit archive within the existing experiment baseline, never a live history store. */
import { eq } from "drizzle-orm";
import { accuracyDb } from "../store/db";
import * as t from "../store/schema";
import { newId } from "@/modules/kernel/ids";
import { ExperimentCopyError } from "./copy-workspace";
import { readWorkspaceBaselineSnapshot } from "./records";

const tables = {
  item_versions: t.accuracyItemVersions, assemblies: t.accuracyAssemblies, assembly_items: t.accuracyAssemblyItems,
  reviews: t.accuracyAssemblyReviews, revisions: t.accuracyAssemblyRevisions, heads: t.accuracyAssemblyRevisionHeads,
  attempts: t.accuracyAssemblyRevisionAttempts, feedback: t.accuracyAssemblyFeedback,
  relationships: t.accuracyItemRelationshipProposals, relationship_decisions: t.accuracyItemRelationshipDecisions,
  runs: t.accuracyModuleRuns, events: t.accuracyAgentEvents, batches: t.accuracyExtractionBatches,
};
type AuditRow<T> = T & { original_id?: string; baseline_origin?: unknown };
type HistoryRows = { [K in keyof typeof tables]: AuditRow<(typeof tables)[K]["$inferSelect"]>[] };
export type ManagedBaselineHistory = HistoryRows & {
  version: 1; authority: "audit_only";
  human_decisions: { id: string; revision_id: string; gap_version_id: string; tactic_version_id: string; original_id?: string }[];
  claim_audit: AuditRow<typeof t.accuracyClaims.$inferSelect>[];
  coverage_audit: AuditRow<typeof t.accuracyCoverageJoins.$inferSelect>[];
  split_operations: AuditRow<typeof t.accuracySplitOperations.$inferSelect>[];
  priority_audit: (typeof t.accuracyPriorityPlacements.$inferSelect)[];
};
export type BaselineReferenceMaps = Record<"source" | "block" | "claim" | "operation" | "workspace" | "org" | "coverage" | "provenance", Record<string, string>>;
const fail = (message: string): never => { throw new ExperimentCopyError("unresolved_reference", message); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Authorization references are retained only in the typed audit archive. */
const authorityKeys = new Set(["approved_assembly_item_version_id", "item_version_id", "gap_version_id", "tactic_version_id", "assembly_review_id", "approval_review_id", "assembly_id", "review_id", "assembly_fingerprint"]);
export function hasManagedAuthority(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasManagedAuthority);
  return Object.entries(object(value)).some(([key, child]) => key !== "baseline_origin" &&
    (authorityKeys.has(key) && child != null || hasManagedAuthority(child)));
}
export function stripManagedAuthority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripManagedAuthority);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(object(value)).filter(([key, child]) =>
    !authorityKeys.has(key) && !(["validation", "validation_history", "decision_history"].includes(key) && hasManagedAuthority(child)))
    .map(([key, child]) => [key, key === "baseline_origin" ? child : stripManagedAuthority(child)]));
}

/** Read the existing baseline owner, then union newly delivered history in this workspace. */
export async function collectBaselineHistory(workspace_id: string, sourceIds: Set<string>, claims: ManagedBaselineHistory["claim_audit"], coverage: ManagedBaselineHistory["coverage_audit"], splits: ManagedBaselineHistory["split_operations"], priorities: ManagedBaselineHistory["priority_audit"]): Promise<ManagedBaselineHistory | null> {
  const baseline = object(await readWorkspaceBaselineSnapshot(workspace_id));
  const prior = baseline.managed_history as ManagedBaselineHistory | undefined;
  if (prior && (prior.version !== 1 || prior.authority !== "audit_only")) fail("Unsupported managed baseline archive.");
  if (prior) for (const key of ["human_decisions", "claim_audit", "coverage_audit", "split_operations", "priority_audit"] as const) {
    if (!Array.isArray(prior[key])) fail(`Malformed baseline history: ${key}`);
  }
  const rows: Record<string, unknown[]> = {};
  for (const [key, table] of Object.entries(tables)) {
    const stored = await accuracyDb().select().from(table).where(eq(table.workspace_id, workspace_id));
    const archived = prior?.[key as keyof HistoryRows] ?? [];
    if (!Array.isArray(archived)) fail(`Malformed baseline history: ${key}`);
    const merged = new Map<string, unknown>();
    for (const row of [...archived, ...stored]) {
      const data = object(row), identity = String(data.id ?? data.baseline_assembly_id);
      if (merged.has(identity) && JSON.stringify(merged.get(identity)) !== JSON.stringify(row)) fail(`Ambiguous baseline history identity: ${key}`);
      merged.set(identity, row);
    }
    rows[key] = [...merged.values()].sort((a, b) => String(object(a).id ?? object(a).baseline_assembly_id).localeCompare(String(object(b).id ?? object(b).baseline_assembly_id)));
  }
  const all = rows as HistoryRows;
  const claimIds = new Set(claims.map(row => row.id));
  const versions = all.item_versions.filter(row => claimIds.has(row.claim_id));
  const versionIds = new Set(versions.map(row => row.id));
  const assemblyIds = new Set(all.assembly_items.filter(row => versionIds.has(row.item_version_id)).map(row => row.assembly_id));
  for (const row of all.assemblies) if (row.source_file_ids.some(id => sourceIds.has(id))) assemblyIds.add(row.id);
  const assemblies = all.assemblies.filter(row => assemblyIds.has(row.id));
  const revisions = all.revisions.filter(row => assemblyIds.has(row.parent_assembly_id) || assemblyIds.has(row.initial_assembly_id));
  const revisionIds = new Set(revisions.map(row => row.id));
  const relationships = all.relationships.filter(row => [...row.predecessor_ids, ...row.successor_ids].some(id => claimIds.has(id)));
  const relationshipIds = new Set(relationships.map(row => row.id));
  const feedback = all.feedback.filter(row => assemblyIds.has(row.assembly_id));
  const batches = all.batches.filter(row => sourceIds.has(row.source_file_id));
  const runIds = new Set([...versions.flatMap(row => row.run_id ? [row.run_id] : []), ...batches.flatMap(row => row.run_ids), ...feedback.map(row => row.consumer_run_id)]);
  for (const row of assemblies) for (const entry of [...(row.coverage as unknown[]), ...(row.extraction_runs as unknown[] ?? [])]) {
    const pair = object(entry); if (typeof pair.run_id === "string" && pair.mode !== "human") runIds.add(pair.run_id);
  }
  const human = new Map((prior?.human_decisions ?? []).map(row => [row.id, row]));
  for (const assembly of assemblies) for (const entry of assembly.coverage as unknown[]) {
    const pair = object(entry);
    if (pair.mode === "human") {
      const id = String(pair.run_id);
      if (!human.has(id) && id !== `${pair.human_revision_id}:${pair.gap_version_id}:${pair.tactic_version_id}`) fail("Invalid human coverage identity.");
      human.set(id, { id, revision_id: String(pair.human_revision_id), gap_version_id: String(pair.gap_version_id), tactic_version_id: String(pair.tactic_version_id) });
    }
  }
  if (!versions.length && !assemblies.length && !prior) {
    if (claims.some(row => hasManagedAuthority(row.metadata) || (object(row.metadata).copied_managed_history === true || object(row.metadata).copied_history_archive === true)) || splits.some(row => object(row.snapshot).managed)) fail("Managed baseline history is missing; persist its experiment baseline before copying again.");
    return null;
  }
  // Audit snapshots may share a claim/join identity across revisions. Keep each
  // distinct historical state instead of replacing an earlier exact decision.
  const currentAudit = (prior?.claim_audit ?? []).filter(row => claimIds.has(row.id));
  for (const row of claims) if ((hasManagedAuthority(row.metadata) || !currentAudit.some(previous => previous.id === row.id))
    && !currentAudit.some(previous => JSON.stringify(previous) === JSON.stringify(row))) currentAudit.push(row);
  const coverageAudit = (prior?.coverage_audit ?? []).filter(row => claimIds.has(row.gap_id) && claimIds.has(row.tactic_id));
  for (const row of coverage) if ((hasManagedAuthority(row.dimensions) || !coverageAudit.some(previous => previous.id === row.id))
    && !coverageAudit.some(previous => JSON.stringify(previous) === JSON.stringify(row))) coverageAudit.push(row);
  // Queue suggestions are coverage-owned attempts, not assembly selections. Retain
  // their real runs (including older successful retries) in the same typed archive.
  const collectAssessmentRuns = (row: unknown): void => {
    const dimensions = object(object(row).dimensions);
    if (dimensions.managed_assessment === true && typeof dimensions.run_id === "string") runIds.add(dimensions.run_id);
    for (const key of ["decision_history", "merge_history", "legacy_duplicates"]) {
      if (Array.isArray(dimensions[key])) dimensions[key].forEach(collectAssessmentRuns);
    }
  };
  coverageAudit.forEach(collectAssessmentRuns);
  const splitAudit = new Map((prior?.split_operations ?? []).filter(row => claimIds.has(row.parent_gap_id)).map(row => [row.id, row]));
  for (const row of splits) if (row.state !== "archived" || !splitAudit.has(row.id)) splitAudit.set(row.id, row);
  return { version: 1, authority: "audit_only", item_versions: versions, assemblies,
    assembly_items: all.assembly_items.filter(row => assemblyIds.has(row.assembly_id)), reviews: all.reviews.filter(row => assemblyIds.has(row.assembly_id)),
    revisions, heads: all.heads.filter(row => assemblyIds.has(row.baseline_assembly_id)), attempts: all.attempts.filter(row => revisionIds.has(row.revision_id)), feedback,
    relationships, relationship_decisions: all.relationship_decisions.filter(row => relationshipIds.has(row.proposal_id)),
    runs: all.runs.filter(row => runIds.has(row.id)), events: all.events.filter(row => runIds.has(row.run_id)), batches,
    human_decisions: [...human.values()].filter(row => revisionIds.has(row.revision_id)),
    claim_audit: currentAudit, coverage_audit: coverageAudit, split_operations: [...splitAudit.values()],
    priority_audit: [...(prior?.priority_audit ?? []).filter(row => claimIds.has(row.gap_id)), ...priorities] };
}

/** Allocate and validate the complete typed graph before any target row is written. */
export function remapBaselineHistory(history: ManagedBaselineHistory, base: BaselineReferenceMaps, sourceWorkspace: string) {
  const namespaces: Record<string, Record<string, string>> = { ...base };
  for (const key of [...Object.keys(tables), "human_decisions"]) {
    if (key === "heads") continue;
    namespaces[key] = Object.fromEntries((history[key as keyof ManagedBaselineHistory] as { id: string }[]).map(row => [row.id, newId("archive")]));
  }
  const lookup = (kind: string, value: unknown): string => {
    if (typeof value !== "string" || !Object.hasOwn(namespaces[kind] ?? {}, value)) fail(`Unresolved archived ${kind} reference: ${String(value)}`);
    return namespaces[kind][value as string];
  };
  const combined = Object.assign({}, ...Object.values(namespaces)) as Record<string, string>;
  const scalar: Record<string, string> = {
    workspace_id: "workspace", org_id: "org", source_workspace_id: "workspace", source_org_id: "org", source_file_id: "source", block_id: "block",
    claim_id: "claim", canonical_claim_id: "claim", parent_gap_id: "claim", addressed_gap_id: "claim", open_residual_gap_id: "claim", merged_into: "claim", stale_claim_id: "claim",
    item_version_id: "item_versions", approved_assembly_item_version_id: "item_versions", gap_version_id: "item_versions", tactic_version_id: "item_versions", predecessor_version_id: "item_versions", successor_version_id: "item_versions", version_id: "item_versions",
    assembly_id: "assemblies", baseline_assembly_id: "assemblies", parent_assembly_id: "assemblies", initial_assembly_id: "assemblies", before_assembly_id: "assemblies", inverse_assembly_id: "assemblies",
    assembly_review_id: "reviews", approval_review_id: "reviews", review_id: "reviews", revision_id: "revisions", human_revision_id: "revisions", snapshot_id: "events",
    consumer_run_id: "runs", proposal_id: "relationships", batch_id: "batches", extraction_batch_id: "batches", operation_id: "operation", split_operation_id: "operation", retired_by_rollback: "operation",
  };
  const arrays: Record<string, string> = { source_file_ids: "source", block_ids: "block", block_bundle_ids: "block", quote_block_ids: "block", evidence: "block",
    item_version_ids: "item_versions", selected_item_version_ids: "item_versions", basis_version_ids: "item_versions", successor_version_ids: "item_versions",
    baseline_assembly_ids: "assemblies", parent_assembly_ids: "assemblies", before_assembly_ids: "assemblies",
    claim_ids: "claim", gap_ids: "claim", merged_from: "claim", depends_on: "claim", addressed_tactic_ids: "claim", predecessor_ids: "claim", successor_ids: "claim", created_claim_ids: "claim", run_ids: "runs" };
  const visit = (value: unknown, context = ""): unknown => {
    if (Array.isArray(value)) return value.map(row => visit(row, context));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(object(value)).map(([key, child]) => {
      if (["baseline_origin", "original_id", "copied_id"].includes(key)) return [key, child];
      if (child == null) return [key, child];
      if (key === "id") {
        const kind = context === "resolved_item" || object(value).canonical_claim_id ? "item_versions"
          : ["before_parent", "after_claims", "claims", "claim_audit"].includes(context) ? "claim"
          : ["after_coverage", "coverage_audit"].includes(context) ? "coverage"
          : ["after_provenance"].includes(context) ? "provenance"
          : context === "blocks" ? "block" : context === "sources" ? "source"
          : context === "dependencies" || context === "prior_retired_descendants" ? "claim" : null;
        return [key, kind ? lookup(kind, child) : typeof child === "string" && combined[child] ? combined[child] : child];
      }
      if (key === "gap_id" || key === "tactic_id") return [key, lookup(Object.hasOwn(namespaces.item_versions, String(child)) ? "item_versions" : "claim", child)];
      if (key === "run_id") return [key, lookup(Object.hasOwn(namespaces.human_decisions, String(child)) ? "human_decisions" : "runs", child)];
      if (key === "generation_key") return [key, lookup("batches", child)];
      if (scalar[key]) return [key, lookup(scalar[key], child)];
      if (arrays[key] && Array.isArray(child) && child.every(id => typeof id === "string")) return [key, child.map(id => lookup(arrays[key], id))];
      return [key, visit(child, key)];
    }));
  };
  const result = { version: 1, authority: "audit_only" } as ManagedBaselineHistory;
  for (const [key, rows] of Object.entries(history)) {
    if (!Array.isArray(rows)) continue;
    (result as unknown as Record<string, unknown>)[key] = rows.map(row => {
      const data = object(row), mapped = object(visit(row, key));
      const kind = key === "claim_audit" ? "claim" : key === "coverage_audit" ? "coverage" : key === "split_operations" ? "operation" : key;
      if (data.id != null) mapped.id = lookup(kind, data.id);
      return { ...mapped, ...(data.id == null ? {} : { original_id: data.id }),
        baseline_origin: { workspace_id: sourceWorkspace, id: data.id ?? data.baseline_assembly_id ?? data.gap_id, ...(data.baseline_origin ? { previous: data.baseline_origin } : {}) } };
    });
  }
  return { history: result, references: combined, remap: visit };
}
