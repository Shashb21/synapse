import { findCoverageRecord } from "./coverage-store";
import { withHumanEdit } from "./claim-edit";
import { claimFactualRevision } from "@/accuracy/domain/structured-fields";
import { syncClaimProvenance } from "./claim-store";
/** Review persistence and approved live projection for immutable extraction assemblies. */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  AssemblyReviewError,
  assemblyCheckFingerprint,
  evaluateAssemblyReviewRequest,
  sameReviewRequest,
  type AssemblyReview,
  type AssemblyReviewDecision,
  type AssemblyReviewOverride,
  type AssemblyReviewer,
} from "@/accuracy/domain/assembly-review";
import {
  assemblyFingerprint,
  assemblyCoverageIntent,
  checkAssembly,
  type Assembly,
  type AssemblyCheckReport,
  type AssemblyExtractionRun,
  type ResolvedAssemblyItem,
} from "@/accuracy/domain/assembly";
import { coverageDecisionSchema } from "@/accuracy/modules/coverage-decide/schema";
import { lockAssemblyWorkspace, withAssemblyWorkspaceLock } from "@/accuracy/kernel/assembly-context";
import { newId, nowIso } from "@/modules/kernel/ids";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction } from "./db";
import { assemblyRevisionState, currentRevisionAssemblyId } from "./assembly-revision-store";
import { readAssembly, resolveAssemblyItems } from "./assembly-store";
import { claimMetadata, type AccuracyClaimMetadata, type AccuracyClaimRow, type AccuracyClaimType } from "./claim-store";
import type { ParseBlock } from "./quote-validator";
import * as t from "./schema";

type ReviewRow = typeof t.accuracyAssemblyReviews.$inferSelect;
type RunRow = typeof t.accuracyModuleRuns.$inferSelect;
type CoverageRow = typeof t.accuracyCoverageJoins.$inferSelect;
type ExtractionKind = "need_extract" | "inventory_extract";
type ProductionHead = {
  source_file_id: string;
  call_kind: ExtractionKind;
  batch_id: string;
  run_id: string;
  run_finished_at: string;
  run_ids: string[];
};
type VerifiedDeclaredProductionRun = AssemblyExtractionRun & {
  call_kind: ExtractionKind;
  evaluation_context: "production";
};

export type AssemblyReviewStatus = "current" | "stale" | "rejected" | "pending" | "approved";
export type AssemblyReviewState = {
  assembly_id: string;
  fingerprint: string;
  checks_fingerprint: string;
  status: AssemblyReviewStatus;
  head_status: "current" | "stale";
  expected_review_id: string | null;
  latest_decision: AssemblyReview | null;
  checks: AssemblyCheckReport;
  advisories: AssemblyCheckReport["findings"];
};

export type ApprovedAssemblyBinding = {
  source_file_id: string;
  call_kind: ExtractionKind;
  batch_id: string;
  run_id: string;
  assembly_id: string;
  assembly_fingerprint: string;
  review_id: string;
};

export type ApprovedLiveItem = {
  binding: ApprovedAssemblyBinding;
  claim_id: string;
  item_version_id: string;
  claim_type: "gap" | "tactic";
  source_file_id: string;
  payload: Record<string, unknown>;
};

export type ApprovedLiveMapping = {
  gap_id: string;
  tactic_id: string;
  gap_version_id: string;
  tactic_version_id: string;
};

export type ApprovedLiveInventory = {
  claims: AccuracyClaimRow[];
  coverage: CoverageRow[];
  bindings: ApprovedAssemblyBinding[];
  selected_items: ApprovedLiveItem[];
  mappings: ApprovedLiveMapping[];
};

/** Ownership comes from the exact projection, including human opposite-kind additions. */
export function requireApprovedItemBinding(live: ApprovedLiveInventory, claim_id: string): ApprovedAssemblyBinding {
  const item = live.selected_items.find(item => item.claim_id === claim_id);
  if (!item?.binding || item.binding.source_file_id !== item.source_file_id || !live.bindings.some(binding => sameJson(binding, item.binding))) {
    throw new AssemblyReviewError("approval_required", "Selected item has no current approved assembly owner.");
  }
  return item.binding;
}

function reviewFromRow(row: ReviewRow): AssemblyReview {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    assembly_id: row.assembly_id,
    fingerprint: row.fingerprint,
    checks_fingerprint: row.checks_fingerprint,
    decision: row.decision as AssemblyReviewDecision,
    rationale: row.rationale,
    advisory_overrides: row.advisory_overrides as AssemblyReviewOverride[],
    reviewer_subject: row.reviewer_subject,
    reviewer_provider: row.reviewer_provider,
    reviewer_actor_name: row.reviewer_actor_name,
    reviewer_actor_function: row.reviewer_actor_function,
    reviewer_role: row.reviewer_role as AssemblyReview["reviewer_role"],
    created_at: row.created_at,
  };
}

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

function outputFromItems(items: ResolvedAssemblyItem[]) {
  return {
    gaps: items.filter((item) => item.claim_type === "gap").map((item) => item.payload),
    tactics: items.filter((item) => item.claim_type === "tactic").map((item) => item.payload),
  };
}

