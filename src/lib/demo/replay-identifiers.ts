import type { StageId } from "@/modules/kernel/contracts";

/** The property paths whose values are allocated workspace IDs in the stage's prompt contract. */
const requestPaths: Partial<Record<StageId, string[]>> = {
  S2: ["candidates.*.id", "candidates.*.subject", "plan_gaps.*.id"],
  S3: ["source", "rows.*.id", "library.*.id", "candidates.*.id", "candidates.*.source", "batch.*.id", "batch.*.source", "decide.*.id", "decide.*.source"],
  S4: [
    "gaps.*.id", "gaps.*.assigned_tactic_ids.*", "gaps.*.human_rejected_tactic_ids.*",
    "gaps.*.previous.mappings.*.tactic_id", "gaps.*.previous.mappings.*.references.*.entity_id",
    "rows.*.gap.id", "rows.*.gap.assigned_tactic_ids.*", "rows.*.gap.human_rejected_tactic_ids.*",
    "rows.*.mappings.*.tactic_id", "rows.*.mappings.*.references.*.entity_id", "rows.*.last_review.mappings.*.tactic_id",
    "tactics.*.id", "tactics.*.parent_tactic_id", "tactics.*.expansion_id", "supporting_records.*.entity_id", "supporting_records.*.href",
  ],
  S6: [
    "gap.id", "evidence_needs.*.id", "mapped_tactics.*.id", "mapped_tactics.*.parent_tactic_id", "mapped_tactics.*.expansion_id",
    "previous.addressed_tactic_ids.*", "proposal.addressed_tactic_ids.*",
  ],
  S8: ["gaps.*.id", "gaps.*.references.*.entity_id", "gaps.*.references.*.href",
    "placements.*.gap_id", "placements.*.references.*.entity_id", "placements.*.references.*.href", "placements.*.supporting_references.*.entity_id"],
  S9: [
    "library.*.id", "library.*.expansions.*.id", "gaps.*.id", "gaps.*.supporting_records.*.entity_id", "gaps.*.supporting_records.*.href",
    "gaps.*.proposal_slots.*", "gaps.*.revise.*.id", "gaps.*.revise.*.previous.id",
    "gaps.*.revise.*.previous.gap_id", "gaps.*.revise.*.previous.target_tactic_id", "gaps.*.revise.*.previous.references.*.entity_id",
    "gaps.*.candidates.*.id", "gaps.*.candidates.*.gap_id", "gaps.*.candidates.*.target_tactic_id", "gaps.*.candidates.*.references.*.entity_id",
    "tactics.*.id", "tactics.*.gap_id", "tactics.*.target_tactic_id", "tactics.*.references.*.entity_id",
    "tactics.*.gap.id", "tactics.*.gap.supporting_records.*.entity_id", "tactics.*.gap.supporting_records.*.href",
  ],
  S10: ["answer_for.*", "activities.*.id", "activities.*.gap_ids.*", "activities.*.parent_gap_ids.*",
    "activities.*.depends_on.*.id", "other_activities.*.id"],
};

const replyPaths: Partial<Record<StageId, string[]>> = {
  S2: ["gaps.*.id", "critiques.*.subject", "decisions.*.subject", "decisions.*.duplicate_of", "decisions.*.match_gap_id", "decisions.*.same_as_candidate"],
  S3: ["tactics.*.id", "reviews.*.id", "decisions.*.id", "decisions.*.duplicate_of", "decisions.*.target_tactic_id"],
  S4: ["rows.*.gap_id", "rows.*.mappings.*.tactic_id", "rows.*.mappings.*.references.*.entity_id", "reviews.*.gap_id",
    "reviews.*.mappings.*.tactic_id", "verdicts.*.gap_id"],
  S6: ["addressed_tactic_ids.*", "proposal.addressed_tactic_ids.*"],
  S8: ["gaps.*.gap_id", "gaps.*.references.*.entity_id", "reviews.*.gap_id"],
  S9: ["tactics.*.id", "tactics.*.gap_id", "tactics.*.target_tactic_id", "tactics.*.references.*.entity_id",
    "gap_outcomes.*.gap_id", "reviews.*.id", "reviews.*.duplicate_of", "reviews.*.references.*.entity_id", "gaps.*.gap_id",
    "gaps.*.decisions.*.id", "gaps.*.decisions.*.references.*.entity_id", "gaps.*.outcome.gap_id"],
  S10: ["activities.*.id", "activities.*.depends_on.*.id"],
};

