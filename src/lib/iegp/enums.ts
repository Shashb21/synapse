export const ACTOR_FUNCTIONS = [
  "clinical_development",
  "medical_affairs",
  "heor",
  "rwe",
  "epidemiology",
  "market_access",
  "regulatory",
  "commercial",
  "patient_engagement",
  "regional",
  "hta",
  "evidence_lead",
] as const;
export type ActorFunction = (typeof ACTOR_FUNCTIONS)[number];

export const FUNCTION_LABELS: Record<ActorFunction, string> = {
  clinical_development: "Clinical development",
  medical_affairs: "Medical affairs",
  heor: "HEOR",
  rwe: "RWE",
  epidemiology: "Epidemiology",
  market_access: "Market access",
  regulatory: "Regulatory",
  commercial: "Commercial",
  patient_engagement: "Patient engagement",
  regional: "Regional / affiliate",
  hta: "HTA",
  evidence_lead: "Evidence lead",
};

export const EVIDENCE_DOMAINS = [
  "efficacy",
  "safety",
  "comparative_effectiveness",
  "disease_burden",
  "epidemiology",
  "natural_history",
  "treatment_patterns",
  "unmet_need",
  "patient_experience",
  "qol_pro",
  "caregiver_burden",
  "hcru",
  "economics",
  "cost_effectiveness",
  "budget_impact",
  "treatment_sequencing",
  "implementation",
  "diagnostic_pathway",
  "biomarkers",
  "adherence",
  "long_term_outcomes",
  "subpopulations",
  "health_system_impact",
] as const;
export type EvidenceDomain = (typeof EVIDENCE_DOMAINS)[number];

export function domainLabel(domain: string): string {
  if ((EVIDENCE_DOMAINS as readonly string[]).includes(domain)) {
    return DOMAIN_LABELS[domain as EvidenceDomain];
  }
  return domain.replaceAll("_", " ");
}

export const DOMAIN_LABELS: Record<EvidenceDomain, string> = {
  efficacy: "Efficacy",
  safety: "Safety",
  comparative_effectiveness: "Comparative effectiveness",
  disease_burden: "Disease burden",
  epidemiology: "Epidemiology",
  natural_history: "Natural history",
  treatment_patterns: "Treatment patterns",
  unmet_need: "Unmet need",
  patient_experience: "Patient experience",
  qol_pro: "QoL / PRO",
  caregiver_burden: "Caregiver burden",
  hcru: "HCRU",
  economics: "Economics",
  cost_effectiveness: "Cost effectiveness",
  budget_impact: "Budget impact",
  treatment_sequencing: "Treatment sequencing",
  implementation: "Implementation",
  diagnostic_pathway: "Diagnostic pathway",
  biomarkers: "Biomarkers / precision medicine",
  adherence: "Adherence / persistence",
  long_term_outcomes: "Long-term outcomes",
  subpopulations: "Subpopulations",
  health_system_impact: "Health-system impact",
};

export const SOURCE_TYPES = [
  "stakeholder_interview",
  "targeted_literature_review",
  "clinical_development_plan",
  "protocol",
  "csr",
  "medical_strategy",
  "advisory_board",
  "heor_strategy",
  "value_dossier",
  "economic_model",
  "rwe_strategy",
  "publication_plan",
  "brand_strategy",
  "tpp",
  "competitor_landscape",
  "country_evidence_plan",
  "hta_requirement",
  "other_internal",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  stakeholder_interview: "Stakeholder interview",
  targeted_literature_review: "Targeted literature review",
  clinical_development_plan: "Clinical development plan",
  protocol: "Protocol",
  csr: "Clinical study report",
  medical_strategy: "Medical strategy",
  advisory_board: "Advisory board",
  heor_strategy: "HEOR / value evidence strategy",
  value_dossier: "Global value dossier",
  economic_model: "Economic model",
  rwe_strategy: "RWE / epidemiology strategy",
  publication_plan: "Publication plan",
  brand_strategy: "Brand strategy",
  tpp: "Target product profile",
  competitor_landscape: "Competitor landscape",
  country_evidence_plan: "Country evidence plan",
  hta_requirement: "HTA requirement",
  other_internal: "Internal material",
};

export const NEED_STATUSES = [
  "candidate",
  "accepted",
  "rejected",
] as const;
export type NeedStatus = (typeof NEED_STATUSES)[number];

