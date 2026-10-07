import type { CustomTacticType } from "./custom-tactic-type";
import type {
  ActorFunction,
  CoverageDimension,
  DimensionValue,
  EvidenceDomain,
  ExclusionReason,
  GapStatus,
  MappedGapStatus,
  NeedStatus,
  OverallCoverage,
  PriorityBand,
  SourceType,
  ResidualReviewStatus,
  TacticReviewStatus,
  TacticStatus,
  TacticType,
} from "./enums";

export type Actor = {
  name: string;
  function: ActorFunction;
};

export type Lock = {
  locked: boolean;
  actor_name: string | null;
  actor_function: ActorFunction | null;
  locked_at: string | null;
  note: string | null;
  /** Factual inputs of a human coverage verdict; absent on legacy locks. */
  gap_revision?: string;
  tactic_revision?: string;
};

export type DimensionAssessment = {
  value: DimensionValue;
  rationale: string;
  lock: Lock;
};

export type Asset = {
  id: string;
  name: string;
  inn: string;
  indication: string;
  geography: string;
  wizard_complete: boolean;
  tactics_unlocked: boolean;
  /** Product setup wizard (asset questionnaire + journey) finished. */
  setup_complete: boolean;
  planning_context: unknown;
};

export type StrategicObjective = {
  id: string;
  name: string;
  description: string;
  lifecycle_stage: string;
  indication: string;
  geography: string;
  strategic_importance: number;
  key_decision: string;
  decision_date: string;
  owner: string;
};

export type SourceDocument = {
  id: string;
  filename: string;
  title: string;
  source_type: SourceType;
  stakeholder_function: ActorFunction;
  ingested_at: string;
  full_text: string;
};

export type SourceBlock = {
  id: string;
  source_id: string;
  heading: string;
  text: string;
  location: string;
};

export type EvidenceNeed = {
  id: string;
  statement: string;
  domain: EvidenceDomain;
  stakeholder: ActorFunction;
  objective_id: string;
  decision_supported: string;
  geography: string;
  population: string;
  intervention: string;
  comparator: string;
  outcome: string;
  timing: string;
  source_id: string;
  source_quote: string;
  /** Null until a model or a human scores it. */
  confidence: number | null;
  status: NeedStatus;
  status_lock: Lock;
};

export type GapStatusOverride = {
  status: MappedGapStatus;
  from: GapStatus;
  to: MappedGapStatus;
  reason: string;
  actor_name: string;
  actor_function: ActorFunction;
  at: string;
  stale: boolean;
};

export type EvidenceGap = {
  id: string;
  name: string;
  statement: string;
  domain: EvidenceDomain;
  objective_id: string;
  status: GapStatus;
  exclusion_reason: ExclusionReason | null;
  exclusion_note: string | null;
  status_lock: Lock;
  parent_gap_id: string | null;
  /** Engine-computed Open / Partial / Addressed. Null for candidate or excluded. */
  computed_status: MappedGapStatus | null;
  /** Human override. Wins until cleared or marked stale on ingest/coverage refresh. */
  status_override: GapStatusOverride | null;
  retired: boolean;
  human_validated: boolean;
  /** Set aside by a human as not a real gap. Excludes from Prioritize and Tactics until unparked. */
  parked_at: string | null;
  parked_reason: string | null;
  /**
   * Treatment settings the gap belongs to (e.g. "1L", "Perioperative"). Free
   * tags a human adds; a gap can carry several. Prioritize scopes on them.
   */
  settings: string[];
  /** The design's gap metadata (KAN-49): who it affects, where, and notes. Written by a person. */
  metadata: GapMetadata;
  /** The gap's number as people read it (001, 002…); the id stays the key (KAN-56). */
  number: number;
  /**
   * Set when a new source joined the gap after a person had validated it or its
   * priority (KAN-74); cleared when a person marks it reviewed.
   */
  new_source_at?: string | null;
  /** The need that joined, for the "New source added" note. */
  new_source_need_id?: string | null;
  /** Gaps split from a shared question (KAN-75): each side lists the other. */
  related_gap_ids?: string[];
};

export type GapSuggestionStatus = "pending" | "merged" | "split" | "rejected";

/** A source sentence waiting on a suggestion: it follows the suggestion's outcome. */
export type GapSuggestionSource = { source_id: string; statement: string; source_quote: string };

/**
 * A candidate gap the S2 judge found to overlap an existing gap (KAN-74): part of
 * its question is the gap's, part is new. Nothing changes until a person accepts
 * the merged wording, accepts the split, or rejects it (KAN-75).
 */
export type GapSuggestion = {
  id: string;
  gap_id: string;
  run_id: string;
  /** The S2 candidate row (gap_candidates), so a rejected one can be promoted later. */
  candidate_row_id: string | null;
  source_id: string;
  name: string;
  statement: string;
  domain: EvidenceDomain;
  source_quote: string;
  shared_part: string;
  new_part: string;
  merged_name: string;
  merged_statement: string;
  split_name: string;
  split_statement: string;
  /** Repeats of the same candidate from other sources in the same run. */
  extra_sources: GapSuggestionSource[];
  status: GapSuggestionStatus;
  /** The gap a split created. */
  result_gap_id: string | null;
  decided_by: string | null;
  rationale: string | null;
  created_at: string;
  decided_at: string | null;
};