type Path = (string | number)[];
type Direction = "request" | "reply";

/** Visit only the exact JSON fields designated as mutable by the stage contract. */
export function mapReplayIds(stage: StageId, direction: Direction, value: unknown, map: (value: string, path: Path) => unknown): unknown {
  const paths = (direction === "request" ? requestPaths : replyPaths)[stage];
  if (!paths) return value;
  const declared = new Set(paths.map(path => JSON.stringify(path.split(".").map(part => part === "*" ? null : part))));
  function walk(current: unknown, path: Path): unknown {
    if (typeof current === "string" && declared.has(JSON.stringify(path.map(p => typeof p === "number" ? null : p)))) return map(current, path);
    if (Array.isArray(current)) return current.map((item, i) => walk(item, [...path, i]));
    if (current && typeof current === "object") return Object.fromEntries(Object.entries(current).map(([key, val]) => [key, walk(val, [...path, key])]));
    return current;
  }
  return walk(value, []);
}

const BASE = String.raw`(?:GAP|NEED|SRC|TAC|COV|RES|OBJ|BLK|EXP|ACT|IDEA|PROP|SUG)-\d{3,}|[A-Za-z]{1,8}_\d{8}T\d{6}_\d{4,5}_[a-z0-9]{4}`;
export const WHOLE_ID = new RegExp(`^(?:${BASE})$`);
const REFERENCE = new RegExp(`^(ACT-EXP-|ACT-|/gaps/|/sources/)?(${BASE})(-L(?:T)?[0-9]+|:proposal:[1-9][0-9]*)?$`);
const EXTRACTION_CANDIDATE = new RegExp(`^(${BASE})(-(L|LT)(?:[0-9]{3,}(-W(?:[2-9]|[1-9][0-9]+))|[0-9]+))?$`);

const extractionCandidatePaths = {
  S2: {
    kind: "L",
    request: ["candidates.*.id", "candidates.*.subject"],
    reply: ["gaps.*.id", "critiques.*.subject", "decisions.*.subject", "decisions.*.same_as_candidate"],
  },
  S3: {
    kind: "LT",
    request: ["rows.*.id", "candidates.*.id", "batch.*.id", "decide.*.id"],
    reply: ["tactics.*.id", "reviews.*.id", "decisions.*.id", "decisions.*.duplicate_of"],
  },
};

type MutableReference = { prefix: string; id: string; suffix: string; candidate?: "first" | "later" };

export function mutableReference(stage: StageId, direction: Direction, value: string, path: Path): MutableReference | null {
  if (stage === "S2" || stage === "S3") {
    const candidate = EXTRACTION_CANDIDATE.exec(value);
    const allowed = extractionCandidatePaths[stage];
    if (candidate && candidate[1]!.startsWith("DOC_") && (direction === "reply" || candidate[3] === allowed.kind) &&
        allowed[direction].includes(path.map(part => typeof part === "number" ? "*" : part).join("."))) {
      return { prefix: "", id: candidate[1]!, suffix: candidate[2] ?? "", candidate: candidate[4] ? "later" : "first" };
    }
  }
  const match = REFERENCE.exec(value);
  if (!match) return null;
  const [, prefix = "", id, suffix = ""] = match;
  if (suffix.startsWith(":proposal:") ? !id!.startsWith("GAP-") : suffix && !/^(?:DOC_|GAP-)/.test(id!)) return null;
  if (prefix === "/gaps/" && (!id!.startsWith("GAP-") || suffix)) return null;
  if (prefix === "/sources/" && (!id!.startsWith("SRC-") || suffix)) return null;
  if (prefix === "ACT-EXP-" && (!/^EXP[-_]/.test(id!) || suffix)) return null;
  return { prefix, id: id!, suffix };
}

/** The loop's purpose suffix is dynamic only for these exact stage/purpose pairs. */
export function purposeReference(stage: StageId, purpose: string): [string, string] | null {
  const allowed = {
    S2: /^(gap-(?:proposer|reviser):)(DOC_.*)$/,
    S3: /^(tactic-proposer(?:-revise|-fix)?:)(DOC_.*)$/,
    S6: /^(split-(?:proposer|critic|judge):)(GAP-.*)$/,
  };
  const match = allowed[stage as keyof typeof allowed]?.exec(purpose);
  return match && WHOLE_ID.test(match[2]!) ? [match[1]!, match[2]!] : null;
}
