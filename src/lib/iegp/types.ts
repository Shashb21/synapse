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
  confidence: number;
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
};

export type GapTacticCoverage = {
  id: string;
  gap_id: string;
  tactic_id: string;
  dimensions: Record<CoverageDimension, DimensionAssessment>;
  overall: OverallCoverage;
  overall_rationale: string;
  overall_lock: Lock;
  /**
   * This gap–tactic coverage judgment may be out of date because the tactic’s
   * status changed or new evidence was ingested. Dimension values are not
   * automatically trusted until a human reviews them. Distinct from
   * `needs_review` (a sibling gap mapped to the same tactic changed a dimension).
   */
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
};