export const GAP_STATUSES = [
  "candidate",
  "validated_open",
  "validated_partial",
  "validated_addressed",
  "excluded",
] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export const GAP_STATUS_LABELS: Record<GapStatus, string> = {
  candidate: "Candidate",
  validated_open: "Open",
  validated_partial: "Partially Addressed",
  validated_addressed: "Addressed",
  excluded: "Excluded / not a gap",
};

/** Human-facing explanations for mapped gap states. */
export const GAP_STATUS_DEFINITIONS: Record<GapStatus, string> = {
  candidate: "Extracted or created; not yet validated.",
  validated_open:
    "Complete white space: no completed, ongoing, or planned tactics AND no published literature addressing this gap. Proposed tactics do not count as addressing.",
  validated_partial:
    "Some evidence, through completed or ongoing or planned tactics and/or published literature, that supports but does not fully close this gap. The remainder is a residual evidence need. This status cannot stay: split into an Addressed gap (with its tactic) and an Open leftover, or rewrite the original as Open or Addressed.",
  validated_addressed:
    "Evidence from published literature and/or completed, ongoing, or planned tactics is sufficient to fully close this gap.",
  excluded: "Not an evidence gap.",
};

export const MAPPED_GAP_STATUSES = [
  "validated_open",
  "validated_partial",
  "validated_addressed",
] as const;
export type MappedGapStatus = (typeof MAPPED_GAP_STATUSES)[number];

export const TACTIC_TYPES = [
  "phase3_trial",
  "rwe_study",
  "registry",
  "chart_review",
  "hcru_study",
  "slr",
  "nma",
  "itc",
  "maic",
  "pro_study",
  "patient_survey",
  "cea",
  "budget_impact_model",
  "iis",
  "academic_collaboration",
  "secondary_analysis",
  "subgroup_analysis",
  "long_term_followup",
  "publication",
  "congress_abstract",
  "evidence_dissemination",
  "natural_history_study",
] as const;
export type TacticType = (typeof TACTIC_TYPES)[number];

export const TACTIC_TYPE_LABELS: Record<TacticType, string> = {
  phase3_trial: "Phase III trial",
  rwe_study: "RWE study",
  registry: "Registry",
  chart_review: "Retrospective chart review",
  hcru_study: "HCRU study",
  slr: "Systematic literature review",
  nma: "Network meta-analysis",
  itc: "Indirect treatment comparison",
  maic: "MAIC",
  pro_study: "PRO study",
  patient_survey: "Patient / caregiver survey",
  cea: "Cost-effectiveness analysis",
  budget_impact_model: "Budget-impact model",
  iis: "Investigator-initiated study",
  academic_collaboration: "Academic collaboration",
  secondary_analysis: "Secondary analysis",
  subgroup_analysis: "Subgroup analysis",
  long_term_followup: "Long-term follow-up",
  publication: "Publication",
  congress_abstract: "Congress abstract / manuscript",
  evidence_dissemination: "Evidence dissemination",
  natural_history_study: "Natural-history study",
};

export const TACTIC_STATUSES = [
  "completed",
  "ongoing",
  "planned",
  "proposed",
  "cancelled",
] as const;
export type TacticStatus = (typeof TACTIC_STATUSES)[number];

export const TACTIC_STATUS_HELPERS: Record<TacticStatus, string> = {
  completed: "The study, programme, or publication is finished. Can count toward addressing a gap.",
  ongoing: "Work is in progress. Can count toward addressing a gap.",
  planned: "Committed or planned work. Can count toward addressing a gap.",
  proposed: "An idea only. Does not count toward addressing. Created on Tactics after Prioritize.",
  cancelled: "Stopped. Does not count toward addressing.",
};

/** Real inventory statuses Gaps may record. Proposed ideation is Tactics-only. */
export const CATCH_UP_TACTIC_STATUSES = ["completed", "ongoing", "planned"] as const;
export type CatchUpTacticStatus = (typeof CATCH_UP_TACTIC_STATUSES)[number];

export const CATCH_UP_REASONS = [
  "missed_at_ingest",
  "source_not_uploaded",
  "remembered_while_reviewing",
] as const;
export type CatchUpReason = (typeof CATCH_UP_REASONS)[number];