export type GapMetadata = {
  /** Impacted stakeholders as tags: payers, HTA bodies, KOLs, patients… */
  stakeholders: string[];
  geography: string;
  /** How the gap differs by country or region. */
  regional_nuances: string;
  notes: string;
};

export type GapVersionEvent = "split" | "rewrite";

export type GapVersion = {
  id: string;
  live_gap_id: string;
  retired_gap_id: string;
  name: string;
  statement: string;
  status: GapStatus;
  domain: EvidenceDomain;
  event: GapVersionEvent;
  at: string;
  actor_name: string;
  actor_function: ActorFunction;
};

export type NeedGapLink = {
  need_id: string;
  gap_id: string;
  role: "primary" | "supporting";
};

/**
 * A workshop-day organizational grouping of gaps (e.g. one per breakout theme).
 * Not a locked evidence object — deleting one only ungroups its gaps, so there
 * is no version history or audit ceremony around it beyond a plain audit line.
 */
export type BreakoutGroup = {
  id: string;
  name: string;
  note: string | null;
  created_at: string;
  actor_name: string;
  actor_function: ActorFunction;
};

export type BreakoutGroupGap = {
  group_id: string;
  gap_id: string;
};

export type Tactic = {
  id: string;
  name: string;
  type: TacticType;
  description: string;
  evidence_question: string;
  population: string;
  intervention: string;
  comparator: string;
  outcomes: string;
  geography: string;
  data_source: string;
  study_design: string;
  lifecycle_stage: string;
  status: TacticStatus;
  review_status: TacticReviewStatus;
  start_date: string | null;
  evidence_available: string | null;
  owner: string;
  function: ActorFunction;
  budget: string | null;
  intended_use: string;
  lock: Lock;
  /** The source sentence S3 extracted this tactic from. Empty for hand-created tactics. */
  source_quote?: string;
  /** A person's own type name and colour, shown over the standard type (KAN-51). */
  custom_type?: CustomTacticType | null;
};

export type GapTacticCoverage = {
  id: string;
  gap_id: string;
  tactic_id: string;
  dimensions: Record<CoverageDimension, DimensionAssessment>;
  overall: OverallCoverage;
  overall_rationale: string;
  overall_lock: Lock;
  /** Effective read-only freshness from the existing coverage lock and factual inputs. */
  validation_freshness?: "current" | "stale" | "unknown" | "unassessed";
  /** A factual edit invalidates the prior human coverage decision. */
  stale: boolean;
  /** Sibling coverage flagged after a dimension/overall change on another live gap for the same tactic. Values are not copied. */
  needs_review: boolean;
};

export type ResidualNeed = {
  id: string;
  gap_id: string;
  statement: string;
  domain: EvidenceDomain;
  draft_rationale: string;
  review_status: ResidualReviewStatus;
  created_gap_id: string | null;
  lock: Lock;
};

export type PriorityAssessment = {
  id: string;
  residual_id: string;
  suggested_score: number;
  suggested_band: PriorityBand;
  band: PriorityBand;
  override_reason: string | null;
  reasons: string[];
  lock: Lock;
};

export type RoadmapItem = {
  id: string;
  tactic_id: string;
  residual_ids: string[];
  start_date: string | null;
  evidence_available: string | null;
  owner: string;
  note: string | null;
  lock: Lock;
};

export type AuditEvent = {
  id: string;
  at: string;
  actor_name: string;
  actor_function: ActorFunction;
  entity_type: string;
  entity_id: string;
  action: string;
  detail: string;
};

export type GoldNeed = {
  id: string;
  statement: string;
  source_id: string;
  must_find: boolean;
};

export type GoldCoverage = {
  id: string;
  gap_id: string;
  tactic_id: string;
  overall: OverallCoverage;
};

export type MappingSuggestionRecord = {
  gap_id: string;
  tactic_id: string;
  status: "accepted" | "rejected";
  lock: Lock;
};

export type ResidualGapSuggestionRecord = {
  parent_gap_id: string;
  statement: string;
  reasons: string[];
  status: "candidate" | "accepted" | "rejected";
  lock: Lock;
};

export type IegpState = {
  asset: Asset;
  objectives: StrategicObjective[];
  sources: SourceDocument[];
  blocks: SourceBlock[];
  needs: EvidenceNeed[];
  gaps: EvidenceGap[];
  need_gap_links: NeedGapLink[];
  tactics: Tactic[];
  coverages: GapTacticCoverage[];
  mapping_suggestions: MappingSuggestionRecord[];
  residual_gap_suggestions: ResidualGapSuggestionRecord[];
  residuals: ResidualNeed[];
  priorities: PriorityAssessment[];
  roadmap: RoadmapItem[];
  audit: AuditEvent[];
  gold_needs: GoldNeed[];
  gold_coverages: GoldCoverage[];
  gap_versions: GapVersion[];
  breakout_groups: BreakoutGroup[];
  breakout_group_gaps: BreakoutGroupGap[];
  gap_suggestions: GapSuggestion[];
};
