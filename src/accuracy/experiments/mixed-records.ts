/** Workspace-scoped, append-only paired replay history. */
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { EXPERIMENT_EVALUATOR_VERSION, experimentPackFingerprint } from "@/accuracy/eval/experiment-gold";
import { assemblyFingerprint } from "@/accuracy/domain/assembly";
import { readAssembly, resolveAssemblyItems } from "@/accuracy/store/assembly-store";
import { accuracyDb, accuracyTransactionActive, withAccuracyTransaction } from "@/accuracy/store/db";
import { getWorkspace } from "@/accuracy/store/tenant";
import * as t from "@/accuracy/store/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { MIXED_GATE_POLICY, MIXED_GATE_POLICY_FINGERPRINT, MixedComparisonError, mixedComparisonRequestSchema, mixedComparisonResultSchema, mixedOriginalAssemblySchema,
  type MixedComparisonRequest, type MixedComparisonRecord, type MixedComparisonResult, type MixedComparisonScope, type MixedCandidateEvidence } from "./mixed-types";
import { getExperimentForSourceWorkspace } from "./records";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function identical(a: unknown, b: unknown) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

/** Create a new comparison; explicit reruns always receive a fresh identity. */
export async function createMixedComparison(args: MixedComparisonRequest): Promise<MixedComparisonRecord> {
  const parsed = mixedComparisonRequestSchema.safeParse(args);
  if (!parsed.success) throw new MixedComparisonError("invalid_input", parsed.error.message);
  const request = parsed.data;
  return withAccuracyTransaction(async () => {
    const source = await getWorkspace(request.source_workspace_id);
    if (!source) throw new MixedComparisonError("not_found", "Unknown source workspace.");
    const sources = await accuracyDb().select().from(t.accuracySourceFiles).where(and(eq(t.accuracySourceFiles.workspace_id, source.id), inArray(t.accuracySourceFiles.id, request.source_file_ids)));
    if (sources.length !== request.source_file_ids.length || sources.some(row => row.reference_pack_id)) {
      throw new MixedComparisonError("invalid_input", "Source set is missing, crossed, or gold-seeded.");
    }
    const assemblies = { mixed: await readAssembly(source.id, request.mixed.assembly_id), baseline: await readAssembly(source.id, request.baseline.assembly_id) };
    for (const label of ["mixed", "baseline"] as const) {
      const assembly = assemblies[label];
      if (!assembly || assembly.fingerprint !== request[label].fingerprint || assemblyFingerprint(assembly) !== assembly.fingerprint ||
        !identical([...assembly.source_file_ids].sort(), [...request.source_file_ids].sort()) ||
        !assembly.items.length || assembly.items.some(item => item.human_origin || !item.run_id)) {
        throw new MixedComparisonError("invalid_input", `Invalid ${label} assembly identity, source scope, or model origin.`);
      }
      try {
        const resolved = await resolveAssemblyItems(source.id, assembly.items.map(item => ({ item_version_id: item.id, reason: item.reason })));
        if (!identical(resolved, assembly.items)) throw new Error("Lineage changed");
      } catch {
        throw new MixedComparisonError("invalid_input", "Original assembly lineage no longer resolves exactly.");
      }
    }
    let pack_fingerprint: string;
    try { pack_fingerprint = experimentPackFingerprint(request.pack_id); }
    catch { throw new MixedComparisonError("invalid_input", "Unknown or unavailable reference pack."); }
    const header = { id: newId("mixed_comparison"), source_workspace_id: source.id, source_org_id: source.org_id, request,
      original_assemblies: { mixed: mixedOriginalAssemblySchema.parse(assemblies.mixed), baseline: mixedOriginalAssemblySchema.parse(assemblies.baseline) },
      pack_fingerprint, evaluator_version: EXPERIMENT_EVALUATOR_VERSION,
      gate_policy: MIXED_GATE_POLICY, gate_policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT, created_at: nowIso() };
    await accuracyDb().insert(t.accuracyMixedComparisons).values(header);
    return { header, status: "running", links: null, result: null, attempts: { mixed: null, baseline: null } };
  });
}