function failApproval(message: string): never {
  throw new AssemblyReviewError("approval_required", message);
}

async function parseBlocks(workspace_id: string, source_file_ids: string[]): Promise<ParseBlock[]> {
  if (source_file_ids.length === 0) return [];
  const rows = await accuracyDb().select().from(t.accuracyParseBlocks).where(and(
    eq(t.accuracyParseBlocks.workspace_id, workspace_id),
    inArray(t.accuracyParseBlocks.source_file_id, source_file_ids),
  ));
  return rows as ParseBlock[];
}

async function latestReview(workspace_id: string, assembly_id: string): Promise<AssemblyReview | null> {
  const [row] = await accuracyDb().select().from(t.accuracyAssemblyReviews).where(and(
    eq(t.accuracyAssemblyReviews.workspace_id, workspace_id),
    eq(t.accuracyAssemblyReviews.assembly_id, assembly_id),
  )).orderBy(desc(t.accuracyAssemblyReviews.created_at), desc(t.accuracyAssemblyReviews.id)).limit(1);
  return row ? reviewFromRow(row) : null;
}

async function recheckedAssembly(workspace_id: string, assembly_id: string): Promise<{
  assembly: Assembly;
  checks: AssemblyCheckReport;
  fingerprint: string;
  checks_fingerprint: string;
}> {
  const assembly = await readAssembly(workspace_id, assembly_id);
  if (!assembly) throw new AssemblyReviewError("not_found", "Assembly not found.");
  const resolved = await resolveAssemblyItems(workspace_id, assembly.items.map(item => ({ item_version_id: item.id, reason: item.reason })));
  if (!sameJson(resolved, assembly.items)) throw new AssemblyReviewError("conflict", "Assembly items no longer match immutable version history.");
  for (const item of resolved.filter(item => item.human_origin)) {
    const origin = item.human_origin!;
    const [row] = await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(and(
      eq(t.accuracyAssemblyRevisions.workspace_id, workspace_id), eq(t.accuracyAssemblyRevisions.id, origin.revision_id),
    )).limit(1);
    const change = row?.change;
    if (change?.item_origins?.some(entry => entry.version_id === item.id && sameJson(entry.origin, origin))) continue;
    if (!change || (change.successor_version_id !== item.id && !change.successor_version_ids?.includes(item.id)) || change.parent_assembly_id !== origin.parent_assembly_id
      || change.predecessor_version_id !== origin.predecessor_version_id || change.action !== origin.action
      || change.reason !== origin.reason || change.author.subject !== origin.subject || change.author.provider !== origin.provider
      || !sameJson(change.author.actor, origin.actor) || !sameJson(change.provenance, origin.provenance)) {
      throw new AssemblyReviewError("conflict", "Human version origin has no matching immutable revision lineage.");
    }
  }
  for (const pair of assembly.coverage.filter(pair => pair.mode === "human")) {
    const [revision] = await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(and(
      eq(t.accuracyAssemblyRevisions.workspace_id, workspace_id), eq(t.accuracyAssemblyRevisions.id, pair.human_revision_id ?? "")));
    if (!revision?.change.coverage?.some(saved => sameJson(saved, pair))) {
      throw new AssemblyReviewError("conflict", "Human coverage has no matching immutable contributor revision.");
    }
  }
  const expectedOutput = outputFromItems(assembly.items);
  if (!sameJson(assembly.output, expectedOutput)) {
    throw new AssemblyReviewError("conflict", "Stored assembly output no longer matches selected immutable items.");
  }
  const blocks = await parseBlocks(workspace_id, assembly.source_file_ids);
  const checks = checkAssembly({
    items: assembly.items,
    source_file_ids: assembly.source_file_ids,
    blocks,
    mappings: assembly.mappings,
    coverage: assembly.coverage,
    linking_complete: assembly.linking_complete,
  });
  const fingerprint = assemblyFingerprint({
    source_file_ids: assembly.source_file_ids,
    items: assembly.items,
    mappings: assembly.mappings,
    coverage: assembly.coverage,
    extraction_runs: assembly.extraction_runs,
    linking_complete: assembly.linking_complete,
  });
  if (!sameJson(assembly.checks, checks)) {
    throw new AssemblyReviewError("conflict", "Stored assembly check report no longer matches recomputed checks.");
  }
  if (fingerprint !== assembly.fingerprint) {
    throw new AssemblyReviewError("conflict", "Assembly fingerprint no longer matches its persisted body.");
  }
  return { assembly, checks, fingerprint, checks_fingerprint: assemblyCheckFingerprint(checks) };
}

function runTime(row: RunRow): string {
  return row.finished_at ?? row.started_at ?? "";
}

function newer(a: ProductionHead, b: ProductionHead): ProductionHead {
  const byTime = a.run_finished_at.localeCompare(b.run_finished_at);
  if (byTime !== 0) return byTime > 0 ? a : b;
  return a.run_id > b.run_id ? a : b;
}

function assertExtractionKind(value: string): asserts value is ExtractionKind {
  if (value !== "need_extract" && value !== "inventory_extract") {
    failApproval("Applied extraction batch contains an unsupported extraction kind.");
  }
}

