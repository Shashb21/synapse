/** Historical production-consumption proof and append-only assembly feedback persistence. */
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { assemblyFingerprint, type Assembly, type ResolvedAssemblyItem } from "@/accuracy/domain/assembly";
import { assemblyCheckFingerprint } from "@/accuracy/domain/assembly-review";
import {
  AssemblyFeedbackError,
  validateAssemblyFeedbackInput,
  type AssemblyFeedback,
  type AssemblyFeedbackCategory,
  type AssemblyFeedbackEvidence,
  type AssemblyFeedbackInput,
  type AssemblyFeedbackItem,
  type AssemblyFeedbackRun,
} from "@/accuracy/domain/assembly-feedback";
import { withAssemblyWorkspaceLock } from "@/accuracy/kernel/assembly-context";
import { CALL_KINDS } from "@/accuracy/kernel/contracts";
import { newId, nowIso } from "@/modules/kernel/ids";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction } from "./db";
import { readAssembly } from "./assembly-store";
import * as t from "./schema";

type RunRow = typeof t.accuracyModuleRuns.$inferSelect;
type FeedbackRow = typeof t.accuracyAssemblyFeedback.$inferSelect;
type ExtractionKind = "need_extract" | "inventory_extract";
type HistoricalBinding = {
  source_file_id: string;
  call_kind: ExtractionKind;
  batch_id: string;
  run_id: string;
  assembly_id: string;
  assembly_fingerprint: string;
  review_id: string;
};
type VerifiedBinding = HistoricalBinding & { assembly: Assembly };
type ConsumptionProof = { run: RunRow; bindings: VerifiedBinding[]; projected: Map<string, ResolvedAssemblyItem[]> };

const PRE_APPROVAL_KINDS = new Set(["upload", "parse", "inventory_extract", "need_extract", "completeness_audit"]);
const DOWNSTREAM_KINDS = new Set<string>(CALL_KINDS.filter(kind => !PRE_APPROVAL_KINDS.has(kind)));