async function loadComparison(scope: MixedComparisonScope): Promise<MixedComparisonRecord | null> {
  const [header] = await accuracyDb().select().from(t.accuracyMixedComparisons).where(and(eq(t.accuracyMixedComparisons.id, scope.comparison_id), eq(t.accuracyMixedComparisons.source_workspace_id, scope.source_workspace_id)));
  if (!header) return null;
  const [links] = await accuracyDb().select().from(t.accuracyMixedCandidateLinks).where(eq(t.accuracyMixedCandidateLinks.comparison_id, header.id));
  const [result] = await accuracyDb().select().from(t.accuracyMixedComparisonResults).where(eq(t.accuracyMixedComparisonResults.comparison_id, header.id));
  const attempts = links ? {
    mixed: await getExperimentForSourceWorkspace({ source_workspace_id: scope.source_workspace_id, experiment_id: links.mixed_experiment_id }),
    baseline: await getExperimentForSourceWorkspace({ source_workspace_id: scope.source_workspace_id, experiment_id: links.baseline_experiment_id }),
  } : { mixed: null, baseline: null };
  return { header, links: links ?? null, result: result ?? null, status: result?.evidence.status ?? "running", attempts };
}

async function lockComparison(scope: MixedComparisonScope) {
  const [header] = await accuracyDb().select().from(t.accuracyMixedComparisons).where(and(eq(t.accuracyMixedComparisons.id, scope.comparison_id), eq(t.accuracyMixedComparisons.source_workspace_id, scope.source_workspace_id))).for("update");
  if (!header) throw new MixedComparisonError("not_found", "Unknown comparison for source workspace.");
  return header;
}

/** Append terminal evidence once; identical retries return the original row. */
export async function finishMixedComparison(args: MixedComparisonScope & { result: MixedComparisonResult }): Promise<MixedComparisonRecord> {
  const parsed = mixedComparisonResultSchema.safeParse(args.result);
  if (!parsed.success) throw new MixedComparisonError("incomplete_evidence", parsed.error.message);
  return withAccuracyTransaction(async () => {
    const header = await lockComparison(args);
    const record = (await loadComparison(args))!;
    if (record.result) {
      if (!identical(record.result.evidence, parsed.data)) throw new MixedComparisonError("conflict", "Comparison already has different terminal evidence.");
      return record;
    }
    if (record.links) {
      await lockAttempts([record.links.mixed_experiment_id, record.links.baseline_experiment_id]);
      // Re-read after acquiring the same row locks held by call/evaluation appends.
      const lockedRecord = (await loadComparison(args))!;
      for (const candidate of ["mixed", "baseline"] as const) {
        const attempt = lockedRecord.attempts[candidate];
        if (!attempt) throw new MixedComparisonError("invalid_attempt", "Linked attempt is missing or out of source scope.");
        validateAttempt(header, attempt);
        const evidence = parsed.data.candidates[candidate];
        if (evidence) {
          validateCandidate(header, evidence, candidate, attempt);
          if (evidence.status === "completed") await validateCopiedScope(evidence, attempt);
        }
        else if (attempt.calls.length || attempt.evaluations.length) throw new MixedComparisonError("incomplete_evidence", "An executed attempt requires retained candidate evidence.");
      }
      if (parsed.data.status === "completed") {
        const { mixed, baseline } = parsed.data.candidates;
        if (!identical(mixed.setup, baseline.setup)) throw new MixedComparisonError("identity_mismatch", "Candidate setup identities do not match.");
        if (mixed.copied_workspace_id === baseline.copied_workspace_id) throw new MixedComparisonError("identity_mismatch", "Candidates must use disjoint copies.");
        if (parsed.data.evaluation.evaluator_version !== mixed.setup.downstream_evaluator_version) throw new MixedComparisonError("identity_mismatch", "Downstream evaluator identity does not match setup.");
        for (const retained of parsed.data.evaluation.source_evaluations) {
          if (retained.evaluation.evaluator_version !== header.evaluator_version || retained.evaluation.pack_fingerprint !== header.pack_fingerprint || retained.evaluation.pack_id !== header.request.pack_id) {
            throw new MixedComparisonError("identity_mismatch", "Source evaluation identity does not match comparison.");
          }
        }
      }
      // A failed comparison closes any partially executed attempt in this transaction.
      // Successful peers stay completed; all later child appends see a terminal row.
      for (const attempt of [lockedRecord.attempts.mixed!, lockedRecord.attempts.baseline!]) {
        if (attempt.status === "running") await accuracyDb().update(t.accuracyExperiments).set({ status: "failed", finished_at: nowIso() }).where(eq(t.accuracyExperiments.id, attempt.id));
      }
    } else if (parsed.data.status === "completed" || parsed.data.candidates.mixed?.attempt_id || parsed.data.candidates.baseline?.attempt_id) {
      throw new MixedComparisonError("invalid_attempt", "Candidate attempts must be bound before terminal evidence.");
    }
    await accuracyDb().insert(t.accuracyMixedComparisonResults).values({ comparison_id: args.comparison_id, evidence: parsed.data, finished_at: nowIso() });
    return (await loadComparison(args))!;
  });
}

