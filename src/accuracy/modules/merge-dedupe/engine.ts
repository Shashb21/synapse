import { statementSimilarity } from "@/lib/text";

/** Lifecycle statuses that conflict when the same tactic identity appears with different values. */
const TACTIC_STATUS_RANK: Record<string, number> = {
  cancelled: 0,
  proposed: 1,
  planned: 2,
  ongoing: 3,
  completed: 4,
};

export type MergeClaimKind = "gap" | "tactic";

export type ProvenanceLite = {
  source_file_id?: string;
  block_id?: string;
  quote?: string;
};

/** Normalized candidate or ledger row for merge matching. */
export type MergeCandidate = {
  id: string;
  claim_type: MergeClaimKind;
  statement: string;
  status?: string | null;
  external_id?: string | null;
  study_ids?: string[];
  provenance?: ProvenanceLite[];
};

export type MergeAction = "insert" | "merge" | "skip" | "contradict";

export type MergeDecision = {
  candidate_id: string;
  action: MergeAction;
  matched_id: string | null;
  reason: string;
};

export type MergeDedupeResult = {
  decisions: MergeDecision[];
  inserted: number;
  merged: number;
  skipped: number;
  contradictions: number;
};

const STUDY_ID_RE =
  /\b(?:NCT\d{8}|NSCLC_[A-Z]{2}_\d{2}|G:\d+|BGB[-\s]?\d{3,}|RATIONALE[-\s]?\d+|VEL[-\s]?\d{2,}|IIT[-\s]?\d+)\b/gi;

/** Extract deterministic study / gap identifiers from free text. */
export function extractStudyIds(text: string | null | undefined): string[] {
  if (!text?.trim()) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(STUDY_ID_RE)) {
    const raw = match[0]!.replace(/\s+/g, "").toUpperCase();
    found.add(raw);
  }
  return [...found];
}

function normalizeExternalId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, "").toUpperCase();
}

function normalizeStatementKey(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, " ");
}