function invalid(message: string): never {
  throw new AssemblyFeedbackError("invalid_input", message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function requiredId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function kindOf(item: ResolvedAssemblyItem): ExtractionKind {
  return item.claim_type === "gap" ? "need_extract" : "inventory_extract";
}

function parseBindings(steps: unknown): HistoricalBinding[] {
  if (!Array.isArray(steps)) invalid("Consumer run has no recorded assembly bindings.");
  const entries = steps.filter(step => record(step)?.name === "assembly:approved-live-bindings");
  if (entries.length !== 1) invalid("Consumer run has missing or ambiguous assembly binding steps.");
  const data = record(entries[0])?.data;
  if (!Array.isArray(data) || data.length === 0) invalid("Consumer run has no complete assembly binding set.");
  const bindings: HistoricalBinding[] = [];
  const scopes = new Set<string>();
  for (const value of data) {
    const binding = record(value);
    if (!binding || !requiredId(binding.source_file_id) || !requiredId(binding.batch_id)
      || !requiredId(binding.run_id) || !requiredId(binding.assembly_id)
      || !requiredId(binding.assembly_fingerprint) || !requiredId(binding.review_id)
      || (binding.call_kind !== "need_extract" && binding.call_kind !== "inventory_extract")) {
      invalid("Consumer run contains a malformed assembly binding.");
    }
    const scope = `${binding.source_file_id}\u0000${binding.call_kind}`;
    if (scopes.has(scope)) invalid("Consumer run contains ambiguous source/kind bindings.");
    scopes.add(scope);
    bindings.push(binding as HistoricalBinding);
  }
  return bindings;
}

async function verifyHistoricalApproval(binding: HistoricalBinding, workspace_id: string, assembly: Assembly): Promise<void> {
  const [review] = await accuracyDb().select().from(t.accuracyAssemblyReviews).where(and(
    eq(t.accuracyAssemblyReviews.workspace_id, workspace_id),
    eq(t.accuracyAssemblyReviews.id, binding.review_id),
    eq(t.accuracyAssemblyReviews.assembly_id, binding.assembly_id),
  )).limit(1);
  if (!review || review.decision !== "approve" || review.fingerprint !== assembly.fingerprint
    || review.checks_fingerprint !== assemblyCheckFingerprint(assembly.checks)) {
    invalid("Recorded assembly binding does not have an exact historical approval.");
  }
}

async function verifyAssembly(binding: HistoricalBinding, workspace_id: string): Promise<Assembly> {
  const assembly = await readAssembly(workspace_id, binding.assembly_id);
  if (!assembly || assembly.fingerprint !== binding.assembly_fingerprint
    || assemblyFingerprint(assembly) !== assembly.fingerprint
    || !assembly.source_file_ids.includes(binding.source_file_id)) {
    invalid("Recorded assembly identity or fingerprint does not match immutable production output.");
  }
  await verifyHistoricalApproval(binding, workspace_id, assembly);
  if (!assembly.linking_complete || assembly.checks.status !== "passed") {
    invalid("Recorded assembly is not a complete passing selection.");
  }
  return assembly;
}

async function verifyExtractionOwnership(binding: HistoricalBinding, workspace_id: string, assembly: Assembly): Promise<void> {
  const [batch] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(and(
    eq(t.accuracyExtractionBatches.workspace_id, workspace_id), eq(t.accuracyExtractionBatches.id, binding.batch_id),
  )).limit(1);
  const [run] = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
    eq(t.accuracyModuleRuns.workspace_id, workspace_id), eq(t.accuracyModuleRuns.id, binding.run_id),
  )).limit(1);
  const input = record(run?.input);
  if (!batch || !batch.drafts_persisted || batch.source_file_id !== binding.source_file_id
    || !Array.isArray(batch.requested_kinds) || !Array.isArray(batch.run_ids)
    || batch.requested_kinds.length === 0 || batch.requested_kinds.length !== batch.run_ids.length
    || batch.requested_kinds.some(kind => kind !== "need_extract" && kind !== "inventory_extract")
    || new Set(batch.requested_kinds).size !== batch.requested_kinds.length
    || new Set(batch.run_ids).size !== batch.run_ids.length
    || !batch.requested_kinds.includes(binding.call_kind) || !batch.run_ids.includes(binding.run_id)
    || !run || run.status !== "ok" || run.evaluation_context !== "production" || run.call_kind !== binding.call_kind
    || input?.workspace_id !== workspace_id || input.source_file_id !== binding.source_file_id
    || (input.call_kind !== undefined && input.call_kind !== binding.call_kind)
    || !assembly.extraction_runs?.some(declared => declared.run_id === binding.run_id
      && declared.source_file_id === binding.source_file_id && declared.call_kind === binding.call_kind
      && declared.evaluation_context === "production")) {
    invalid("Recorded binding has no matching applied production extraction ownership.");
  }
  const batchRuns = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
    eq(t.accuracyModuleRuns.workspace_id, workspace_id), inArray(t.accuracyModuleRuns.id, batch.run_ids),
  ));
  if (batchRuns.length !== batch.run_ids.length
    || new Set(batchRuns.map(candidate => candidate.call_kind)).size !== batchRuns.length
    || batchRuns.some(candidate => {
      const candidateInput = record(candidate.input);
      return candidate.status !== "ok" || candidate.evaluation_context !== "production"
        || !batch.requested_kinds.includes(candidate.call_kind)
        || candidateInput?.workspace_id !== workspace_id || candidateInput.source_file_id !== binding.source_file_id
        || (candidateInput.call_kind !== undefined && candidateInput.call_kind !== candidate.call_kind);
    })) {
    invalid("Applied extraction batch has ambiguous or invalid run ownership.");
  }
  const [source] = await accuracyDb().select({ id: t.accuracySourceFiles.id }).from(t.accuracySourceFiles).where(and(
    eq(t.accuracySourceFiles.workspace_id, workspace_id), eq(t.accuracySourceFiles.id, binding.source_file_id),
  )).limit(1);
  if (!source) invalid("Recorded binding source belongs to another workspace.");
}