export const CATCH_UP_REASON_LABELS: Record<CatchUpReason, string> = {
  missed_at_ingest: "Missed at ingest",
  source_not_uploaded: "Source not uploaded",
  remembered_while_reviewing: "Remembered while reviewing this gap",
};

export const TACTIC_REVIEW_STATUSES = [
  "candidate",
  "accepted",
  "rejected",
] as const;
export type TacticReviewStatus = (typeof TACTIC_REVIEW_STATUSES)[number];

export const TACTIC_REVIEW_LABELS: Record<TacticReviewStatus, string> = {
  candidate: "Candidate",
  accepted: "Accepted",
  rejected: "Rejected",
};

export const RESIDUAL_REVIEW_STATUSES = TACTIC_REVIEW_STATUSES;
export type ResidualReviewStatus = (typeof RESIDUAL_REVIEW_STATUSES)[number];

export const RESIDUAL_REVIEW_LABELS: Record<ResidualReviewStatus, string> = {
  candidate: "Residual draft",
  accepted: "Accepted as gap",
  rejected: "Rejected",
};

export const COVERAGE_DIMENSIONS = [
  "relevance",
  "population",
  "intervention",
  "comparator",
  "outcomes",
  "geography",
  "setting",
  "timing",
  "methodology",
  "decision_utility",
] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<CoverageDimension, string> = {
  relevance: "Relevance",
  population: "Population",
  intervention: "Intervention",
  comparator: "Comparator",
  outcomes: "Outcomes",
  geography: "Geography",
  setting: "Setting",
  timing: "Timing",
  methodology: "Methodology",
  decision_utility: "Decision utility",
};

export const DIMENSION_QUESTIONS: Record<CoverageDimension, string> = {
  relevance: "Does the tactic address the same evidence question?",
  population: "Does it include the relevant population?",
  intervention: "Does it cover the relevant treatment or context?",
  comparator: "Does it use the relevant comparator?",
  outcomes: "Does it measure the required endpoints?",
  geography: "Does it answer the relevant country or market question?",
  setting: "Does it reflect the relevant care setting?",
  timing: "Will evidence be available when the decision needs it?",
  methodology: "Is the method sufficiently rigorous?",
  decision_utility: "Will the evidence actually inform the decision?",
};

export const DIMENSION_VALUES = ["yes", "partial", "no", "unknown"] as const;
export type DimensionValue = (typeof DIMENSION_VALUES)[number];

export const OVERALL_COVERAGE = [
  "full",
  "partial",
  "limited",
  "not_relevant",
] as const;
export type OverallCoverage = (typeof OVERALL_COVERAGE)[number];

/** How much this tactic covers this gap — not tactic lifecycle (ongoing/planned). */
export const OVERALL_COVERAGE_LABELS: Record<OverallCoverage, string> = {
  full: "Full coverage",
  partial: "Partial coverage",
  limited: "Limited coverage",
  not_relevant: "Not relevant",
};

export const OVERALL_COVERAGE_HELPERS: Record<OverallCoverage, string> = {
  full: "This tactic fully covers this gap.",
  partial: "This tactic covers some of this gap, but not all.",
  limited:
    "This tactic only limitedly covers this gap — for example the population or endpoints are too thin. Separate from whether the tactic is ongoing or planned.",
  not_relevant: "This tactic does not apply to this gap.",
};

export const PRIORITY_BANDS = ["critical", "high", "medium", "low"] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export const PRIORITY_BAND_HELPERS: Record<PriorityBand, string> = {
  critical: "Highest urgency among Open gaps. The plan folds Critical into High on the board.",
  high: "High-priority Open gap — address first.",
  medium: "Medium-priority Open gap.",
  low: "Lower-priority Open gap.",
};

export const EXCLUSION_REASONS = [
  "sufficient_evidence",
  "not_decision_relevant",
  "duplicative",
  "outside_scope",
  "communication_issue",
  "too_speculative",
  "not_defined",
  "captured_elsewhere",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  sufficient_evidence: "Sufficient evidence already exists",
  not_decision_relevant: "Not decision-relevant",
  duplicative: "Duplicative of another need",
  outside_scope: "Outside IEGP scope",
  communication_issue: "Communication / dissemination issue, not an evidence gap",
  too_speculative: "Too speculative",
  not_defined: "Not sufficiently defined",
  captured_elsewhere: "Another evidence need captures it better",
};
