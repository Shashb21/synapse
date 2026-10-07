/** Confirmed S6 writes remain wholly in one Accuracy transaction. No provider runs here. */
import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { computeCoverageStatus } from "@/lib/iegp/coverage-status";
import { claimFactualRevision, claimValidationFreshness, emptyGapStructuredFields, readStructuredFields, structuredProvenance } from "@/accuracy/domain/structured-fields";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import { accuracyDb, withAccuracyWorkspaceMutation } from "./db";
import * as t from "./schema";
import { claimMetadata, getClaim, insertClaim, isActiveLedgerClaim, requireClaimActor, requireValidationRationale, applyClaimValidation, type AccuracyClaimRow, type AccuracyClaimMetadata } from "./claim-store";
import { withHumanEdit } from "./claim-edit";
import { listCoverageJoins, upsertCoverageDecision, type CoverageJoinRow } from "./coverage-store";
import { getWorkspace } from "./tenant";
import { provenanceSpanSchema, validateProvenance, type ProvenanceSpan, type ParseBlock } from "./quote-validator";
import { readParseBlocksByIds } from "./parse-store";

export class SplitError extends Error {
  constructor(readonly code: "unknown_gap" | "unconfirmed" | "ineligible_parent" | "stale_revision" | "invalid_split" | "unsupported_evidence" | "operation_conflict" | "rollback_blocked" | "unknown_operation", message: string) {
    super(message); this.name = "SplitError";
  }
}
export const splitProposalSchema = z.object({
  workspace_id: z.string().min(1), parent_gap_id: z.string().min(1),
  expected_parent_revision: z.string().min(1), expected_coverage_revision: z.string().min(1),
  confirmed: z.boolean(), addressed_name: z.string().trim().min(3), addressed_statement: z.string().trim().min(3),
  addressed_tactic_ids: z.array(z.string().min(1)).min(1),
  open_name: z.string().trim().min(3), open_statement: z.string().trim().min(3),
  uncovered_dimensions: z.array(z.enum(COVERAGE_DIMENSIONS)).min(1),
  addressed_evidence: z.array(provenanceSpanSchema).min(1), open_evidence: z.array(provenanceSpanSchema),
  confidence: z.number().min(0).max(100), rationale: z.array(z.string().trim().min(3)).min(1),
}).strict();
export type SplitProposal = z.infer<typeof splitProposalSchema>;
export type SplitOperation = typeof t.accuracySplitOperations.$inferSelect;
export function splitFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
const sorted = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function spans(claim: AccuracyClaimRow): ProvenanceSpan[] {
  const parsed = provenanceSpanSchema.array().safeParse(claimMetadata(claim).provenance ?? []);
  if (!parsed.success) throw new SplitError("unsupported_evidence", "Malformed source evidence.");
  return [...parsed.data, ...structuredProvenance(readStructuredFields(claim))];
}
async function inputs(workspace_id: string, gap_id: string) {
  if (!await getWorkspace(workspace_id)) throw new SplitError("unknown_gap", "Unknown workspace.");
  const parent = await getClaim(workspace_id, gap_id);
  if (!parent || parent.claim_type !== "gap") throw new SplitError("unknown_gap", "Unknown gap in workspace.");
  if (!isActiveLedgerClaim(parent) || claimValidationFreshness(parent) !== "current")
    throw new SplitError("ineligible_parent", "A current human-validated active parent is required.");
  const raw = (await listCoverageJoins(workspace_id)).filter(c => c.gap_id === gap_id);
  const effective = (await listCoverageJoins(workspace_id, { effective: true })).filter(c => c.gap_id === gap_id);
  const tacticIds = [...new Set(raw.map(c => c.tactic_id))];
  const tactics = tacticIds.length ? await accuracyDb().select().from(t.accuracyClaims).where(and(eq(t.accuracyClaims.workspace_id, workspace_id), inArray(t.accuracyClaims.id, tacticIds))) : [];
  const lifecycle = (c: CoverageJoinRow) => claimMetadata(tactics.find(t => t.id === c.tactic_id)!).tactic_status ?? tactics.find(t => t.id === c.tactic_id)?.status;
  const byId = new Map(tactics.map(t => [t.id, t]));
  const assessments = effective.filter(c => byId.has(c.tactic_id)).map(c => ({ ...c, lifecycle: lifecycle(c) }));
  if (computeCoverageStatus(assessments) !== "partial") throw new SplitError("ineligible_parent", "Only current validated Partial coverage can supply a split.");
  const supporting = assessments.filter(c => computeCoverageStatus([c]) === "partial");
  const evidence = [...new Map([parent, ...tactics.filter(t => supporting.some(c => c.tactic_id === t.id))]
    .flatMap(spans).map(span => [splitFingerprint(span), span])).values()];
  const blocks = await readParseBlocksByIds(workspace_id, [...new Set(evidence.map(e => e.block_id))]);
  const sources = await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, workspace_id));
  const sourceIds = new Set(evidence.map(e => e.source_file_id));
  const revisions = { expected_parent_revision: claimFactualRevision(parent),
    expected_coverage_revision: splitFingerprint({ parent, raw: sorted(raw), tactics: sorted(tactics), blocks: sorted(blocks), sources: sorted(sources.filter(s => sourceIds.has(s.id))) }) };
  return { parent, raw, effective, tactics, supporting, evidence, blocks, sources, revisions };
}
/** Consistent read for human/manual inputs or a later model proposal. Lock releases before model work. */
export async function readAccuracySplitInputs(args: { workspace_id: string; gap_id: string }) {
  return withAccuracyWorkspaceMutation(args.workspace_id, () => inputs(args.workspace_id, args.gap_id));
}
export async function listAccuracySplitOperations(workspace_id: string): Promise<SplitOperation[]> {
  return withAccuracyWorkspaceMutation(workspace_id, () => accuracyDb().select().from(t.accuracySplitOperations).where(eq(t.accuracySplitOperations.workspace_id, workspace_id)).orderBy(t.accuracySplitOperations.created_at));
}
function assertEvidence(selected: ProvenanceSpan[], permitted: ProvenanceSpan[], state: Awaited<ReturnType<typeof inputs>>) {
  const allowed = new Set(permitted.map(splitFingerprint));
  for (const span of selected) {
    const block = state.blocks.find(b => b.id === span.block_id);
    if (!allowed.has(splitFingerprint(span)) || !block || !state.sources.some(s => s.id === span.source_file_id)
      || !validateProvenance({ span, block: block as ParseBlock }).ok)
      throw new SplitError("unsupported_evidence", "Slice evidence must be an exact permitted quote from this workspace.");
  }
}
/** The same live-input rules validate model suggestions and the locked human apply. */
export function validateAccuracySplitProposal(p: SplitProposal, state: Awaited<ReturnType<typeof readAccuracySplitInputs>>): void {
  if (p.expected_parent_revision !== state.revisions.expected_parent_revision || p.expected_coverage_revision !== state.revisions.expected_coverage_revision)
    throw new SplitError("stale_revision", "Parent or coverage inputs changed; reload the split.");
  const normalized = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (![p.addressed_statement, p.open_statement].every(text => normalized(text).length > 0) || new Set([state.parent.statement, p.addressed_statement, p.open_statement].map(normalized)).size !== 3 || normalized(p.addressed_name) === normalized(p.open_name))
    throw new SplitError("invalid_split", "Both slices must be distinct, nonempty and narrower than the parent.");
  if (new Set(p.addressed_tactic_ids).size !== p.addressed_tactic_ids.length || p.addressed_tactic_ids.some(id => !state.supporting.some(c => c.tactic_id === id)))
    throw new SplitError("unsupported_evidence", "Every slice tactic needs current validated committed supporting coverage.");
  const pairEvidence = (coverage: CoverageJoinRow) => {
    const tactic = state.tactics.find(t => t.id === coverage.tactic_id)!;
    const original = [state.parent, tactic].flatMap(spans);
    const selected = (coverage.dimensions as { evidence?: string[] }).evidence ?? [];
    // Task4 permits an empty selected list on a genuinely source-backed pair.
    // Human split confirmation still selects exact original spans explicitly.
    return selected.length ? original.filter(span => selected.includes(span.block_id)) : original;
  };
  const closing = state.supporting.filter(c => p.addressed_tactic_ids.includes(c.tactic_id));
  assertEvidence(p.addressed_evidence, closing.flatMap(pairEvidence), state);
  assertEvidence(p.open_evidence, spans(state.parent), state);
  for (const coverage of closing) {
    const allowed = new Set(pairEvidence(coverage).map(splitFingerprint));
    if (!p.addressed_evidence.some(span => allowed.has(splitFingerprint(span))))
      throw new SplitError("unsupported_evidence", "Each closing tactic must support the confirmed slice evidence.");
  }
  for (const dimension of p.uncovered_dimensions) {
    const values = state.supporting.map(c => {
      const raw = (c.dimensions as Record<string, unknown>)[dimension];
      return raw && typeof raw === "object" ? (raw as { value?: unknown }).value : raw;
    });
    if (values.length && values.every(value => value === "yes"))
      throw new SplitError("invalid_split", "Residual dimensions contradict current supporting coverage.");
  }
}