async function currentProductionHeads(workspace_id: string): Promise<ProductionHead[] | null> {
  const batches = await accuracyDb().select().from(t.accuracyExtractionBatches).where(and(
    eq(t.accuracyExtractionBatches.workspace_id, workspace_id),
    eq(t.accuracyExtractionBatches.drafts_persisted, true),
  ));
  if (batches.length === 0) return null;

  const runIds = [...new Set(batches.flatMap((batch) => batch.run_ids))];
  if (runIds.length === 0) failApproval("Applied extraction batch has no persisted extraction runs.");
  const runs = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
    eq(t.accuracyModuleRuns.workspace_id, workspace_id),
    inArray(t.accuracyModuleRuns.id, runIds),
  ));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const heads = new Map<string, ProductionHead>();

  for (const batch of batches) {
    if (!Array.isArray(batch.requested_kinds) || batch.requested_kinds.length === 0
      || new Set(batch.requested_kinds).size !== batch.requested_kinds.length) {
      failApproval("Applied extraction batch has corrupted requested kinds.");
    }
    const batchRuns = batch.run_ids.map((id) => runsById.get(id));
    if (batchRuns.some((run) => !run) || (!batch.source_progress && batch.run_ids.length !== batch.requested_kinds.length)) {
      failApproval("Applied extraction batch is missing persisted extraction run evidence.");
    }
    for (const kind of batch.requested_kinds) {
      assertExtractionKind(kind);
      const kindRuns = batchRuns.filter((candidate): candidate is RunRow => candidate?.call_kind === kind);
      const run = kindRuns.at(-1);
      if (!run || run.status !== "ok" || run.evaluation_context !== "production") {
        failApproval("Applied extraction batch is not a successful production extraction.");
      }
      const input = run.input as Record<string, unknown> | null;
      if (input?.workspace_id !== workspace_id || input.source_file_id !== batch.source_file_id
        || (input.call_kind !== undefined && input.call_kind !== run.call_kind)) {
        failApproval("Applied extraction batch run metadata is corrupted.");
      }
      const head: ProductionHead = {
        source_file_id: batch.source_file_id,
        call_kind: kind,
        batch_id: batch.id,
        run_id: run.id,
        run_finished_at: runTime(run),
        run_ids: kindRuns.map(row => row.id),
      };
      const key = `${head.source_file_id}\u0000${head.call_kind}`;
      const prior = heads.get(key);
      heads.set(key, prior ? newer(prior, head) : head);
    }
  }
  for (const head of heads.values()) {
    const batch = batches.find(row => row.id === head.batch_id)!;
    if (batch.source_progress) {
      const { assertExtractionBatchEvidence } = await import("./extraction-batch-store");
      try { await assertExtractionBatchEvidence(batch); }
      catch { failApproval("Current source pages are incomplete, stale or lack exact successful extraction evidence."); }
      if (!batch.source_progress.full_source_complete) failApproval("Current extraction does not cover the full source.");
    }
  }
  return [...heads.values()].sort((a, b) => a.source_file_id.localeCompare(b.source_file_id)
    || a.call_kind.localeCompare(b.call_kind));
}

async function assemblyCurrentForDeclaredProductionRuns(assembly: Assembly): Promise<boolean> {
  const revisionState = await assemblyRevisionState(assembly.workspace_id, assembly.id);
  if (!revisionState.is_current) return false;
  const baseline = revisionState.revision ? await readAssembly(assembly.workspace_id, revisionState.baseline_assembly_id) : assembly;
  if (!baseline) return false;
  const baselines = await Promise.all((revisionState.revision?.baseline_assembly_ids ?? [baseline.id]).map(id => readAssembly(assembly.workspace_id, id)));
  const declared = await verifiedDeclaredProductionRuns(assembly);
  if (declared.length === 0) return false;
  assertSelectedItemsBoundToDeclaredRuns(assembly, declared);
  const heads = await currentProductionHeads(assembly.workspace_id);
  if (!heads) return false;
  for (const item of assembly.items.filter(item => item.human_origin)) {
    const counterpart = heads.find(head => head.source_file_id === item.source_file_id && head.call_kind === itemExtractionKind(item));
    if (counterpart && !assemblyCoversHead(assembly, counterpart)) return false;
  }
  const headsByScope = new Map(heads.map((head) => [`${head.source_file_id}\u0000${head.call_kind}`, head]));
  return declared.every((run) => {
    const head = headsByScope.get(`${run.source_file_id}\u0000${run.call_kind}`);
    if (!head || !head.run_ids.includes(run.run_id) || !assemblyCoversHead(assembly, head)) return false;
    const owner = baselines.find(row => row?.extraction_runs?.some(entry => entry.run_id === run.run_id));
    return owner?.generation_key ? head.batch_id === owner.generation_key : !baseline.generation_key;
  });
}

function assemblyCoversHead(assembly: Assembly, head: ProductionHead): boolean {
  return head.run_ids.every(id => (assembly.extraction_runs ?? []).some((run) => run.run_id === id
    && run.source_file_id === head.source_file_id
    && run.call_kind === head.call_kind
    && run.evaluation_context === "production"));
}

function declaredExtractionKind(value: unknown): value is ExtractionKind {
  return value === "need_extract" || value === "inventory_extract";
}

