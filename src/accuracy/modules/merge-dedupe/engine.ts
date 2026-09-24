/**
 * Merge / dedupe of inventory + need candidates.
 *
 * Mechanical keys only settle what is identical: a shared study / protocol /
 * registry ID, or the same statement text. Whether two differently worded
 * candidates citing the same block are the same item is a judgement: those
 * pairs go to the LLM equivalence judge (judge.ts) and come back here as
 * `equivalent` pairs. There is no similarity threshold.
 * Gold packs never mix (beone-bgb-58067-prmt5i vs beone-tislelizumab-iegp).
 * Conflicting tactic lifecycles are surfaced, not auto-picked.
 */

export type MergeClaimType = "gap" | "tactic";

export type MergeProvenance = {
  source_file_id: string;
  block_id: string;
  quote: string;
};

export type TacticLifecycle = "completed" | "ongoing" | "planned" | "proposed" | "cancelled";

export type MergeCandidate = {
  id: string;
  claim_type: MergeClaimType;
  statement: string;
  validated: boolean;
  /** Ledger status (draft / validated / rejected / merged) or tactic lifecycle. */
  status: string;
  source_file_id: string | null;
  reference_pack_id: string | null;
  external_id: string | null;
  tactic_status?: TacticLifecycle | null;
  provenance: MergeProvenance[];
  created_at?: string | null;
};

export type MergeReason = "identity" | "statement" | "model_equivalence" | "transitive";

export type MergeRecord = {
  survivor_id: string;
  duplicate_id: string;
  /** `transitive`: joined to the survivor only through other members of its cluster. */
  reason: MergeReason;
  keys: string[];
  /** The judge's rationale for a `model_equivalence` merge. */
  rationale?: string | null;
};

/** A same-block pair the mechanical keys could not settle. */
export type EquivalenceQuestion = {
  a_id: string;
  b_id: string;
  claim_type: MergeClaimType;
  shared_block_ids: string[];
};

/** The judge's answer that two candidates are the same item. */
export type EquivalentPair = { a_id: string; b_id: string; rationale: string };

export type MergeContradiction = {
  keep_id: string;
  other_id: string;
  claim_type: MergeClaimType;
  field: "status";
  values: [string, string];
  reason: string;
};

export type MergeDedupeResult = {
  survivors: MergeCandidate[];
  merges: MergeRecord[];
  contradictions: MergeContradiction[];
  /** duplicate claim id → surviving claim id (cluster root). */
  absorbed: Record<string, string>;
};

const TACTIC_LIFECYCLES = new Set<TacticLifecycle>([
  "completed",
  "ongoing",
  "planned",
  "proposed",
  "cancelled",
]);

const ID_PATTERNS: RegExp[] = [
  /\bNCT\d{8}\b/gi,
  /\bG:\d+\b/gi,
  /\b[A-Z]{2,}_[A-Z]{2}_\d{2}\b/g,
  /\bBGB[-\s]?\d{4,}\b/gi,
  /\bRATIONALE[-\s]?\d+\b/gi,
];

export function asTacticLifecycle(value: unknown): TacticLifecycle | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return TACTIC_LIFECYCLES.has(trimmed as TacticLifecycle)
    ? (trimmed as TacticLifecycle)
    : null;
}

export function normalizeMergeKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9:-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractDeterministicIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const pattern of ID_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const key = normalizeMergeKey(match[0]);
      if (key) found.add(key);
    }
  }
  return [...found];
}

function isStrongIdentity(key: string): boolean {
  if (!key) return false;
  if (/^nct\d{8}$/.test(key)) return true;
  if (/^g:\d+$/.test(key)) return true;
  if (/^[a-z]{2,}-[a-z]{2}-\d{2}$/.test(key)) return true;
  if (/^bgb-?\d{4,}$/.test(key)) return true;
  if (/^rationale-?\d+$/.test(key)) return true;
  return key.length >= 4 && /[a-z]/.test(key) && /\d/.test(key);
}

/** Pack-scoped identity keys. Different reference_pack_id values never share a key. */
export function identityKeys(candidate: MergeCandidate): string[] {
  const keys = new Set<string>();
  const ext = normalizeMergeKey(candidate.external_id);
  if (ext && isStrongIdentity(ext)) keys.add(ext);
  for (const extracted of extractDeterministicIds(candidate.external_id)) {
    if (isStrongIdentity(extracted)) keys.add(extracted);
  }
  for (const extracted of extractDeterministicIds(candidate.statement)) {
    if (isStrongIdentity(extracted)) keys.add(extracted);
  }
  return [...keys];
}