/** Read from the authenticated source boundary, including private attempt history. */
export async function readMixedComparison(args: MixedComparisonScope): Promise<MixedComparisonRecord | null> {
  return accuracyTransactionActive() ? loadComparison(args) : withAccuracyTransaction(() => loadComparison(args), { isolationLevel: "repeatable read", accessMode: "read only" });
}


type Header = MixedComparisonRecord["header"];
type Attempt = NonNullable<MixedComparisonRecord["attempts"]["mixed"]>;

async function lockAttempts(ids: string[]) {
  const attempts = await accuracyDb().select().from(t.accuracyExperiments).where(inArray(t.accuracyExperiments.id, ids)).orderBy(asc(t.accuracyExperiments.id)).for("update");
  if (attempts.length !== 2) throw new MixedComparisonError("invalid_attempt", "Two distinct existing attempts are required.");
  return attempts;
}

function validateAttempt(header: Header, attempt: typeof t.accuracyExperiments.$inferSelect) {
  if (attempt.source_workspace_id !== header.source_workspace_id || attempt.source_org_id !== header.source_org_id ||
    attempt.workspace_id === header.source_workspace_id || attempt.org_id === header.source_org_id ||
    attempt.pack_id !== header.request.pack_id || attempt.pack_fingerprint !== header.pack_fingerprint || attempt.evaluator_version !== header.evaluator_version ||
    attempt.created_at < header.created_at) {
    throw new MixedComparisonError("invalid_attempt", "Attempt source, isolation, pack, evaluator, or creation identity is invalid.");
  }
}

/** Atomically bind both fresh attempts once, before any downstream call is appended. */
export async function bindMixedComparisonAttempts(args: MixedComparisonScope & { mixed_experiment_id: string; baseline_experiment_id: string }): Promise<MixedComparisonRecord> {
  return withAccuracyTransaction(async () => {
    const header = await lockComparison(args);
    const record = (await loadComparison(args))!;
    if (record.result) throw new MixedComparisonError("conflict", "A terminal comparison cannot bind attempts.");
    if (record.links) {
      if (record.links.mixed_experiment_id !== args.mixed_experiment_id || record.links.baseline_experiment_id !== args.baseline_experiment_id) {
        throw new MixedComparisonError("conflict", "Comparison already binds different attempts.");
      }
      return record;
    }
    const ids = [args.mixed_experiment_id, args.baseline_experiment_id];
    const attempts = await lockAttempts(ids);
    // Existing ownership is a conflict even when the attempt predates this rerun.
    // Hold attempt locks so concurrent comparisons cannot both claim either ID.
    const [existing] = await accuracyDb().select().from(t.accuracyMixedCandidateLinks).where(or(inArray(t.accuracyMixedCandidateLinks.mixed_experiment_id, ids), inArray(t.accuracyMixedCandidateLinks.baseline_experiment_id, ids)));
    if (existing) throw new MixedComparisonError("conflict", "Attempt is already bound to a comparison.");
    for (const attempt of attempts) {
      validateAttempt(header, attempt);
      const workspace = await getWorkspace(attempt.workspace_id);
      if (!workspace || workspace.org_id !== attempt.org_id || attempt.status !== "running") throw new MixedComparisonError("invalid_attempt", "Attempt must be running in an owned isolated workspace.");
      const retained = (await getExperimentForSourceWorkspace({ source_workspace_id: header.source_workspace_id, experiment_id: attempt.id }))!;
      if (retained.calls.length || retained.evaluations.length) throw new MixedComparisonError("invalid_attempt", "Attempt replay has already started.");
    }
    if (attempts[0].workspace_id === attempts[1].workspace_id || attempts[0].org_id === attempts[1].org_id) throw new MixedComparisonError("invalid_attempt", "Candidates need disjoint copied workspaces and organizations.");
    await accuracyDb().insert(t.accuracyMixedCandidateLinks).values({ comparison_id: header.id, mixed_experiment_id: args.mixed_experiment_id, baseline_experiment_id: args.baseline_experiment_id, linked_at: nowIso() });
    return (await loadComparison(args))!;
  });
}