function itemExtractionKind(item: ResolvedAssemblyItem): ExtractionKind {
  return item.claim_type === "gap" ? "need_extract" : "inventory_extract";
}

function assertSelectedItemsBoundToDeclaredRuns(assembly: Assembly, declared: VerifiedDeclaredProductionRun[]) {
  const declaredByRunId = new Map(declared.map((run) => [run.run_id, run]));
  for (const item of assembly.items) {
    if (item.human_origin) {
      if (item.run_id !== null || item.human_origin.source_file_id !== item.source_file_id
        || !declared.some(run => run.source_file_id === item.source_file_id)) {
        throw new AssemblyReviewError("conflict", "Human item is outside the declared production source scope.");
      }
      continue;
    }
    const run = item.run_id ? declaredByRunId.get(item.run_id) : undefined;
    if (!run || run.source_file_id !== item.source_file_id || run.call_kind !== itemExtractionKind(item)) {
      throw new AssemblyReviewError("conflict", "Assembly selected item version is not bound to a declared production extraction run.");
    }
  }
}

async function verifiedDeclaredProductionRuns(assembly: Assembly): Promise<VerifiedDeclaredProductionRun[]> {
  const declared = assembly.extraction_runs ?? [];
  if (declared.length === 0) return [];
  const production = declared.map((run) => {
    if (!declaredExtractionKind(run.call_kind) || run.evaluation_context !== "production") {
      throw new AssemblyReviewError("conflict", "Assembly extraction run lineage is not verified production.");
    }
    if (!assembly.source_file_ids.includes(run.source_file_id)) {
      throw new AssemblyReviewError("conflict", "Assembly extraction run lineage references a source outside the assembly.");
    }
    return run as VerifiedDeclaredProductionRun;
  });
  const runIds = [...new Set(production.map((run) => run.run_id))];
  if (runIds.length !== production.length) {
    throw new AssemblyReviewError("conflict", "Assembly extraction run lineage is duplicated.");
  }
  const rows = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
    eq(t.accuracyModuleRuns.workspace_id, assembly.workspace_id),
    inArray(t.accuracyModuleRuns.id, runIds),
  ));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const run of production) {
    const row = rowsById.get(run.run_id);
    const input = row?.input as Record<string, unknown> | null | undefined;
    if (!row || row.status !== "ok" || row.call_kind !== run.call_kind || row.evaluation_context !== "production"
      || input?.workspace_id !== assembly.workspace_id || input.source_file_id !== run.source_file_id
      || (input.call_kind !== undefined && input.call_kind !== run.call_kind)) {
      throw new AssemblyReviewError("conflict", "Assembly extraction run lineage does not match persisted production evidence.");
    }
  }
  return production;
}

/** Record an append-only exact assembly approval or rejection under the workspace lock. */
export async function reviewAssembly(args: {
  workspace_id: string;
  assembly_id: string;
  expected_fingerprint: string;
  expected_review_id?: string | null;
  decision: AssemblyReviewDecision;
  rationale: string;
  advisory_overrides?: AssemblyReviewOverride[];
  reviewer: AssemblyReviewer;
}): Promise<AssemblyReview> {
  return withAssemblyWorkspaceLock(args.workspace_id, async () => {
    const { assembly, checks, fingerprint, checks_fingerprint } = await recheckedAssembly(args.workspace_id, args.assembly_id);
    if (args.expected_fingerprint !== fingerprint) {
      throw new AssemblyReviewError("conflict", "Assembly fingerprint is stale.");
    }
    if (!await assemblyCurrentForDeclaredProductionRuns(assembly)) {
      throw new AssemblyReviewError("conflict", "Assembly is stale for the current production head.");
    }
    const normalized = evaluateAssemblyReviewRequest({
      decision: args.decision,
      rationale: args.rationale,
      advisory_overrides: args.advisory_overrides,
      reviewer: args.reviewer,
      checks,
    });
    const prior = await latestReview(args.workspace_id, args.assembly_id);
    const expected_review_id = args.expected_review_id ?? null;
    const candidate = {
      ...normalized,
      fingerprint,
      checks_fingerprint,
    };
    if ((prior?.id ?? null) !== expected_review_id) {
      if (expected_review_id === null && prior && sameReviewRequest(prior, candidate)) return prior;
      throw new AssemblyReviewError("conflict", "Review decision identity is stale.");
    }
    if (prior && sameReviewRequest(prior, candidate)) return prior;
    if (normalized.decision === "approve") {
      const { checkManagedSplitApproval } = await import("./partial-split-store");
      await checkManagedSplitApproval(assembly);
    }
    const [row] = await accuracyDb().insert(t.accuracyAssemblyReviews).values({
      id: newId("arev"),
      workspace_id: args.workspace_id,
      assembly_id: args.assembly_id,
      fingerprint,
      checks_fingerprint,
      decision: normalized.decision,
      rationale: normalized.rationale,
      advisory_overrides: normalized.advisory_overrides,
      reviewer_subject: normalized.reviewer_subject,
      reviewer_provider: normalized.reviewer_provider,
      reviewer_actor_name: normalized.reviewer_actor_name,
      reviewer_actor_function: normalized.reviewer_actor_function,
      reviewer_role: normalized.reviewer_role,
      created_at: nowIso(),
    }).returning();
    const review = reviewFromRow(row);
    if (review.decision === "approve") {
      await persistApprovedFacts(assembly, review);
      const { finishManagedSplitApproval } = await import("./partial-split-store");
      await finishManagedSplitApproval(assembly, review);
    }
    return review;
  });
}