async function verifySelectedItems(workspace_id: string, assembly: Assembly): Promise<void> {
  for (const item of assembly.items) {
    const [row] = await accuracyDb().select().from(t.accuracyItemVersions).where(and(
      eq(t.accuracyItemVersions.workspace_id, workspace_id), eq(t.accuracyItemVersions.id, item.id),
    )).limit(1);
    if (!row || row.source_file_id !== item.source_file_id || row.claim_type !== item.claim_type
      || row.claim_id !== item.claim_id || row.run_id !== item.run_id || !sameJson(row.payload, item.payload)
      || !sameJson(row.human_origin ?? null, item.human_origin ?? null)) {
      invalid("Assembly selection differs from its immutable item version.");
    }
    if (item.human_origin) {
      if (item.run_id !== null || item.human_origin.kind !== "human"
        || !requiredId(item.human_origin.subject) || !requiredId(item.human_origin.provider)
        || !requiredId(item.human_origin.revision_id) || !requiredId(item.human_origin.parent_assembly_id)
        || !requiredId(item.human_origin.actor?.name) || !requiredId(item.human_origin.actor?.function)
        || item.human_origin.source_file_id !== item.source_file_id
        || !sameJson(item.human_origin.provenance, item.payload.provenance)) {
        invalid("Human item has invalid source or extraction lineage.");
      }
    } else if (!assembly.extraction_runs?.some(declared => declared.run_id === item.run_id
      && declared.source_file_id === item.source_file_id && declared.call_kind === kindOf(item)
      && declared.evaluation_context === "production")) {
      invalid("Generated item is outside the assembly's declared production extraction scope.");
    }
    for (const evidence of evidenceFor(item)) {
      const [block] = await accuracyDb().select({ id: t.accuracyParseBlocks.id }).from(t.accuracyParseBlocks).where(and(
        eq(t.accuracyParseBlocks.workspace_id, workspace_id),
        eq(t.accuracyParseBlocks.source_file_id, item.source_file_id),
        eq(t.accuracyParseBlocks.id, evidence.block_id),
      )).limit(1);
      if (!block) invalid("Selected item evidence block is outside its source and workspace.");
    }
  }
}

async function proofForRun(workspace_id: string, run: RunRow): Promise<ConsumptionProof> {
  const input = record(run.input);
  if (run.workspace_id !== workspace_id || run.status !== "ok" || run.evaluation_context !== "production"
    || !DOWNSTREAM_KINDS.has(run.call_kind) || !run.finished_at || input?.workspace_id !== workspace_id) {
    invalid("Consumer run is not a successful downstream production run in this workspace.");
  }
  const parsed = parseBindings(run.steps);
  const bindings: VerifiedBinding[] = [];
  const cache = new Map<string, Assembly>();
  for (const binding of parsed) {
    let assembly = cache.get(binding.assembly_id);
    if (!assembly) {
      assembly = await verifyAssembly(binding, workspace_id);
      await verifySelectedItems(workspace_id, assembly);
      cache.set(binding.assembly_id, assembly);
    } else if (assembly.fingerprint !== binding.assembly_fingerprint
      || !assembly.source_file_ids.includes(binding.source_file_id)) {
      invalid("Recorded binding conflicts with another binding for its assembly.");
    } else {
      await verifyHistoricalApproval(binding, workspace_id, assembly);
    }
    await verifyExtractionOwnership(binding, workspace_id, assembly);
    bindings.push({ ...binding, assembly });
  }
  const ownedKinds = new Set(bindings.map(binding => `${binding.source_file_id}\u0000${binding.call_kind}`));
  const projected = new Map<string, ResolvedAssemblyItem[]>();
  const selectedCanonicals = new Map<string, string>();
  for (const binding of bindings) {
    const items = binding.assembly.items.filter(item => item.source_file_id === binding.source_file_id
      && (kindOf(item) === binding.call_kind || (Boolean(item.human_origin)
        && !ownedKinds.has(`${item.source_file_id}\u0000${kindOf(item)}`))));
    const target = projected.get(binding.assembly_id) ?? [];
    for (const item of items) {
      if (!item.human_origin && item.run_id !== binding.run_id) {
        invalid("Projected item does not belong to its bound extraction run.");
      }
      const prior = selectedCanonicals.get(item.canonical_claim_id);
      if (prior && prior !== item.id) invalid("Recorded bindings select conflicting canonical item versions.");
      selectedCanonicals.set(item.canonical_claim_id, item.id);
      if (!target.some(existing => existing.id === item.id)) target.push(item);
    }
    projected.set(binding.assembly_id, target);
  }
  return { run, bindings, projected };
}