export type SplitSnapshot = { before_parent: AccuracyClaimRow; after_claims: AccuracyClaimRow[]; after_coverage: CoverageJoinRow[];
  after_provenance: (typeof t.accuracyProvenance.$inferSelect)[];
  evidence_state: { blocks: Awaited<ReturnType<typeof readParseBlocksByIds>>; sources: (typeof t.accuracySourceFiles.$inferSelect)[] }; dependencies: { id: string; revision: string }[] };
async function related(workspace_id: string, ids: string[]) {
  const claims = await accuracyDb().select().from(t.accuracyClaims).where(and(eq(t.accuracyClaims.workspace_id, workspace_id), inArray(t.accuracyClaims.id, ids)));
  const coverage = await accuracyDb().select().from(t.accuracyCoverageJoins).where(and(eq(t.accuracyCoverageJoins.workspace_id, workspace_id), or(inArray(t.accuracyCoverageJoins.gap_id, ids), inArray(t.accuracyCoverageJoins.tactic_id, ids))));
  const provenance = await accuracyDb().select().from(t.accuracyProvenance).where(and(eq(t.accuracyProvenance.workspace_id, workspace_id), inArray(t.accuracyProvenance.claim_id, ids)));
  return { claims: sorted(claims), coverage: sorted(coverage), provenance: sorted(provenance) };
}
export async function applyAccuracySplit(args: { workspace_id: string; proposal: SplitProposal; operation_key: string; actor: Actor; rationale: string }) {
  requireClaimActor(args.actor); const rationale = requireValidationRationale(args.rationale);
  const p = splitProposalSchema.parse(args.proposal);
  if (!p.confirmed) throw new SplitError("unconfirmed", "Human confirmation is required; model proposals never apply themselves.");
  if (p.workspace_id !== args.workspace_id) throw new SplitError("unknown_gap", "Proposal belongs to another workspace.");
  if (!args.operation_key?.trim() || args.operation_key.length > 200) throw new SplitError("invalid_split", "A unique operation key is required.");
  const request_fingerprint = splitFingerprint({ proposal: p, rationale, actor: args.actor });
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const [prior] = await accuracyDb().select().from(t.accuracySplitOperations).where(and(eq(t.accuracySplitOperations.workspace_id, args.workspace_id), eq(t.accuracySplitOperations.operation_key, args.operation_key))).for("update");
    const result = (op: SplitOperation) => ({ addressed_gap_id: op.addressed_gap_id, open_residual_gap_id: op.open_residual_gap_id, operation_id: op.id });
    if (prior) {
      if (prior.request_fingerprint !== request_fingerprint || prior.state !== "applied") throw new SplitError("operation_conflict", "Operation key already used or rolled back.");
      return result(prior);
    }
    await accuracyDb().select().from(t.accuracyClaims).where(and(eq(t.accuracyClaims.workspace_id, args.workspace_id), eq(t.accuracyClaims.id, p.parent_gap_id))).for("update");
    const state = await inputs(args.workspace_id, p.parent_gap_id);
    validateAccuracySplitProposal(p, state);
    const operation_id = newId("split"), at = nowIso();
    const createChild = async (kind: "addressed" | "open") => {
      const statement = kind === "addressed" ? p.addressed_statement : p.open_statement;
      const evidence = kind === "addressed" ? p.addressed_evidence : p.open_evidence;
      const metadata = withHumanEdit({ origin: "confirmed_split", parent_gap_id: state.parent.id, split_operation_id: operation_id,
        name: kind === "addressed" ? p.addressed_name : p.open_name,
        provenance: evidence, inherited_context: spans(state.parent), inherited_structured: readStructuredFields(state.parent),
        structured: { ...emptyGapStructuredFields("split_not_confirmed"), description: { state: "known", value: statement, provenance: evidence } },
        uncovered_dimensions: kind === "open" ? p.uncovered_dimensions : [],
      }, { action: "split", fields: ["statement", "provenance", "parent_gap_id"], before: { parent_gap_id: state.parent.id }, after: { statement }, actor: args.actor, rationale, at });
      // A residual may have only inherited context; do not fabricate direct structured evidence.
      if (!evidence.length) metadata.structured = emptyGapStructuredFields("inherited_context_only");
      const child = await insertClaim({ workspace_id: args.workspace_id, claim_type: "gap", statement,
        source_file_id: evidence[0]?.source_file_id ?? state.parent.source_file_id, metadata });
      await applyClaimValidation({ workspace_id: args.workspace_id, claim_ids: [child.id], action: "validate", actor: args.actor, rationale });
      return (await getClaim(args.workspace_id, child.id))!;
    };
    const addressed = await createChild("addressed");
    const residual = await createChild("open");
    for (const tactic of state.tactics.filter(t => state.supporting.some(c => c.tactic_id === t.id))) {
      if (p.addressed_tactic_ids.includes(tactic.id)) await upsertCoverageDecision({ workspace_id: args.workspace_id,
        gap_id: addressed.id, tactic_id: tactic.id, expected_gap_revision: claimFactualRevision(addressed), expected_tactic_revision: claimFactualRevision(tactic),
        overall: "full", evidence: p.addressed_evidence.map(s => s.block_id), rationale, actor: args.actor });
      await upsertCoverageDecision({ workspace_id: args.workspace_id, gap_id: residual.id, tactic_id: tactic.id,
        expected_gap_revision: claimFactualRevision(residual), expected_tactic_revision: claimFactualRevision(tactic), overall: "pending", evidence: [], rationale: "Residual requires a new coverage assessment", actor: args.actor });
    }
    await accuracyDb().update(t.accuracyClaims).set({ status: "retired", validated: false, updated_at: at,
      metadata: withHumanEdit(claimMetadata(state.parent), { action: "split", fields: ["split"], before: { status: state.parent.status },
        after: { addressed_gap_id: addressed.id, open_residual_gap_id: residual.id, operation_id }, actor: args.actor, rationale, at }) }).where(and(eq(t.accuracyClaims.workspace_id, args.workspace_id), eq(t.accuracyClaims.id, state.parent.id)));
    const after = await related(args.workspace_id, [state.parent.id, addressed.id, residual.id]);
    const snapshot: SplitSnapshot = { before_parent: state.parent, after_claims: after.claims, after_coverage: after.coverage,
      after_provenance: after.provenance, evidence_state: { blocks: sorted(state.blocks), sources: sorted(state.sources.filter(s => state.evidence.some(e => e.source_file_id === s.id))) }, dependencies: state.tactics.map(t => ({ id: t.id, revision: claimFactualRevision(t) })) };
    const [operation] = await accuracyDb().insert(t.accuracySplitOperations).values({ id: operation_id, workspace_id: args.workspace_id,
      operation_key: args.operation_key, request_fingerprint, parent_gap_id: state.parent.id, addressed_gap_id: addressed.id,
      open_residual_gap_id: residual.id, state: "applied", snapshot, audit: withHumanEdit({}, { action: "split", fields: ["split"],
        before: { parent_gap_id: state.parent.id }, after: { proposal: p }, actor: args.actor, rationale, at }), created_at: at }).returning();
    return result(operation);
  });
}
/** Exact parent restore is allowed only while every derived record still equals the saved output. */
export async function rollbackAccuracySplit(args: { workspace_id: string; operation_id: string; actor: Actor; rationale: string }): Promise<void> {
  requireClaimActor(args.actor); const rationale = requireValidationRationale(args.rationale);
  await withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const [op] = await accuracyDb().select().from(t.accuracySplitOperations).where(and(eq(t.accuracySplitOperations.workspace_id, args.workspace_id), eq(t.accuracySplitOperations.id, args.operation_id))).for("update");
    if (!op) throw new SplitError("unknown_operation", "Unknown split operation in workspace.");
    if (op.state === "rolled_back") return;
    const snapshot = op.snapshot as SplitSnapshot;
    const ids = [op.parent_gap_id, op.addressed_gap_id, op.open_residual_gap_id];
    const current = await related(args.workspace_id, ids);
    const allClaims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, args.workspace_id));
    const descendant = allClaims.some(c => !ids.includes(c.id) && ids.includes(String(claimMetadata(c).parent_gap_id)));
    if (descendant || splitFingerprint(current) !== splitFingerprint({ claims: snapshot.after_claims, coverage: snapshot.after_coverage, provenance: snapshot.after_provenance })
      || snapshot.dependencies.some(d => { const c = allClaims.find(c => c.id === d.id); return !c || claimFactualRevision(c) !== d.revision; }))
      throw new SplitError("rollback_blocked", "Later descendant, human, coverage, priority or supporting factual edits block rollback.");
    // Recheck live source validity too: restoring a validation after an evidence edit would lose its stale marker.
    const parentSpans = spans(snapshot.before_parent);
    const blocks = await readParseBlocksByIds(args.workspace_id, snapshot.evidence_state.blocks.map(b => b.id));
    const sources = await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, args.workspace_id));
    if (splitFingerprint({ blocks: sorted(blocks), sources: sorted(sources.filter(s => snapshot.evidence_state.sources.some(before => before.id === s.id))) }) !== splitFingerprint(snapshot.evidence_state)
      || parentSpans.some(span => { const block = blocks.find(b => b.id === span.block_id); return !sources.some(s => s.id === span.source_file_id) || !block || !validateProvenance({ span, block: block as ParseBlock }).ok; }))
      throw new SplitError("rollback_blocked", "Source evidence changed; restoring validated parent is unsafe.");
    const at = nowIso();
    for (const id of [op.addressed_gap_id, op.open_residual_gap_id]) {
      const child = current.claims.find(c => c.id === id)!;
      await accuracyDb().update(t.accuracyClaims).set({ status: "retired", validated: false, updated_at: at,
        metadata: withHumanEdit(claimMetadata(child), { action: "rollback", fields: ["split"], before: { status: child.status }, after: { status: "retired" }, actor: args.actor, rationale, at }) }).where(and(eq(t.accuracyClaims.workspace_id, args.workspace_id), eq(t.accuracyClaims.id, id)));
    }
    for (const join of current.coverage.filter(c => c.gap_id !== op.parent_gap_id)) {
      await accuracyDb().update(t.accuracyCoverageJoins).set({ overall: "pending", validated: false,
        dimensions: { ...(join.dimensions as Record<string, unknown>), retired_by_rollback: op.id, retired_at: at,
          validation_stale: true, prior_validated: join.validated } }).where(and(eq(t.accuracyCoverageJoins.workspace_id, args.workspace_id), eq(t.accuracyCoverageJoins.id, join.id)));
    }
    await accuracyDb().update(t.accuracyClaims).set(snapshot.before_parent).where(and(eq(t.accuracyClaims.workspace_id, args.workspace_id), eq(t.accuracyClaims.id, op.parent_gap_id)));
    await accuracyDb().update(t.accuracySplitOperations).set({ state: "rolled_back", rolled_back_at: at,
      audit: withHumanEdit(op.audit as AccuracyClaimMetadata, { action: "rollback", fields: ["split"], before: { state: "applied" }, after: { state: "rolled_back" }, actor: args.actor, rationale, at }) }).where(and(eq(t.accuracySplitOperations.workspace_id, args.workspace_id), eq(t.accuracySplitOperations.id, op.id)));
  });
}