/** Read the current review status for one assembly, rechecking persisted evidence before reporting state. */
export async function assemblyReviewState(workspace_id: string, assembly_id: string): Promise<AssemblyReviewState> {
  await ensureAccuracySchema();
  const { assembly, checks, fingerprint, checks_fingerprint } = await recheckedAssembly(workspace_id, assembly_id);
  const latest_decision = await latestReview(workspace_id, assembly_id);
  const current = await assemblyCurrentForDeclaredProductionRuns(assembly);
  const staleDecision = latest_decision
    ? latest_decision.fingerprint !== fingerprint || latest_decision.checks_fingerprint !== checks_fingerprint
    : false;
  const status: AssemblyReviewStatus = !current || staleDecision
    ? "stale"
    : latest_decision?.decision === "approve"
      ? "approved"
      : latest_decision?.decision === "reject"
        ? "rejected"
        : "pending";
  return {
    assembly_id,
    fingerprint,
    checks_fingerprint,
    status,
    head_status: current ? "current" : "stale",
    expected_review_id: latest_decision?.id ?? null,
    latest_decision,
    checks,
    advisories: checks.findings.filter((finding) => finding.severity === "advisory"),
  };
}

function metadataWithApprovedOverlay(existing: AccuracyClaimMetadata, item: ResolvedAssemblyItem): AccuracyClaimMetadata {
  const payload = item.payload;
  const safeKeys = [
    "start", "end", "readout", "readout_date", "evidence_available", "validation",
    "computed_status", "derived_at", "status_override", "priority", "priority_band",
    "priority_rationale", "priority_origin", "priority_scoring",
  ];
  const metadata: AccuracyClaimMetadata = { ...payload };
  for (const key of ["edit_history", "validation_history", "human_locked", "last_human_edit", "factual_validation_stale", "extraction_source_revision", "extraction_identity", "extraction_aliases", "extraction_suggestions"]) {
    if (existing[key] !== undefined) metadata[key] = existing[key];
  }
  for (const key of safeKeys) {
    if (!(key in payload) && existing[key] !== undefined) metadata[key] = existing[key];
  }
  if (item.claim_type === "gap") {
    metadata.external_id = typeof payload.external_id === "string" ? payload.external_id : null;
  } else {
    metadata.tactic_type = typeof payload.type === "string" ? payload.type : null;
    metadata.tactic_status = typeof payload.status === "string" ? payload.status : null;
    metadata.evidence_question = typeof payload.evidence_question === "string" ? payload.evidence_question : null;
  }
  metadata.provenance = payload.provenance ?? [];
  metadata.approved_assembly_item_version_id = item.id;
  return metadata;
}

function claimFromApprovedItem(item: ResolvedAssemblyItem, current: AccuracyClaimRow | undefined): AccuracyClaimRow {
  const payload = item.payload;
  const statement = item.claim_type === "gap"
    ? String(payload.statement ?? "")
    : String(payload.name ?? "");
  const existingMetadata = current ? claimMetadata(current) : {};
  const now = nowIso();
  return {
    id: item.canonical_claim_id,
    workspace_id: current?.workspace_id ?? "",
    claim_type: item.claim_type as AccuracyClaimType,
    statement,
    status: current?.status === "rejected" ? "rejected" : "validated",
    validated: current?.validated ?? false,
    source_file_id: item.source_file_id,
    metadata: metadataWithApprovedOverlay(existingMetadata, item) as Record<string, unknown>,
    created_at: current?.created_at ?? item.created_at,
    updated_at: current?.updated_at ?? now,
  };
}

async function assemblyForHead(workspace_id: string, head: ProductionHead): Promise<{ assembly: Assembly; review: AssemblyReview }> {
  const [row] = await accuracyDb().select({ id: t.accuracyAssemblies.id }).from(t.accuracyAssemblies).where(and(
    eq(t.accuracyAssemblies.workspace_id, workspace_id),
    eq(t.accuracyAssemblies.generation_key, head.batch_id),
  )).limit(1);
  if (!row) failApproval("Current production extraction head has no complete assembly.");
  const { assembly, checks, checks_fingerprint } = await recheckedAssembly(workspace_id, await currentRevisionAssemblyId(workspace_id, row.id));
  // Human revisions are approved as a whole selection and cannot authorize a partial projection.
  // Generated assemblies retain their existing per-kind projection when another kind is replaced.
  const revisionState = await assemblyRevisionState(workspace_id, assembly.id);
  if (revisionState.revision && !await assemblyCurrentForDeclaredProductionRuns(assembly)) {
    failApproval("Human revision is stale for the current production extraction ownership.");
  }
  assertSelectedItemsBoundToDeclaredRuns(assembly, await verifiedDeclaredProductionRuns(assembly));
  if (!assembly.linking_complete || checks.status !== "passed") failApproval("Current production assembly is not complete and passing.");
  if (!assemblyCoversHead(assembly, head)) failApproval("Current production assembly does not bind the head extraction run.");
  const review = await latestReview(workspace_id, assembly.id);
  if (!review || review.decision !== "approve" || review.fingerprint !== assembly.fingerprint || review.checks_fingerprint !== checks_fingerprint) {
    failApproval("Current production assembly is not approved.");
  }
  return { assembly, review };
}