async function proofForRunId(workspace_id: string, run_id: string): Promise<ConsumptionProof> {
  const [run] = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
    eq(t.accuracyModuleRuns.workspace_id, workspace_id), eq(t.accuracyModuleRuns.id, run_id),
  )).limit(1);
  if (!run) invalid("Consumer run does not belong to this workspace.");
  return proofForRun(workspace_id, run);
}

function targetItems(proof: ConsumptionProof, assembly_id: string, review_id: string, fingerprint: string): ResolvedAssemblyItem[] {
  const bindings = proof.bindings.filter(binding => binding.assembly_id === assembly_id);
  if (bindings.length === 0 || bindings.some(binding => binding.review_id !== review_id
    || binding.assembly_fingerprint !== fingerprint)) {
    invalid("Consumer run did not use this exact approved assembly and review.");
  }
  return proof.projected.get(assembly_id) ?? [];
}

function evidenceFor(item: ResolvedAssemblyItem): AssemblyFeedbackEvidence[] {
  const spans = item.payload.provenance;
  if (!Array.isArray(spans)) invalid("Selected item has no valid source evidence.");
  return spans.map(value => {
    const span = record(value);
    if (!span || span.source_file_id !== item.source_file_id || !requiredId(span.block_id)
      || typeof span.quote !== "string") invalid("Selected item has invalid source evidence.");
    return { source_file_id: item.source_file_id, block_id: span.block_id, quote: span.quote };
  });
}

function itemDto(item: ResolvedAssemblyItem): AssemblyFeedbackItem {
  return { item_version_id: item.id, claim_type: item.claim_type, source_file_id: item.source_file_id,
    evidence: evidenceFor(item) };
}

function feedbackFromRow(row: FeedbackRow, assembly: Assembly): AssemblyFeedback {
  if (row.assembly_fingerprint !== assembly.fingerprint) {
    throw new AssemblyFeedbackError("conflict", "Stored feedback fingerprint differs from its immutable assembly.");
  }
  const byId = new Map(assembly.items.map(item => [item.id, item]));
  if (!Array.isArray(row.selected_item_version_ids) || row.selected_item_version_ids.some(id => !byId.has(id))) {
    throw new AssemblyFeedbackError("conflict", "Stored feedback references missing immutable item versions.");
  }
  return {
    id: row.id, workspace_id: row.workspace_id, assembly_id: row.assembly_id,
    assembly_fingerprint: row.assembly_fingerprint, approval_review_id: row.approval_review_id,
    consumer_run_id: row.consumer_run_id, selected_item_version_ids: row.selected_item_version_ids,
    items: row.selected_item_version_ids.map(id => itemDto(byId.get(id)!)),
    category: row.category as AssemblyFeedbackCategory, rationale: row.rationale,
    actor_subject: row.actor_subject, actor_provider: row.actor_provider,
    actor_name: row.actor_name, actor_function: row.actor_function, created_at: row.created_at,
  };
}