function validateCandidate(header: Header, evidence: MixedCandidateEvidence, label: "mixed" | "baseline", attempt: Attempt) {
  if (evidence.label !== label || evidence.attempt_id !== attempt.id || evidence.copied_workspace_id !== attempt.workspace_id) {
    throw new MixedComparisonError("invalid_attempt", "Candidate label or attempt identity does not match its immutable link.");
  }
  if (!identical(evidence.original_assembly, header.original_assemblies[label])) throw new MixedComparisonError("identity_mismatch", "Original assembly does not match the retained nomination.");
  if (evidence.setup && (evidence.setup.source_fingerprint !== attempt.source_fingerprint || evidence.setup.baseline_fingerprint !== attempt.baseline_fingerprint ||
    evidence.setup.pack_fingerprint !== header.pack_fingerprint || evidence.setup.evaluator_version !== header.evaluator_version ||
    evidence.setup.gate_policy !== header.gate_policy || evidence.setup.gate_policy_fingerprint !== header.gate_policy_fingerprint)) {
    throw new MixedComparisonError("identity_mismatch", "Candidate setup does not match retained attempt and comparison identities.");
  }
  if (evidence.status === "completed" && attempt.status !== "completed") throw new MixedComparisonError("invalid_attempt", "A completed candidate requires a completed linked attempt.");
  if (evidence.status !== "completed" && attempt.status === "completed") throw new MixedComparisonError("invalid_attempt", "Non-completed candidate cannot reference a completed attempt.");
  for (const stage of evidence.stages) {
    if (stage.status === "pending" || stage.status === "skipped") continue;
    if (stage.status === "completed" && !stage.calls.length) throw new MixedComparisonError("incomplete_evidence", "Successful stages require linked retained call evidence.");
    for (const identity of stage.calls) {
      const call = attempt.calls.find(row => row.call_id === identity.call_id && row.version_index === identity.version_index);
      if (!call || call.workspace_id !== attempt.workspace_id || call.call_kind !== stage.stage) throw new MixedComparisonError("incomplete_evidence", "Stage references an unknown or crossed call version.");
      if (stage.status === "completed" && (call.output_error || call.module_version !== stage.module_version)) throw new MixedComparisonError("incomplete_evidence", "Successful stage references a failed or incompatible call.");
    }
    if (stage.status === "completed") {
      const last = stage.calls[stage.calls.length - 1];
      const call = attempt.calls.find(row => row.call_id === last.call_id && row.version_index === last.version_index)!;
      const retained = stage.calls.map(identity => attempt.calls.find(row => row.call_id === identity.call_id && row.version_index === identity.version_index)!);
      let matches = identical(call.output, stage.output);
      // Per-object modules retain their native outputs. The terminal stage artifact
      // may aggregate those outputs; it must be backed by every linked object call.
      if (!matches && stage.stage === "coverage_decide") matches = stage.output.decisions.length > 0 && stage.output.decisions.every(decision => retained.some(row => identical(row.output, Object.fromEntries(Object.entries(decision).filter(([key]) => key !== "id" && key !== "validated")))));
      if (!matches && stage.stage === "coverage_critic") matches = stage.output.reviews.length > 0 && stage.output.reviews.every(review => retained.some(row => identical(row.output, review.output)));
      if (!matches && stage.stage === "partial_split") matches = stage.output.residuals.length > 0 && stage.output.residuals.every(residual => retained.some(row => identical(row.output, Object.fromEntries(Object.entries(residual).filter(([key]) => key !== "parent_gap_id")))));
      if (!matches || !stage.run_ids.length || stage.run_ids.some(run_id => !retained.some(row => row.call_id === run_id))) throw new MixedComparisonError("incomplete_evidence", "Successful stage output or run identity is not backed by retained call evidence.");
    }
  }
}