async function coverageIntents(workspace_id: string, coverage: Assembly["coverage"]) {
  const ids = [...new Set(coverage.flatMap(pair => pair.human_revision_id ? [pair.human_revision_id] : []))];
  const revisions = ids.length ? await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(and(
    eq(t.accuracyAssemblyRevisions.workspace_id, workspace_id), inArray(t.accuracyAssemblyRevisions.id, ids))) : [];
  return new Map(coverage.map(pair => [pair.run_id, assemblyCoverageIntent(pair, revisions.find(row => row.id === pair.human_revision_id)?.change)]));
}

/** Resolve the current approved production inventory, or null for legacy workspaces with no managed batches. */
export async function approvedLiveInventory(workspace_id: string): Promise<ApprovedLiveInventory | null> {
  await ensureAccuracySchema();
  return withAccuracyTransaction(async () => {
    await lockAssemblyWorkspace(workspace_id);
    const heads = await currentProductionHeads(workspace_id);
    if (heads === null) return null;
    const currentClaims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace_id));
    const claimsById = new Map(currentClaims.map((claim) => [claim.id, claim]));
    const claimsByCanonical = new Map<string, AccuracyClaimRow>();
    const selectedVersionsByCanonical = new Map<string, string>();
    const selectedHeadAssemblies: Array<{ head: ProductionHead; assembly: Assembly; review: AssemblyReview }> = [];
    const coverageByPair = new Map<string, CoverageRow>();
    const currentCoverage = await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, workspace_id));
    const bindings: ApprovedAssemblyBinding[] = [];
    const selectedItems: ApprovedLiveItem[] = [];
    const mappingsByPair = new Map<string, ApprovedLiveMapping>();

    for (const head of heads) {
      const { assembly, review } = await assemblyForHead(workspace_id, head);
      selectedHeadAssemblies.push({ head, assembly, review });
      const binding: ApprovedAssemblyBinding = { source_file_id: head.source_file_id, call_kind: head.call_kind, batch_id: head.batch_id,
        run_id: head.run_id, assembly_id: assembly.id, assembly_fingerprint: assembly.fingerprint, review_id: review.id };
      bindings.push(binding);
      const selectedType: "gap" | "tactic" = head.call_kind === "need_extract" ? "gap" : "tactic";
      const projectedItems = assembly.items.filter(entry => entry.source_file_id === head.source_file_id
        && (entry.claim_type === selectedType || (Boolean(entry.human_origin) && !heads.some(candidate =>
          candidate.source_file_id === entry.source_file_id && candidate.call_kind === itemExtractionKind(entry)))));
      for (const item of projectedItems) {
        const stored = claimsById.get(item.canonical_claim_id);
        const token = stored && claimMetadata(stored).validation as { factual_revision?: string } | undefined;
        if (stored && token?.factual_revision && token.factual_revision !== claimFactualRevision(stored)) {
          failApproval("Persisted factual content changed after the exact assembly review.");
        }
        const projected = claimFromApprovedItem(item, claimsById.get(item.canonical_claim_id));
        projected.workspace_id = workspace_id;
        const prior = claimsByCanonical.get(projected.id);
        if (prior && !sameJson(prior, projected)) failApproval("Approved production heads conflict for a canonical item.");
        const priorVersion = selectedVersionsByCanonical.get(projected.id);
        if (priorVersion && priorVersion !== item.id) failApproval("Approved production heads conflict for a canonical item version.");
        selectedVersionsByCanonical.set(projected.id, item.id);
        claimsByCanonical.set(projected.id, projected);
        selectedItems.push({
          binding,
          claim_id: projected.id,
          item_version_id: item.id,
          claim_type: item.claim_type,
          source_file_id: item.source_file_id,
          payload: item.payload,
        });
      }
    }

    for (const { assembly, review } of selectedHeadAssemblies) {
      const intents = await coverageIntents(workspace_id, assembly.coverage);
      const itemsByVersion = new Map(assembly.items.map((item) => [item.id, item]));
      for (const row of assembly.mappings) {
        const gap = itemsByVersion.get(row.gap_version_id);
        const tactic = itemsByVersion.get(row.tactic_version_id);
        if (!gap || !tactic) continue;
        const selectedGapVersion = selectedVersionsByCanonical.get(gap.canonical_claim_id);
        const selectedTacticVersion = selectedVersionsByCanonical.get(tactic.canonical_claim_id);
        if (selectedGapVersion !== row.gap_version_id || selectedTacticVersion !== row.tactic_version_id) continue;
        const projected: ApprovedLiveMapping = {
          gap_id: gap.canonical_claim_id,
          tactic_id: tactic.canonical_claim_id,
          gap_version_id: row.gap_version_id,
          tactic_version_id: row.tactic_version_id,
        };
        const key = `${projected.gap_id}\u0000${projected.tactic_id}`;
        const prior = mappingsByPair.get(key);
        if (prior && !sameJson(prior, projected)) failApproval("Approved production heads conflict for a selected mapping.");
        mappingsByPair.set(key, projected);
      }
      for (const row of assembly.coverage) {
        const gap = itemsByVersion.get(row.gap_version_id);
        const tactic = itemsByVersion.get(row.tactic_version_id);
        if (!gap || !tactic) continue;
        const selectedGapVersion = selectedVersionsByCanonical.get(gap.canonical_claim_id);
        const selectedTacticVersion = selectedVersionsByCanonical.get(tactic.canonical_claim_id);
        if (!selectedGapVersion || !selectedTacticVersion) continue;
        if (selectedGapVersion !== row.gap_version_id || selectedTacticVersion !== row.tactic_version_id) {
          failApproval("Approved coverage is stale for the current selected item versions.");
        }
        const parsed = coverageDecisionSchema.safeParse(row.output);
        if (!parsed.success) failApproval("Approved coverage output is corrupted.");
        const input = row.input && typeof row.input === "object" ? row.input as Record<string, unknown> : {};
        const blockBundle = Array.isArray(input.block_bundle_ids)
          ? input.block_bundle_ids.filter((id): id is string => typeof id === "string")
          : [];
        const saved = currentCoverage.find(c => c.gap_id === gap.canonical_claim_id && c.tactic_id === tactic.canonical_claim_id);
        const approved = findCoverageRecord(saved, row => (row.dimensions as Record<string, unknown>)?.assembly_review_id === review.id);
        const savedDimensions = (approved?.dimensions ?? {}) as Record<string, unknown>;
        const reviewed = Boolean(approved);
        const intent = intents.get(row.run_id)!;
        const projected: CoverageRow = {
          id: `approved:${row.run_id}`,
          workspace_id,
          gap_id: gap.canonical_claim_id,
          tactic_id: tactic.canonical_claim_id,
          overall: parsed.data.overall,
          dimensions: { ...(reviewed ? savedDimensions : {}), coverage_intent: intent, human_rejected: intent === "rejection", quote_block_ids: parsed.data.quote_block_ids, block_bundle_ids: blockBundle },
          confidence: String(parsed.data.confidence),
          validated: intent !== "unassessed" && reviewed && Boolean(approved?.validated),
          rationale: parsed.data.rationale,
        };
        const key = `${projected.gap_id}\u0000${projected.tactic_id}`;
        const prior = coverageByPair.get(key);
        if (prior && !sameJson(prior, projected)) failApproval("Approved production heads conflict for a coverage pair.");
        coverageByPair.set(key, projected);
      }
    }
    for (const mapping of mappingsByPair.values()) {
      const tactic = claimsByCanonical.get(mapping.tactic_id);
      if (!tactic) continue;
      const meta = claimMetadata(tactic);
      const gapIds = Array.isArray(meta.gap_ids) ? meta.gap_ids.filter((id): id is string => typeof id === "string") : [];
      if (!gapIds.includes(mapping.gap_id)) {
        claimsByCanonical.set(mapping.tactic_id, {
          ...tactic,
          metadata: { ...meta, gap_ids: [...gapIds, mapping.gap_id] } as Record<string, unknown>,
        });
      }
    }
    return {
      claims: [...claimsByCanonical.values()].sort((a, b) => a.claim_type.localeCompare(b.claim_type) || a.id.localeCompare(b.id)),
      coverage: [...coverageByPair.values()].sort((a, b) => a.gap_id.localeCompare(b.gap_id) || a.tactic_id.localeCompare(b.tactic_id)),
      bindings,
      selected_items: selectedItems.sort((a, b) => a.claim_id.localeCompare(b.claim_id)),
      mappings: [...mappingsByPair.values()].sort((a, b) => a.gap_id.localeCompare(b.gap_id) || a.tactic_id.localeCompare(b.tactic_id)),
    };
  });
}

