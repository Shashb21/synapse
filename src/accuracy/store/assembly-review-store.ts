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
import { readAssembly } from "./assembly-store";
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

export type ApprovedLiveInventory = {
  claims: AccuracyClaimRow[];
  coverage: CoverageRow[];
  bindings: ApprovedAssemblyBinding[];
};

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
    if (batchRuns.some((run) => !run) || batch.run_ids.length !== batch.requested_kinds.length) {
      failApproval("Applied extraction batch is missing persisted extraction run evidence.");
    }
    for (const kind of batch.requested_kinds) {
      assertExtractionKind(kind);
      const run = batchRuns.find((candidate) => candidate?.call_kind === kind);
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
      };
      const key = `${head.source_file_id}\u0000${head.call_kind}`;
      const prior = heads.get(key);
      heads.set(key, prior ? newer(prior, head) : head);
    }
  }
  return [...heads.values()].sort((a, b) => a.source_file_id.localeCompare(b.source_file_id)
    || a.call_kind.localeCompare(b.call_kind));
}

async function assemblyCurrentForDeclaredProductionRuns(assembly: Assembly): Promise<boolean> {
  const declared = await verifiedDeclaredProductionRuns(assembly);
  if (declared.length === 0) return false;
  assertSelectedItemsBoundToDeclaredRuns(assembly, declared);
  const heads = await currentProductionHeads(assembly.workspace_id);
  if (!heads) return false;
  const headsByScope = new Map(heads.map((head) => [`${head.source_file_id}\u0000${head.call_kind}`, head]));
  return declared.every((run) => {
    const head = headsByScope.get(`${run.source_file_id}\u0000${run.call_kind}`);
    if (!head || head.run_id !== run.run_id) return false;
    return assembly.generation_key ? head.batch_id === assembly.generation_key : true;
  });
}

function assemblyCoversHead(assembly: Assembly, head: ProductionHead): boolean {
  return (assembly.extraction_runs ?? []).some((run) => run.run_id === head.run_id
    && run.source_file_id === head.source_file_id
    && run.call_kind === head.call_kind
    && run.evaluation_context === "production");
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
    const run = declaredByRunId.get(item.run_id);
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
    return reviewFromRow(row);
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
    "priority_rationale", "priority_origin",
  ];
  const metadata: AccuracyClaimMetadata = {};
  for (const key of safeKeys) {
    if (!(key in payload) && existing[key] !== undefined) metadata[key] = existing[key];
  }
  if (item.claim_type === "gap") {
    metadata.external_id = typeof payload.external_id === "string" ? payload.external_id : null;
  } else {
    metadata.tactic_type = typeof payload.type === "string" ? payload.type : null;
    metadata.tactic_status = typeof payload.status === "string" ? payload.status : null;
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
    status: "validated",
    validated: true,
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
  const { assembly, checks, checks_fingerprint } = await recheckedAssembly(workspace_id, row.id);
  assertSelectedItemsBoundToDeclaredRuns(assembly, await verifiedDeclaredProductionRuns(assembly));
  if (!assembly.linking_complete || checks.status !== "passed") failApproval("Current production assembly is not complete and passing.");
  if (!assemblyCoversHead(assembly, head)) failApproval("Current production assembly does not bind the head extraction run.");
  const review = await latestReview(workspace_id, assembly.id);
  if (!review || review.decision !== "approve" || review.fingerprint !== assembly.fingerprint || review.checks_fingerprint !== checks_fingerprint) {
    failApproval("Current production assembly is not approved.");
  }
  return { assembly, review };
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
    const selectedHeadAssemblies: Array<{ head: ProductionHead; assembly: Assembly }> = [];
    const coverageByPair = new Map<string, CoverageRow>();
    const bindings: ApprovedAssemblyBinding[] = [];

    for (const head of heads) {
      const { assembly, review } = await assemblyForHead(workspace_id, head);
      selectedHeadAssemblies.push({ head, assembly });
      bindings.push({ source_file_id: head.source_file_id, call_kind: head.call_kind, batch_id: head.batch_id,
        run_id: head.run_id, assembly_id: assembly.id, assembly_fingerprint: assembly.fingerprint, review_id: review.id });
      const selectedType: "gap" | "tactic" = head.call_kind === "need_extract" ? "gap" : "tactic";
      for (const item of assembly.items.filter((entry) => entry.claim_type === selectedType && entry.source_file_id === head.source_file_id)) {
        const projected = claimFromApprovedItem(item, claimsById.get(item.canonical_claim_id));
        projected.workspace_id = workspace_id;
        const prior = claimsByCanonical.get(projected.id);
        if (prior && !sameJson(prior, projected)) failApproval("Approved production heads conflict for a canonical item.");
        const priorVersion = selectedVersionsByCanonical.get(projected.id);
        if (priorVersion && priorVersion !== item.id) failApproval("Approved production heads conflict for a canonical item version.");
        selectedVersionsByCanonical.set(projected.id, item.id);
        claimsByCanonical.set(projected.id, projected);
      }
    }

    for (const { assembly } of selectedHeadAssemblies) {
      const itemsByVersion = new Map(assembly.items.map((item) => [item.id, item]));
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
        const projected: CoverageRow = {
          id: `approved:${row.run_id}`,
          workspace_id,
          gap_id: gap.canonical_claim_id,
          tactic_id: tactic.canonical_claim_id,
          overall: parsed.data.overall,
          dimensions: { quote_block_ids: parsed.data.quote_block_ids },
          confidence: String(parsed.data.confidence),
          validated: true,
          rationale: parsed.data.rationale,
        };
        const key = `${projected.gap_id}\u0000${projected.tactic_id}`;
        const prior = coverageByPair.get(key);
        if (prior && !sameJson(prior, projected)) failApproval("Approved production heads conflict for a coverage pair.");
        coverageByPair.set(key, projected);
      }
    }
    return {
      claims: [...claimsByCanonical.values()].sort((a, b) => a.claim_type.localeCompare(b.claim_type) || a.id.localeCompare(b.id)),
      coverage: [...coverageByPair.values()].sort((a, b) => a.gap_id.localeCompare(b.gap_id) || a.tactic_id.localeCompare(b.tactic_id)),
      bindings,
    };
  });
}

/** Revalidate a previously consumed live-inventory binding set before publishing durable effects. */
export async function revalidateApprovedLiveBindings(workspace_id: string, expected: ApprovedAssemblyBinding[]): Promise<void> {
  const live = await approvedLiveInventory(workspace_id);
  if (!live) throw new AssemblyReviewError("approval_required", "Workspace has no managed approved live inventory.");
  const actual = live.bindings.map((binding) => ({ ...binding })).sort((a, b) => a.batch_id.localeCompare(b.batch_id) || a.call_kind.localeCompare(b.call_kind));
  const wanted = expected.map((binding) => ({ ...binding })).sort((a, b) => a.batch_id.localeCompare(b.batch_id) || a.call_kind.localeCompare(b.call_kind));
  if (!sameJson(actual, wanted)) throw new AssemblyReviewError("conflict", "Approved live inventory changed before publication.");
}