export function packsMayMerge(a: MergeCandidate, b: MergeCandidate): boolean {
  const pa = a.reference_pack_id?.trim() || "";
  const pb = b.reference_pack_id?.trim() || "";
  if (pa && pb && pa !== pb) return false;
  return true;
}

export function normalizeStatement(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sharedBlockIds(a: MergeCandidate, b: MergeCandidate): string[] {
  const left = new Set(a.provenance.map((p) => p.block_id).filter(Boolean));
  const shared = new Set<string>();
  for (const span of b.provenance) {
    if (span.block_id && left.has(span.block_id)) shared.add(span.block_id);
  }
  return [...shared];
}

function tacticLifecycleOf(candidate: MergeCandidate): TacticLifecycle | null {
  return asTacticLifecycle(candidate.tactic_status) ?? asTacticLifecycle(candidate.status);
}

export function tacticStatusesConflict(a: MergeCandidate, b: MergeCandidate): boolean {
  if (a.claim_type !== "tactic" || b.claim_type !== "tactic") return false;
  const sa = tacticLifecycleOf(a);
  const sb = tacticLifecycleOf(b);
  if (!sa || !sb) return false;
  return sa !== sb;
}

function preferSurvivor(a: MergeCandidate, b: MergeCandidate): MergeCandidate {
  if (a.validated !== b.validated) return a.validated ? a : b;
  const aCreated = a.created_at ?? "";
  const bCreated = b.created_at ?? "";
  if (aCreated && bCreated && aCreated !== bCreated) {
    return aCreated <= bCreated ? a : b;
  }
  const aProv = a.provenance.length;
  const bProv = b.provenance.length;
  if (aProv !== bProv) return aProv >= bProv ? a : b;
  return a.id <= b.id ? a : b;
}

function unionProvenance(a: MergeProvenance[], b: MergeProvenance[]): MergeProvenance[] {
  const seen = new Set<string>();
  const out: MergeProvenance[] = [];
  for (const span of [...a, ...b]) {
    const key = `${span.source_file_id}::${span.block_id}::${span.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(span);
  }
  return out;
}

function mergeInto(survivor: MergeCandidate, duplicate: MergeCandidate): MergeCandidate {
  const ext = survivor.external_id?.trim() || duplicate.external_id;
  const pack = survivor.reference_pack_id || duplicate.reference_pack_id;
  const tactic_status = tacticLifecycleOf(survivor) ?? tacticLifecycleOf(duplicate);
  return {
    ...survivor,
    external_id: ext ?? null,
    reference_pack_id: pack,
    tactic_status,
    provenance: unionProvenance(survivor.provenance, duplicate.provenance),
    validated: survivor.validated || duplicate.validated,
  };
}

type PairMatch = { reason: MergeReason; keys: string[]; rationale?: string | null };

function comparable(a: MergeCandidate, b: MergeCandidate): boolean {
  return a.claim_type === b.claim_type && a.id !== b.id && packsMayMerge(a, b);
}

/** Identity facts only: a shared strong ID or the same statement text. */
function mechanicalMatch(a: MergeCandidate, b: MergeCandidate): PairMatch | null {
  if (!comparable(a, b)) return null;

  const aIds = identityKeys(a);
  const bIds = new Set(identityKeys(b));
  const sharedIds = aIds.filter((k) => bIds.has(k));
  if (sharedIds.length > 0) {
    return { reason: "identity", keys: sharedIds };
  }

  const sa = normalizeStatement(a.statement);
  const sb = normalizeStatement(b.statement);
  if (sa && sa === sb) {
    return { reason: "statement", keys: [sa] };
  }
  return null;
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Same-type, same-pack candidate pairs that cite a common parse block but share
 * no identity key. Citing the same block makes them worth asking about; it
 * decides nothing — the LLM judge says whether they are the same item.
 */
export function equivalenceQuestions(candidates: MergeCandidate[]): EquivalenceQuestion[] {
  const out: EquivalenceQuestion[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (!comparable(a, b) || mechanicalMatch(a, b)) continue;
      const shared = sharedBlockIds(a, b);
      if (shared.length === 0) continue;
      out.push({ a_id: a.id, b_id: b.id, claim_type: a.claim_type, shared_block_ids: shared });
    }
  }
  return out;
}

class UnionFind {
  private parent = new Map<string, string>();

  constructor(ids: string[]) {
    for (const id of ids) this.parent.set(id, id);
  }

  find(id: string): string {
    let cur = this.parent.get(id) ?? id;
    while (cur !== (this.parent.get(cur) ?? cur)) {
      const next = this.parent.get(cur) ?? cur;
      this.parent.set(cur, this.parent.get(next) ?? next);
      cur = next;
    }
    return cur;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const keep = ra <= rb ? ra : rb;
    const drop = keep === ra ? rb : ra;
    this.parent.set(drop, keep);
  }
}

/**
 * Merge candidates of the same claim type. Does not mutate inputs.
 * Gold packs with different `reference_pack_id` never collapse together.
 */
export function mergeDedupeCandidates(
  candidates: MergeCandidate[],
  options: { equivalent?: EquivalentPair[] } = {},
): MergeDedupeResult {
  const judged = new Map<string, PairMatch>();
  for (const pair of options.equivalent ?? []) {
    judged.set(pairKey(pair.a_id, pair.b_id), {
      reason: "model_equivalence",
      keys: [],
      rationale: pair.rationale,
    });
  }
  const pairMatch = (a: MergeCandidate, b: MergeCandidate): PairMatch | null => {
    const mechanical = mechanicalMatch(a, b);
    if (mechanical) return mechanical;
    if (!comparable(a, b)) return null;
    const verdict = judged.get(pairKey(a.id, b.id));
    return verdict ? { ...verdict, keys: sharedBlockIds(a, b) } : null;
  };
  const merges: MergeRecord[] = [];
  const contradictions: MergeContradiction[] = [];
  const absorbed: Record<string, string> = {};
  const byId = new Map(candidates.map((c) => [c.id, { ...c, provenance: [...c.provenance] }]));
  const types: MergeClaimType[] = ["gap", "tactic"];

  for (const claim_type of types) {
    const group = candidates.filter((c) => c.claim_type === claim_type);
    if (group.length < 2) continue;
    const uf = new UnionFind(group.map((c) => c.id));

    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        const match = pairMatch(a, b);
        if (!match) continue;
        if (tacticStatusesConflict(a, b)) {
          const keep = preferSurvivor(a, b);
          const other = keep.id === a.id ? b : a;
          contradictions.push({
            keep_id: keep.id,
            other_id: other.id,
            claim_type,
            field: "status",
            values: [tacticLifecycleOf(keep) ?? keep.status, tacticLifecycleOf(other) ?? other.status],
            reason: "conflicting_tactic_status",
          });
          continue;
        }
        uf.union(a.id, b.id);
      }
    }

    const clusters = new Map<string, string[]>();
    for (const row of group) {
      const root = uf.find(row.id);
      const list = clusters.get(root) ?? [];
      list.push(row.id);
      clusters.set(root, list);
    }

    for (const ids of clusters.values()) {
      if (ids.length < 2) continue;
      const members = ids.map((id) => byId.get(id)!);
      let survivor = members[0]!;
      for (const next of members.slice(1)) {
        survivor = preferSurvivor(survivor, next);
      }
      let folded = { ...survivor };
      for (const member of members) {
        if (member.id === survivor.id) continue;
        folded = mergeInto(folded, member);
        absorbed[member.id] = survivor.id;
        const already = merges.some(
          (m) => m.survivor_id === survivor.id && m.duplicate_id === member.id,
        );
        if (!already) {
          const match = pairMatch(survivor, member);
          merges.push({
            survivor_id: survivor.id,
            duplicate_id: member.id,
            reason: match?.reason ?? "transitive",
            keys: match?.keys ?? [],
            rationale: match?.rationale ?? null,
          });
        }
      }
      byId.set(survivor.id, folded);
    }
  }

  const mergedAway = new Set(Object.keys(absorbed));
  const survivors = [...byId.values()].filter((c) => !mergedAway.has(c.id));

  return { survivors, merges, contradictions, absorbed };
}