/** Revalidate a previously consumed live-inventory binding set before publishing durable effects. */
export async function revalidateApprovedLiveBindings(workspace_id: string, expected: ApprovedAssemblyBinding[]): Promise<void> {
  let live: ApprovedLiveInventory | null;
  try {
    live = await approvedLiveInventory(workspace_id);
  } catch (error) {
    if (error instanceof AssemblyReviewError && error.code === "approval_required") {
      throw new AssemblyReviewError("conflict", "Approved live inventory changed before publication.");
    }
    throw error;
  }
  if (!live) throw new AssemblyReviewError("approval_required", "Workspace has no managed approved live inventory.");
  const actual = live.bindings.map((binding) => ({ ...binding })).sort((a, b) => a.batch_id.localeCompare(b.batch_id) || a.call_kind.localeCompare(b.call_kind));
  const wanted = expected.map((binding) => ({ ...binding })).sort((a, b) => a.batch_id.localeCompare(b.batch_id) || a.call_kind.localeCompare(b.call_kind));
  if (!sameJson(actual, wanted)) throw new AssemblyReviewError("conflict", "Approved live inventory changed before publication.");
}

/** Exact review establishes factual decisions once; reads never refresh their tokens. */
async function persistApprovedFacts(assembly: Assembly, review: AssemblyReview) {
  const db = accuracyDb();
  const current = await db.select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, assembly.workspace_id));
  const reviewed = new Map<string, AccuracyClaimRow>();
  for (const item of assembly.items) {
    const before = current.find(claim => claim.id === item.canonical_claim_id);
    if (!before) throw new AssemblyReviewError("conflict", "Selected claim disappeared before approval.");
    const claim = claimFromApprovedItem(item, before);
    const old = claimMetadata(before);
    let metadata = claimMetadata(claim);
    if (item.human_origin?.action === "edit") {
      const [prior] = await db.select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.id, item.human_origin.predecessor_version_id!));
      const changed = Object.keys(item.payload).flatMap(key => key === "id" ? [] : key === "structured"
        ? Object.keys((item.payload.structured ?? {}) as object).filter(field => field !== "version" && !sameJson(
            (item.payload.structured as Record<string, unknown>)[field], (prior?.payload.structured as Record<string, unknown> | undefined)?.[field])).map(field => `structured.${field}`)
        : sameJson(item.payload[key], prior?.payload[key]) ? [] : [key === "status" ? "tactic_status" : key === "name" ? "statement" : key]);
      metadata = withHumanEdit(metadata, { action: "edit", fields: changed, before: prior?.payload ?? {}, after: item.payload,
        rationale: item.human_origin.reason, actor: { name: item.human_origin.actor.name, function: item.human_origin.actor.function as import("@/accuracy/kernel/contracts").Actor["function"] }, at: item.human_origin.created_at });
      claim.metadata = metadata;
    }
    if (item.claim_type === "tactic") {
      const ids = assembly.mappings.filter(pair => pair.tactic_version_id === item.id)
        .map(pair => assembly.items.find(gap => gap.id === pair.gap_version_id)!.canonical_claim_id);
      if (ids.length) metadata.gap_ids = [...new Set([...(Array.isArray(metadata.gap_ids) ? metadata.gap_ids : []), ...ids])];
      claim.metadata = metadata;
    }
    const factual_revision = claimFactualRevision(claim);
    claim.metadata = { ...metadata, history_only: false, factual_validation_stale: false, factual_revision,
      validation_history: [...(Array.isArray(old.validation_history) ? old.validation_history : []), ...(old.validation ? [old.validation] : [])],
      validation: { action: "validate", factual_revision, stale: false, by: review.reviewer_actor_name, by_function: review.reviewer_actor_function,
        rationale: review.rationale, at: review.created_at, assembly_review_id: review.id, assembly_fingerprint: assembly.fingerprint,
        item_version_id: item.id, subject: review.reviewer_subject, provider: review.reviewer_provider } };
    claim.validated = true;
    claim.status = item.claim_type === "tactic" ? String(metadata.tactic_status ?? "unknown") : "validated";
    await db.update(t.accuracyClaims).set(claim).where(and(eq(t.accuracyClaims.workspace_id, assembly.workspace_id), eq(t.accuracyClaims.id, claim.id)));
    await syncClaimProvenance(claim);
    reviewed.set(item.id, claim);
  }
  const intents = await coverageIntents(assembly.workspace_id, assembly.coverage);
  for (const pair of assembly.coverage) {
    const intent = intents.get(pair.run_id)!;
    const gap = reviewed.get(pair.gap_version_id), tactic = reviewed.get(pair.tactic_version_id);
    if (!gap || !tactic) throw new AssemblyReviewError("conflict", "Reviewed coverage selection changed.");
    const output = coverageDecisionSchema.parse(pair.output);
    const [old] = await db.select().from(t.accuracyCoverageJoins).where(and(eq(t.accuracyCoverageJoins.workspace_id, assembly.workspace_id),
      eq(t.accuracyCoverageJoins.gap_id, gap.id), eq(t.accuracyCoverageJoins.tactic_id, tactic.id)));
    const row = { id: old?.id ?? newId("cov"), workspace_id: assembly.workspace_id, gap_id: gap.id, tactic_id: tactic.id,
      overall: output.overall, validated: output.overall !== "pending", rationale: output.rationale, confidence: String(output.confidence),
      dimensions: { coverage_intent: intent, human_rejected: intent === "rejection", gap_revision: claimFactualRevision(gap), tactic_revision: claimFactualRevision(tactic),
        actor: { name: review.reviewer_actor_name, function: review.reviewer_actor_function }, decided_at: review.created_at,
        evidence: output.quote_block_ids, run_id: pair.run_id, assessment_state: intent === "rejection" ? "rejected" : output.overall === "pending" ? "pending" : "successful", validation_stale: false,
        assembly_review_id: review.id, assembly_fingerprint: assembly.fingerprint, gap_version_id: pair.gap_version_id,
        tactic_version_id: pair.tactic_version_id, decision_history: old ? [old] : [] } };
    await db.insert(t.accuracyCoverageJoins).values(row).onConflictDoUpdate({
      target: [t.accuracyCoverageJoins.workspace_id, t.accuracyCoverageJoins.gap_id, t.accuracyCoverageJoins.tactic_id], set: row });
  }
}