function blockIds(provenance: ProvenanceLite[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const span of provenance ?? []) {
    const id = span.block_id?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function studyIdSet(candidate: MergeCandidate): Set<string> {
  const ids = new Set<string>();
  const external = normalizeExternalId(candidate.external_id);
  if (external) ids.add(external);
  for (const id of candidate.study_ids ?? []) {
    const n = normalizeExternalId(id);
    if (n) ids.add(n);
  }
  for (const id of extractStudyIds(candidate.statement)) ids.add(id);
  for (const span of candidate.provenance ?? []) {
    for (const id of extractStudyIds(span.quote)) ids.add(id);
  }
  return ids;
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function statusConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) return false;
  if (!(left in TACTIC_STATUS_RANK) || !(right in TACTIC_STATUS_RANK)) return false;
  const committed = new Set(["planned", "ongoing", "completed"]);
  return committed.has(left) && committed.has(right) && left !== right;
}

type MatchHit = {
  existing: MergeCandidate;
  reason: string;
  strength: "id" | "block" | "fuzzy";
};

function findMatch(
  candidate: MergeCandidate,
  existing: MergeCandidate[],
): MatchHit | null {
  const candExternal = normalizeExternalId(candidate.external_id);
  const candStudies = studyIdSet(candidate);
  const candBlocks = blockIds(candidate.provenance);
  const candKey = normalizeStatementKey(candidate.statement);

  let bestFuzzy: MatchHit | null = null;

  for (const row of existing) {
    if (row.claim_type !== candidate.claim_type) continue;

    const rowExternal = normalizeExternalId(row.external_id);
    if (candExternal && rowExternal && candExternal === rowExternal) {
      return { existing: row, reason: `external_id:${candExternal}`, strength: "id" };
    }

    const rowStudies = studyIdSet(row);
    if (setsIntersect(candStudies, rowStudies)) {
      const shared = [...candStudies].find((id) => rowStudies.has(id))!;
      return { existing: row, reason: `study_id:${shared}`, strength: "id" };
    }

    const rowKey = normalizeStatementKey(row.statement);
    if (candKey && candKey === rowKey) {
      return { existing: row, reason: "exact_statement", strength: "id" };
    }

    const rowBlocks = blockIds(row.provenance);
    if (setsIntersect(candBlocks, rowBlocks)) {
      const sim = statementSimilarity(candidate.statement, row.statement);
      if (sim >= 0.55) {
        return { existing: row, reason: "provenance_block_overlap", strength: "block" };
      }
    }

    const sim = statementSimilarity(candidate.statement, row.statement);
    if (sim >= 0.78) {
      const hit: MatchHit = {
        existing: row,
        reason: `fuzzy_statement:${sim.toFixed(2)}`,
        strength: "fuzzy",
      };
      if (
        !bestFuzzy ||
        sim > statementSimilarity(candidate.statement, bestFuzzy.existing.statement)
      ) {
        bestFuzzy = hit;
      }
    }
  }

  return bestFuzzy;
}

/**
 * Deterministic merge/dedupe of extract candidates against the existing ledger
 * (and within the incoming batch). Study IDs + provenance win over fuzzy text.
 */
export function mergeDedupeCandidates(args: {
  existing: MergeCandidate[];
  incoming: MergeCandidate[];
}): MergeDedupeResult {
  const ledger = [...args.existing];
  const decisions: MergeDecision[] = [];
  let inserted = 0;
  let merged = 0;
  let skipped = 0;
  let contradictions = 0;

  for (const candidate of args.incoming) {
    const hit = findMatch(candidate, ledger);
    if (!hit) {
      decisions.push({
        candidate_id: candidate.id,
        action: "insert",
        matched_id: null,
        reason: "no_match",
      });
      ledger.push(candidate);
      inserted += 1;
      continue;
    }

    if (
      candidate.claim_type === "tactic" &&
      statusConflict(candidate.status, hit.existing.status)
    ) {
      decisions.push({
        candidate_id: candidate.id,
        action: "contradict",
        matched_id: hit.existing.id,
        reason: `status_conflict:${hit.existing.status}->${candidate.status};${hit.reason}`,
      });
      contradictions += 1;
      continue;
    }

    if (hit.strength === "id" || hit.strength === "block") {
      decisions.push({
        candidate_id: candidate.id,
        action: "merge",
        matched_id: hit.existing.id,
        reason: hit.reason,
      });
      merged += 1;
      const folded: MergeCandidate = {
        ...hit.existing,
        study_ids: [...studyIdSet(hit.existing), ...studyIdSet(candidate)],
        provenance: [...(hit.existing.provenance ?? []), ...(candidate.provenance ?? [])],
      };
      const idx = ledger.findIndex((row) => row.id === hit.existing.id);
      if (idx >= 0) ledger[idx] = folded;
      continue;
    }

    decisions.push({
      candidate_id: candidate.id,
      action: "skip",
      matched_id: hit.existing.id,
      reason: hit.reason,
    });
    skipped += 1;
  }

  return { decisions, inserted, merged, skipped, contradictions };
}

/** Map a claim-store row (or extract output) into a merge candidate. */
export function claimToMergeCandidate(args: {
  id: string;
  claim_type: MergeClaimKind;
  statement: string;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}): MergeCandidate {
  const meta = args.metadata ?? {};
  const external =
    typeof meta.external_id === "string"
      ? meta.external_id
      : typeof meta.study_id === "string"
        ? meta.study_id
        : null;
  const study_ids: string[] = [];
  if (typeof meta.nct_id === "string") study_ids.push(meta.nct_id);
  if (Array.isArray(meta.study_ids)) {
    for (const id of meta.study_ids) {
      if (typeof id === "string") study_ids.push(id);
    }
  }
  const provenance = Array.isArray(meta.provenance)
    ? (meta.provenance as ProvenanceLite[])
    : [];
  return {
    id: args.id,
    claim_type: args.claim_type,
    statement: args.statement,
    status: args.status,
    external_id: external,
    study_ids,
    provenance,
  };
}
