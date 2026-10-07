import { AiDisabledError } from "@/modules/kernel/ai-switch";
import { AccuracyPausedError } from "@/accuracy/kernel/omission-pause";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction, withAccuracyWorkspaceMutation, accuracyTransactionActive } from "./db";
import * as t from "./schema";
import { readParseBlocksByIds } from "./parse-store";
import { validateProvenance, provenanceSpanSchema, type ParseBlock } from "./quote-validator";
import { newId } from "@/modules/kernel/ids";
import { claimMetadata, getClaimsByIds, isActiveLedgerClaim, type AccuracyClaimRow } from "./claim-store";
import { claimFactualRevision, structuredProvenance, readStructuredFields } from "@/accuracy/domain/structured-fields";

export type CoverageJoinRow = typeof t.accuracyCoverageJoins.$inferSelect;
export type CoverageOverall = "pending" | "full" | "partial" | "limited" | "not_relevant";
export type CoverageFreshness = "current" | "stale" | "unknown" | "unassessed";
export type CoveragePair = {
  id: string; gap: AccuracyClaimRow; tactic: AccuracyClaimRow;
  overall: string | null; rationale: string | null; validated: boolean;
  gap_revision?: string; tactic_revision?: string;
  freshness?: CoverageFreshness; validation_freshness?: CoverageFreshness;
  assessment_state?: "pending" | "successful" | "failed" | "rejected";
  failure_reason?: string | null; protected?: boolean;
  evidence?: string[];
};
export type CoverageProgress = {
  eligible_total: number; pending: number; assessed: number; validated: number;
  stale: number; unknown: number; failed: number; rejected: number;
  excluded_claims: number; exclusions: { claim_id: string; reason: string }[];
  assessment_complete: boolean; validation_complete: boolean;
};
export class CoverageError extends Error {
  constructor(readonly code: "stale_snapshot" | "invalid_cursor" | "stale_revision" | "invalid_evidence" | "protected_pair", message: string) {
    super(message); this.name = "CoverageError";
  }
}
export function canonicalCoverageOverall(value: string | null | undefined): CoverageOverall {
  switch ((value ?? "").trim().toLowerCase()) {
    case "full": case "covers": return "full";
    case "partial": return "partial";
    case "limited": return "limited";
    case "none": case "not_relevant": return "not_relevant";
    default: return "pending";
  }
}
/** Inventory lifecycle does not limit assessment. Proposed/cancelled/unknown remain inspectable. */
export function coverageExclusionReason(claim: AccuracyClaimRow): string | null {
  const meta = claimMetadata(claim);
  if (!isActiveLedgerClaim(claim)) return claim.status;
  if (claim.status === "excluded" || meta.excluded === true || meta.review_status === "rejected") return "excluded";
  if (claim.status === "retired" || meta.retired === true || meta.retired_at) return "retired";
  if (claim.status === "ideated" || ["ideation", "ideated"].includes(String(meta.origin))) return "ideated";
  return null;
}
function dimensions(join?: CoverageJoinRow): Record<string, unknown> {
  return (join?.dimensions ?? {}) as Record<string, unknown>;
}
/** Freshness is factual, never timestamp-based. Legacy validation stays unknown. */
export function coverageFreshness(join: CoverageJoinRow, gap: AccuracyClaimRow, tactic: AccuracyClaimRow): CoverageFreshness {
  const d = dimensions(join);
  if (join.workspace_id !== gap.workspace_id || join.workspace_id !== tactic.workspace_id || join.gap_id !== gap.id || join.tactic_id !== tactic.id) return "stale";
  if (d.validation_stale === true) return "stale";
  if (!d.gap_revision || !d.tactic_revision) return "unknown";
  return d.gap_revision === claimFactualRevision(gap) && d.tactic_revision === claimFactualRevision(tactic) ? "current" : "stale";
}
function pairFrom(gap: AccuracyClaimRow, tactic: AccuracyClaimRow, join?: CoverageJoinRow): CoveragePair {
  const d = dimensions(join);
  const freshness = join ? coverageFreshness(join, gap, tactic) : "unassessed";
  const rejected = d.human_rejected === true;
  const overall = rejected ? "pending" : canonicalCoverageOverall(join?.overall);
  const failed = d.assessment_state === "failed" && freshness === "current";
  return { id: join?.id ?? `pair_${gap.id}_${tactic.id}`, gap, tactic, overall,
    rationale: join?.rationale ?? null, validated: Boolean(join?.validated && freshness === "current" && overall !== "pending" && !rejected),
    gap_revision: claimFactualRevision(gap), tactic_revision: claimFactualRevision(tactic), freshness,
    validation_freshness: join?.validated || d.prior_validated === true ? freshness : "unassessed",
    assessment_state: rejected ? "rejected" : failed ? "failed" : overall !== "pending" && freshness === "current" ? "successful" : "pending",
    failure_reason: typeof d.failure_reason === "string" ? d.failure_reason : null,
    protected: Boolean(rejected || d.actor || join?.validated || d.prior_validated),
    evidence: !rejected && Array.isArray(d.evidence) ? d.evidence.filter((id): id is string => typeof id === "string") : [] };
}
/** Include the input tokens in module inputs as well as persistence, so cached runs cannot cross factual revisions. */
export function coverageFactsForPair(pair: Pick<CoveragePair, "gap" | "tactic">) {
  function facts(claim: AccuracyClaimRow) {
    const meta = claimMetadata(claim);
    const keys = ["external_id", "identifier", "chapter", "si_theme", "reference_pack_id", "origin", "type", "tactic_type",
      "evidence_question", "design_summary", "start", "end", "readout", "readout_date", "evidence_available",
      "depends_on", "gap_ids", "parent_gap_id", "description", "indication", "disease_setting", "category",
      "evidence_domain", "rationale", "supporting_documents", "interview_quotes", "objective", "owner", "timing", "outputs"];
    return { statement: claim.statement, structured: readStructuredFields(claim), factual_revision: claimFactualRevision(claim),
      fields: Object.fromEntries(keys.map((key) => [key, meta[key] ?? null])) };
  }
  return { gap: facts(pair.gap), tactic: { ...facts(pair.tactic),
    lifecycle: claimMetadata(pair.tactic).tactic_status ?? pair.tactic.status } };
}
/** Trusted experiment owner only: translate current isomorphic facts, retain every historical token and actor. */
export function rebaseCopiedCoverage(args: { join: CoverageJoinRow; gap: AccuracyClaimRow; tactic: AccuracyClaimRow;
  copied_gap: AccuracyClaimRow; copied_tactic: AccuracyClaimRow; block_id_map: Record<string, string> }): CoverageJoinRow {
  const d = dimensions(args.join);
  if (coverageFreshness(args.join, args.gap, args.tactic) !== "current") return args.join;
  const evidence = Array.isArray(d.evidence) ? d.evidence.map((id) => {
    if (typeof id !== "string" || !args.block_id_map[id]) throw new CoverageError("invalid_evidence", "Copied coverage evidence is outside the selected source set.");
    return args.block_id_map[id];
  }) : [];
  return { ...args.join, dimensions: { ...d, evidence,
    copied_from_revisions: { gap_revision: d.gap_revision, tactic_revision: d.tactic_revision },
    gap_revision: claimFactualRevision(args.copied_gap), tactic_revision: claimFactualRevision(args.copied_tactic) } };
}
/** Full eligible entity picker, sharing the assessment eligibility owner. */
export async function listCoverageInventory(workspace_id: string) {
  await ensureAccuracySchema();
  const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace_id)).orderBy(t.accuracyClaims.id);
  return { gaps: claims.filter((c) => c.claim_type === "gap" && !coverageExclusionReason(c)),
    tactics: claims.filter((c) => c.claim_type === "tactic" && !coverageExclusionReason(c)) };
}
export type CoveragePageInput = { workspace_id: string; cursor?: string; page_size?: number };
export type CoveragePage = { pairs: CoveragePair[]; snapshot: string; next_cursor: string | null; progress: CoverageProgress };
/** Page bounds affect the response only; the complete deterministic Cartesian universe is counted. */
export async function listCoveragePage(args: CoveragePageInput): Promise<CoveragePage> {
  const page_size = args.page_size ?? 100;
  if (!Number.isSafeInteger(page_size) || page_size < 1 || page_size > 500) throw new Error("page_size must be an integer between 1 and 500.");
  return withAccuracyTransaction(async () => {
    const claims = await accuracyDb().select().from(t.accuracyClaims)
      .where(eq(t.accuracyClaims.workspace_id, args.workspace_id)).orderBy(t.accuracyClaims.id);
    const entities = claims.filter((c) => c.claim_type === "gap" || c.claim_type === "tactic");
    const exclusions = entities.flatMap((c) => { const reason = coverageExclusionReason(c); return reason ? [{ claim_id: c.id, reason }] : []; });
    const eligible = entities.filter((c) => !coverageExclusionReason(c));
    const gaps = eligible.filter((c) => c.claim_type === "gap");
    const tactics = eligible.filter((c) => c.claim_type === "tactic");
    const snapshot = createHash("sha256").update(JSON.stringify([1, args.workspace_id,
      entities.map((c) => [c.id, claimFactualRevision(c), coverageExclusionReason(c)])])).digest("hex");
    const total = gaps.length * tactics.length;
    let offset = 0;
    if (args.cursor) {
      if (args.cursor.length > 4096) throw new CoverageError("invalid_cursor", "Invalid coverage cursor; restart without cursor.");
      let cursor;
      try { cursor = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")); }
      catch { throw new CoverageError("invalid_cursor", "Invalid coverage cursor; restart without cursor."); }
      if (!cursor || typeof cursor !== "object" || cursor.v !== 1 || cursor.workspace_id !== args.workspace_id || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
        throw new CoverageError("invalid_cursor", "Invalid coverage cursor; restart without cursor.");
      if (cursor.snapshot !== snapshot) throw new CoverageError("stale_snapshot", "Coverage facts changed. Restart assessment without cursor; saved decisions are retained.");
      if (cursor.offset > total) throw new CoverageError("invalid_cursor", "Invalid coverage cursor offset; restart without cursor.");
      offset = cursor.offset;
    }
    const joins = await listCoverageJoins(args.workspace_id);
    const byKey = new Map(joins.map((j) => [`${j.gap_id}::${j.tactic_id}`, j]));
    const gapById = new Map(gaps.map((g) => [g.id, g]));
    const tacticById = new Map(tactics.map((g) => [g.id, g]));
    let assessed = 0, validated = 0, stale = 0, unknown = 0, failed = 0, rejected = 0;
    for (const j of joins) {
      const g = gapById.get(j.gap_id), tac = tacticById.get(j.tactic_id);
      if (!g || !tac) continue;
      const p = pairFrom(g, tac, j);
      if (p.assessment_state === "successful") assessed++;
      if (p.validated) validated++;
      if (p.freshness === "stale") stale++;
      if (p.freshness === "unknown") unknown++;
      if (p.assessment_state === "failed") failed++;
      if (p.assessment_state === "rejected") rejected++;
    }
    const pairs: CoveragePair[] = [];
    const end = Math.min(total, offset + page_size);
    for (let n = offset; n < end; n++) {
      const gap = gaps[Math.floor(n / tactics.length)], tactic = tactics[n % tactics.length];
      pairs.push(pairFrom(gap, tactic, byKey.get(`${gap.id}::${tactic.id}`)));
    }
    return { pairs, snapshot, next_cursor: end < total ? Buffer.from(JSON.stringify({ v: 1,
      workspace_id: args.workspace_id, snapshot, offset: end })).toString("base64url") : null,
      progress: { eligible_total: total, pending: total - assessed, assessed, validated, stale, unknown, failed, rejected,
        excluded_claims: exclusions.length, exclusions, assessment_complete: assessed === total, validation_complete: validated === total } };
  });
}
/** Compatibility readers deliberately exhaust pages; no merge/UI list limit participates. */
export async function listCoveragePairs(workspace_id: string): Promise<CoveragePair[]> {
  const pairs: CoveragePair[] = [];
  let cursor: string | undefined;
  do { const page = await listCoveragePage({ workspace_id, cursor, page_size: 500 });
    pairs.push(...page.pairs); cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return pairs;
}

/** Claims are workspace-scoped and must be eligible even for a human-selected pair. */
export async function requireCoveragePairClaims(args: PairIdentity): Promise<{ gap: AccuracyClaimRow; tactic: AccuracyClaimRow }> {
  const rows = await getClaimsByIds(args.workspace_id, [args.gap_id, args.tactic_id]);
  const gap = rows.find((row) => row.id === args.gap_id);
  const tactic = rows.find((row) => row.id === args.tactic_id);
  if (!gap || gap.claim_type !== "gap") throw new Error(`Unknown gap: ${args.gap_id}`);
  if (!tactic || tactic.claim_type !== "tactic") throw new Error(`Unknown tactic: ${args.tactic_id}`);
  if (coverageExclusionReason(gap) || coverageExclusionReason(tactic)) throw new Error("Coverage requires eligible active claims.");
  return { gap, tactic };
}
type PairIdentity = { workspace_id: string; gap_id: string; tactic_id: string };
export type CoverageRevisions = { expected_gap_revision: string; expected_tactic_revision: string };
export async function coveragePairRevisions(args: PairIdentity, claims?: { gap: AccuracyClaimRow; tactic: AccuracyClaimRow }): Promise<CoverageRevisions> {
  const { gap, tactic } = claims ?? await requireCoveragePairClaims(args);
  return { expected_gap_revision: claimFactualRevision(gap), expected_tactic_revision: claimFactualRevision(tactic) };
}
function pairWhere(args: PairIdentity) {
  return and(eq(t.accuracyCoverageJoins.workspace_id, args.workspace_id),
    eq(t.accuracyCoverageJoins.gap_id, args.gap_id), eq(t.accuracyCoverageJoins.tactic_id, args.tactic_id));
}
export type CoverageWrite = PairIdentity & Partial<CoverageRevisions> & {
  overall: string; rationale: string; evidence?: string[];
  expected_snapshot?: string;
  actor?: import("@/accuracy/kernel/contracts").Actor; run_id?: string;
};
async function checkedClaims(args: CoverageWrite) {
  // Row locks coordinate claim edits even when their owner only joins an Accuracy transaction.
  await accuracyDb().select().from(t.accuracyClaims).where(and(eq(t.accuracyClaims.workspace_id, args.workspace_id),
    inArray(t.accuracyClaims.id, [args.gap_id, args.tactic_id]))).orderBy(t.accuracyClaims.id).for("update");
  if (args.expected_snapshot && (await listCoveragePage({ workspace_id: args.workspace_id, page_size: 1 })).snapshot !== args.expected_snapshot)
    throw new CoverageError("stale_snapshot", "Coverage facts changed during assessment. Restart without cursor; saved decisions are retained.");
  const claims = await requireCoveragePairClaims(args);
  if (args.expected_gap_revision !== claimFactualRevision(claims.gap) || args.expected_tactic_revision !== claimFactualRevision(claims.tactic))
    throw new CoverageError("stale_revision", "Coverage factual revisions are missing or changed; reload the pair before saving.");
  return claims;
}
/** Evidence can only refer to original, still-valid provenance of this pair in this workspace. */
export async function requireCoverageEvidence(args: PairIdentity & { evidence?: string[] }, claims?: { gap: AccuracyClaimRow; tactic: AccuracyClaimRow }): Promise<void> {
  const { gap, tactic } = claims ?? await requireCoveragePairClaims(args);
  const spans = [gap, tactic].flatMap((c) => {
    const provenance = claimMetadata(c).provenance;
    const parsed = provenanceSpanSchema.array().safeParse(provenance ?? []);
    if (!parsed.success) throw new CoverageError("invalid_evidence", "Pair provenance has an invalid evidence span.");
    return [...parsed.data, ...structuredProvenance(readStructuredFields(c))];
  });
  const sourceIds = new Set([gap.source_file_id, tactic.source_file_id, ...spans.map((span) => span.source_file_id)]
    .filter((id): id is string => typeof id === "string"));
  if (sourceIds.size) {
    const sources = await accuracyDb().select({ id: t.accuracySourceFiles.id }).from(t.accuracySourceFiles)
      .where(and(eq(t.accuracySourceFiles.workspace_id, args.workspace_id), inArray(t.accuracySourceFiles.id, [...sourceIds])));
    if (sources.length !== sourceIds.size) throw new CoverageError("invalid_evidence", "Pair source provenance is outside this workspace or missing.");
  }
  const allowed = new Set(spans.map((span) => span.block_id));
  if ((args.evidence ?? []).some((id) => !allowed.has(id))) throw new CoverageError("invalid_evidence", "Evidence is outside this pair's permitted provenance.");
  const blocks = await readParseBlocksByIds(args.workspace_id, [...allowed]);
  for (const span of spans) {
    const block = blocks.find((b) => b.id === span.block_id);
    if (!block || !validateProvenance({ block: block as ParseBlock, span }).ok)
      throw new CoverageError("invalid_evidence", "Pair provenance is missing or does not match the original workspace evidence.");
  }
}
function historyOf(existing?: CoverageJoinRow): unknown[] {
  if (!existing) return [];
  const d = dimensions(existing);
  return [...(Array.isArray(d.decision_history) ? d.decision_history : []),
    { ...existing, dimensions: Object.fromEntries(Object.entries(d).filter(([k]) => k !== "decision_history")) }];
}
async function writeCoverage(args: CoverageWrite, kind: "human" | "model" | "rejection" | "failure"): Promise<CoverageJoinRow> {
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const claims = await checkedClaims(args);
    const [existing] = await accuracyDb().select().from(t.accuracyCoverageJoins).where(pairWhere(args)).for("update");
    if (kind === "model" || kind === "failure") {
      if (!args.run_id?.trim()) throw new Error("Assessment run_id is required.");
      if (existing) {
        const pair = pairFrom(claims.gap, claims.tactic, existing);
        if (pair.protected || pair.assessment_state === "successful") return existing;
      }
    } else if (!args.actor?.name.trim() || !args.actor.function) throw new Error("Authenticated actor is required for a human coverage decision.");
    if (kind !== "failure" && args.rationale.trim().length < 3) throw new Error("A short rationale is required for coverage.");
    const overall = kind === "rejection" || kind === "failure" ? "pending" : canonicalCoverageOverall(args.overall);
    if (kind === "rejection" && args.evidence?.length) throw new CoverageError("invalid_evidence", "A pair rejection does not accept supporting coverage evidence.");
    if (kind === "human" || kind === "model") await requireCoverageEvidence(args, claims);
    const at = new Date().toISOString();
    const nextDimensions = { ...dimensions(existing), decision_history: historyOf(existing),
      gap_revision: args.expected_gap_revision, tactic_revision: args.expected_tactic_revision,
      actor: kind === "human" || kind === "rejection" ? args.actor : null,
      run_id: args.run_id ?? null, decided_at: at, evidence: kind === "rejection" || kind === "failure" ? [] : args.evidence ?? [],
      human_rejected: kind === "rejection", assessment_state: kind === "failure" ? "failed" : kind === "rejection" ? "rejected" : overall === "pending" ? "pending" : "successful",
      failure_reason: kind === "failure" ? args.rationale : null,
      validation_stale: false, prior_validated: false };
    const row = { id: existing?.id ?? newId("cov"), workspace_id: args.workspace_id, gap_id: args.gap_id, tactic_id: args.tactic_id,
      overall, rationale: args.rationale.trim(), validated: kind === "human" && overall !== "pending",
      dimensions: nextDimensions, confidence: null };
    const [saved] = await accuracyDb().insert(t.accuracyCoverageJoins).values(row).onConflictDoUpdate({
      target: [t.accuracyCoverageJoins.workspace_id, t.accuracyCoverageJoins.gap_id, t.accuracyCoverageJoins.tactic_id],
      set: { overall: row.overall, rationale: row.rationale, validated: row.validated, dimensions: row.dimensions },
    }).returning();
    return saved;
  });
}
export async function upsertCoverageDecision(args: CoverageWrite): Promise<void> { await writeCoverage(args, "human"); }
export async function saveCoverageAssessment(args: CoverageWrite): Promise<CoverageJoinRow> {
  if (!["full", "partial", "limited", "not_relevant"].includes(args.overall)) throw new Error("Model omitted a canonical coverage verdict.");
  return writeCoverage(args, "model");
}
/** Provider callback is a system boundary: no request may enter a transaction or source lock. */
export async function assessCoveragePage(args: CoveragePageInput & {
  snapshot?: string;
  assess: (pair: CoveragePair) => Promise<{ overall: string; rationale: string; evidence: string[]; run_id: string } | undefined>;
}): Promise<CoveragePage & { attempts: { gap_id: string; tactic_id: string; error?: string }[] }> {
  if (accuracyTransactionActive()) throw new Error("Start coverage assessment outside every Accuracy transaction.");
  const page = await listCoveragePage(args);
  if (args.snapshot && args.snapshot !== page.snapshot) throw new CoverageError("stale_snapshot", "Coverage facts changed. Restart without cursor.");
  const attempts: { gap_id: string; tactic_id: string; error?: string }[] = [];
  for (const pair of page.pairs) {
    if (pair.protected || pair.assessment_state === "successful") continue;
    const identity = { workspace_id: args.workspace_id, gap_id: pair.gap.id, tactic_id: pair.tactic.id,
      expected_gap_revision: pair.gap_revision!, expected_tactic_revision: pair.tactic_revision!, expected_snapshot: page.snapshot };
    const attempt = { gap_id: pair.gap.id, tactic_id: pair.tactic.id };
    try {
      await requireCoverageEvidence(identity, { gap: pair.gap, tactic: pair.tactic });
      const result = await args.assess(pair);
      if (!result) throw new Error("Model omitted this pair; retry assessment.");
      await saveCoverageAssessment({ ...identity, ...result });
      attempts.push(attempt);
    } catch (error) {
      if (error instanceof AiDisabledError || error instanceof AccuracyPausedError) throw error;
      if (error instanceof CoverageError && ["stale_snapshot", "stale_revision"].includes(error.code)) throw error;
      const message = error instanceof Error ? error.message : "Assessment failed";
      await writeCoverage({ ...identity, overall: "pending", rationale: message, run_id: newId("covrun") }, "failure");
      attempts.push({ ...attempt, error: message });
    }
  }
  return { ...(await listCoveragePage(args)), attempts };
}
export async function rejectCoveragePair(args: Omit<CoverageWrite, "overall">): Promise<void> { await writeCoverage({ ...args, overall: "pending" }, "rejection"); }
export async function listCoverageJoins(workspace_id: string): Promise<CoverageJoinRow[]> {
  await ensureAccuracySchema();
  return accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, workspace_id));
}
/** Trusted legacy/import boundary. Missing revision/actor remains unknown; it cannot create current validation. */
export async function insertCoverageJoin(args: PairIdentity & { overall: string; validated?: boolean; rationale?: string | null }): Promise<CoverageJoinRow> {
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    await requireCoveragePairClaims(args);
    const [existing] = await accuracyDb().select().from(t.accuracyCoverageJoins).where(pairWhere(args));
    if (existing) return existing;
    const [row] = await accuracyDb().insert(t.accuracyCoverageJoins).values({ ...args,
      id: newId("cov"), overall: canonicalCoverageOverall(args.overall), dimensions: {}, confidence: null,
      validated: args.validated ?? true, rationale: args.rationale ?? null,
    }).onConflictDoNothing({ target: [t.accuracyCoverageJoins.workspace_id, t.accuracyCoverageJoins.gap_id, t.accuracyCoverageJoins.tactic_id] }).returning();
    return row;
  });
}
/** Merge collision retains both original rows and every nested decision/history before uniqueness. */
export async function reassignCoverageClaimId(args: { workspace_id: string; from_id: string; to_id: string; role: "gap" | "tactic" }): Promise<number> {
  if (args.from_id === args.to_id) return 0;
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const joins = await listCoverageJoins(args.workspace_id);
    let updated = 0;
    for (const join of joins) {
      if ((args.role === "gap" ? join.gap_id : join.tactic_id) !== args.from_id) continue;
      const next = { workspace_id: args.workspace_id, gap_id: args.role === "gap" ? args.to_id : join.gap_id,
        tactic_id: args.role === "tactic" ? args.to_id : join.tactic_id };
      const [collision] = await accuracyDb().select().from(t.accuracyCoverageJoins).where(pairWhere(next)).for("update");
      if (collision) {
        const candidates = [collision, join].sort((a, b) => Number(Boolean(dimensions(b).actor || b.validated || dimensions(b).prior_validated || dimensions(b).human_rejected))
          - Number(Boolean(dimensions(a).actor || a.validated || dimensions(a).prior_validated || dimensions(a).human_rejected)) || a.id.localeCompare(b.id));
        const survivor = candidates[0];
        await accuracyDb().update(t.accuracyCoverageJoins).set({ overall: survivor.overall, rationale: survivor.rationale,
          validated: false, dimensions: { ...dimensions(survivor), validation_stale: true, prior_validated: survivor.validated || dimensions(survivor).prior_validated,
            merge_history: [...(Array.isArray(dimensions(collision).merge_history) ? dimensions(collision).merge_history as unknown[] : []), collision, join] } }).where(pairWhere(next));
        await accuracyDb().delete(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.id, join.id));
      } else await accuracyDb().update(t.accuracyCoverageJoins).set({ gap_id: next.gap_id, tactic_id: next.tactic_id,
        validated: false, dimensions: { ...dimensions(join), validation_stale: true, prior_validated: join.validated || dimensions(join).prior_validated,
          merge_history: [...(Array.isArray(dimensions(join).merge_history) ? dimensions(join).merge_history as unknown[] : []), join] } }).where(eq(t.accuracyCoverageJoins.id, join.id));
      updated++;
    }
    return updated;
  });
}