/** Self-contained, source-scoped JSON or one complete record per JSONL line. */
export async function exportMixedComparison(args: MixedComparisonScope & { format: "json" | "jsonl" }): Promise<string | null> {
  if (args.format !== "json" && args.format !== "jsonl") throw new MixedComparisonError("invalid_input", "Unsupported comparison export format.");
  const record = await readMixedComparison(args);
  return record ? JSON.stringify(record) + (args.format === "jsonl" ? "\n" : "") : null;
}


async function validateCopiedScope(evidence: Extract<MixedCandidateEvidence, { status: "completed" }>, attempt: Attempt) {
  const sourceIds = Object.values(evidence.copy.source_id_map);
  const blockIds = Object.values(evidence.copy.block_id_map);
  const selected = evidence.lineage.filter(row => row.kind === "selected");
  const claimIds = [...new Set([...selected.map(row => row.copied_claim_id), ...evidence.final_source_inventory.map(row => row.claim_id)])];
  const evidenceIds = [...new Set(selected.flatMap(row => row.copied_evidence_ids))];
  const sources = await accuracyDb().select().from(t.accuracySourceFiles).where(and(eq(t.accuracySourceFiles.workspace_id, attempt.workspace_id), inArray(t.accuracySourceFiles.id, sourceIds)));
  const blocks = blockIds.length ? await accuracyDb().select().from(t.accuracyParseBlocks).where(and(eq(t.accuracyParseBlocks.workspace_id, attempt.workspace_id), inArray(t.accuracyParseBlocks.id, blockIds))) : [];
  const claims = claimIds.length ? await accuracyDb().select().from(t.accuracyClaims).where(and(eq(t.accuracyClaims.workspace_id, attempt.workspace_id), inArray(t.accuracyClaims.id, claimIds))) : [];
  const provenance = evidenceIds.length ? await accuracyDb().select().from(t.accuracyProvenance).where(and(eq(t.accuracyProvenance.workspace_id, attempt.workspace_id), inArray(t.accuracyProvenance.id, evidenceIds))) : [];
  if (sources.length !== sourceIds.length || sources.some(row => row.org_id !== attempt.org_id || row.reference_pack_id) ||
    blocks.length !== blockIds.length || blocks.some(row => !sourceIds.includes(row.source_file_id)) || claims.length !== claimIds.length ||
    claims.some(row => row.source_file_id !== null && !sourceIds.includes(row.source_file_id)) || provenance.length !== evidenceIds.length ||
    selected.some(row => !row.copied_evidence_ids.length || row.copied_evidence_ids.some(id => !provenance.some(span => span.id === id && span.claim_id === row.copied_claim_id && sourceIds.includes(span.source_file_id) && blockIds.includes(span.block_id))))) {
    throw new MixedComparisonError("identity_mismatch", "Copied sources, blocks, selected claims, or evidence cross the linked workspace scope.");
  }
  for (const original of evidence.setup.source_files) {
    const copied = sources.find(row => row.id === evidence.copy.source_id_map[original.id]);
    if (!copied || copied.checksum !== original.checksum) throw new MixedComparisonError("identity_mismatch", "Copied source checksum does not match retained original setup.");
  }
  for (const original of evidence.setup.parse_blocks) {
    const copied = blocks.find(row => row.id === evidence.copy.block_id_map[original.id]);
    if (!copied || copied.source_file_id !== evidence.copy.source_id_map[original.source_file_id]) throw new MixedComparisonError("identity_mismatch", "Copied parse block has a crossed source identity.");
  }
}