/** Save one append-only observation after proving exact historical production consumption. */
export async function createAssemblyFeedback(input: AssemblyFeedbackInput): Promise<AssemblyFeedback> {
  const request = validateAssemblyFeedbackInput(input);
  return withAssemblyWorkspaceLock(request.workspace_id, async () => {
    const proof = await proofForRunId(request.workspace_id, request.consumer_run_id);
    const consumed = targetItems(proof, request.assembly_id, request.approval_review_id, request.expected_fingerprint);
    const chosen = request.selected_item_version_ids?.length
      ? request.selected_item_version_ids : consumed.map(item => item.id);
    const consumedIds = new Set(consumed.map(item => item.id));
    if (chosen.some(id => !consumedIds.has(id))) invalid("Selected item version was not consumed from this assembly.");
    const [row] = await accuracyDb().insert(t.accuracyAssemblyFeedback).values({
      id: newId("feedback"), workspace_id: request.workspace_id, assembly_id: request.assembly_id,
      assembly_fingerprint: request.expected_fingerprint, approval_review_id: request.approval_review_id,
      consumer_run_id: request.consumer_run_id, selected_item_version_ids: chosen,
      category: request.category, rationale: request.rationale,
      actor_subject: request.contributor.subject, actor_provider: request.contributor.provider,
      actor_name: request.contributor.actor.name, actor_function: request.contributor.actor.function,
      created_at: nowIso(),
    }).returning();
    const assembly = proof.bindings.find(binding => binding.assembly_id === request.assembly_id)!.assembly;
    return feedbackFromRow(row, assembly);
  });
}

/** List saved observations for one exact immutable assembly, with its source evidence. */
export async function listAssemblyFeedback(workspace_id: string, assembly_id: string): Promise<AssemblyFeedback[]> {
  await ensureAccuracySchema();
  const assembly = await readAssembly(workspace_id, assembly_id);
  if (!assembly) return [];
  const rows = await accuracyDb().select().from(t.accuracyAssemblyFeedback).where(and(
    eq(t.accuracyAssemblyFeedback.workspace_id, workspace_id), eq(t.accuracyAssemblyFeedback.assembly_id, assembly_id),
  )).orderBy(asc(t.accuracyAssemblyFeedback.created_at), asc(t.accuracyAssemblyFeedback.id));
  if (rows.length === 0) return [];
  await verifySelectedItems(workspace_id, assembly);
  return rows.map(row => feedbackFromRow(row, assembly));
}

/** List successful production runs whose complete saved bindings prove use of this assembly. */
export async function listAssemblyFeedbackRuns(workspace_id: string, assembly_id: string): Promise<AssemblyFeedbackRun[]> {
  await ensureAccuracySchema();
  return withAccuracyTransaction(async () => {
    const runs = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
      eq(t.accuracyModuleRuns.workspace_id, workspace_id), eq(t.accuracyModuleRuns.status, "ok"),
      eq(t.accuracyModuleRuns.evaluation_context, "production"),
    )).orderBy(desc(t.accuracyModuleRuns.finished_at), desc(t.accuracyModuleRuns.id));
    const eligible: AssemblyFeedbackRun[] = [];
    for (const run of runs) {
      if (!Array.isArray(run.steps) || !run.steps.some(step => record(step)?.name === "assembly:approved-live-bindings")) continue;
      try {
        const proof = await proofForRun(workspace_id, run);
        const bindings = proof.bindings.filter(binding => binding.assembly_id === assembly_id);
        if (!bindings.length || new Set(bindings.map(binding => binding.review_id)).size !== 1) continue;
        eligible.push({ run_id: run.id, created_at: run.finished_at!, approval_review_id: bindings[0].review_id,
          consumed_item_version_ids: (proof.projected.get(assembly_id) ?? []).map(item => item.id) });
      } catch (error) {
        if (!(error instanceof AssemblyFeedbackError)) throw error;
      }
    }
    return eligible;
  });
}
