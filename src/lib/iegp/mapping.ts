import { statementSimilarity } from "@/lib/text";
import {
  DOMAIN_LABELS,
  TACTIC_TYPE_LABELS,
  type EvidenceDomain,
  type TacticType,
} from "./enums";
import type { EvidenceGap, EvidenceNeed, Tactic } from "./types";

export const MAPPING_SUGGESTION_CAP = 12;
/** 0–100. Pairs below this are inventory noise, not a draft join. */
export const MAPPING_SCORE_FLOOR = 34;

export const DISSEMINATION_TACTIC_TYPES: readonly TacticType[] = [
  "publication",
  "congress_abstract",
  "evidence_dissemination",
];

const DOMAIN_TYPE_AFFINITY: Record<EvidenceDomain, readonly TacticType[]> = {
  comparative_effectiveness: [
    "chart_review",
    "rwe_study",
    "nma",
    "itc",
    "maic",
    "slr",
    "phase3_trial",
    "subgroup_analysis",
    "secondary_analysis",
    "registry",
  ],
  treatment_sequencing: ["registry", "rwe_study", "chart_review"],
  treatment_patterns: ["registry", "rwe_study", "chart_review"],
  hcru: ["hcru_study", "registry", "rwe_study", "chart_review"],
  qol_pro: ["pro_study", "patient_survey", "registry", "rwe_study"],
  caregiver_burden: ["patient_survey", "pro_study"],
  patient_experience: ["patient_survey", "pro_study"],
  budget_impact: ["budget_impact_model", "cea"],
  cost_effectiveness: ["cea", "nma", "itc", "maic"],
  economics: ["cea", "hcru_study", "budget_impact_model", "rwe_study"],
  adherence: ["rwe_study", "chart_review", "registry"],
  long_term_outcomes: ["long_term_followup", "registry", "phase3_trial", "rwe_study"],
  efficacy: ["phase3_trial", "rwe_study", "subgroup_analysis", "long_term_followup"],
  safety: ["rwe_study", "registry", "chart_review", "phase3_trial"],
  subpopulations: ["subgroup_analysis", "chart_review", "rwe_study"],
  epidemiology: ["natural_history_study", "registry", "rwe_study"],
  natural_history: ["natural_history_study", "registry"],
  disease_burden: ["natural_history_study", "hcru_study", "rwe_study"],
  unmet_need: ["rwe_study", "patient_survey", "slr"],
  implementation: ["evidence_dissemination", "publication", "congress_abstract"],
  health_system_impact: ["hcru_study", "budget_impact_model"],
  biomarkers: ["phase3_trial", "rwe_study", "subgroup_analysis"],
  diagnostic_pathway: ["rwe_study", "registry"],
};

type CueFamily = {
  id: string;
  label: string;
  test: (text: string) => boolean;
};

const CUE_FAMILIES: CueFamily[] = [
  {
    id: "elderly",
    label: "elderly / ≥65 population",
    test: (t) => /\belderly\b|\baged\b.{0,16}65|≥\s*65|>=\s*65|\b65\s*\+|\bfrail\b/i.test(t),
  },
  {
    id: "cns",
    label: "CNS / intracranial",
    test: (t) => /\bcns\b|\bintracranial\b|\bbrain metastas/i.test(t),
  },
  {
    id: "hcru",
    label: "HCRU / hospitalisation",
    test: (t) =>
      /\bhcru\b|\bhospitalisation|\bhospitalization|\bed use\b|\bemergency-department|\boutpatient\b/i.test(
        t,
      ),
  },
  {
    id: "qol",
    label: "QoL / PRO",
    test: (t) => /\bqol\b|\bquality of life\b|\bpros?\b|\beortc\b/i.test(t),
  },
  {
    id: "ira",
    label: "IRA / budget impact",
    test: (t) => /\bira\b|\bbudget-?impact|\bbim\b|\bnet-?price|\bnegotiated-?price/i.test(t),
  },
  {
    id: "ild",
    label: "ILD / QT / pneumonitis safety",
    test: (t) => /\bild\b|\binterstitial|\bqt\b|\bpneumonitis\b/i.test(t),
  },
  {
    id: "hospital_setting",
    label: "hospital / community setting",
    test: (t) => /\bcommunity hospitals?\b|\bhospitals?\b/i.test(t),
  },
  {
    id: "sequencing",
    label: "treatment sequencing",
    test: (t) => /\bsequenc|\btreatment pattern/i.test(t),
  },
  {
    id: "recurrence",
    label: "recurrence burden",
    test: (t) => /\brecurrence\b/i.test(t),
  },
  {
    id: "caregiver",
    label: "caregiver burden",
    test: (t) => /\bcaregiver\b/i.test(t),
  },
  {
    id: "persistence",
    label: "persistence / discontinuation",
    test: (t) => /\bdiscontinuation\b|\bpersistence\b|\b6-month\b/i.test(t),
  },
  {
    id: "soc",
    label: "standard-of-care comparator",
    test: (t) => /\bstandard of care\b|\bsoc\b|\bchemotherapy\b/i.test(t),
  },
  {
    id: "osimertinib",
    label: "osimertinib comparator",
    test: (t) => /\bosimertinib\b/i.test(t),
  },
  {
    id: "nx441",
    label: "NX-441 comparator",
    test: (t) => /\bnx-?441\b/i.test(t),
  },
];

export type MappingGap = Pick<EvidenceGap, "name" | "statement" | "domain">;
export type MappingTactic = Pick<
  Tactic,
  | "name"
  | "type"
  | "description"
  | "evidence_question"
  | "population"
  | "intervention"
  | "comparator"
  | "outcomes"
  | "study_design"
>;
export type MappingNeed = Pick<EvidenceNeed, "statement" | "population" | "comparator" | "outcome">;

export type MappingScoreExtras = {
  needs?: Array<Partial<MappingNeed>>;
  residual_statement?: string;
  rejected?: boolean;
  covered?: boolean;
};

export type MappingScore = {
  score: number;
  reasons: string[];
};

export type MappingSuggestion = {
  gap_id: string;
  gap_name: string;
  gap_statement: string;
  tactic_id: string;
  tactic_name: string;
  reasons: string[];
  score: number;
};

function blankish(value: string | undefined): boolean {
  const t = (value ?? "").trim().toLowerCase();
  return t.length < 2 || t === "n/a" || t === "na" || t === "none" || t === "unknown";
}

function joinHay(parts: Array<string | undefined>): string {
  return parts.filter((p) => p && !blankish(p)).join(" ");
}

export function isDisseminationTactic(tactic: Pick<MappingTactic, "type" | "name" | "description">): boolean {
  if (DISSEMINATION_TACTIC_TYPES.includes(tactic.type)) return true;
  return /\b(congress abstract|manuscript|disseminat)/i.test(`${tactic.name} ${tactic.description}`);
}

function textSimilarity(gap: MappingGap, tactic: MappingTactic): number {
  return Math.max(
    statementSimilarity(gap.statement, tactic.evidence_question),
    statementSimilarity(gap.statement, tactic.name),
    statementSimilarity(gap.name, tactic.evidence_question),
    statementSimilarity(gap.name, tactic.name),
    statementSimilarity(gap.statement, tactic.description),
    statementSimilarity(gap.name, tactic.description),
  );
}

function fieldOverlap(a: string | undefined, b: string | undefined): number {
  if (blankish(a) || blankish(b)) return 0;
  return statementSimilarity(a!, b!);
}

function cueHits(text: string): CueFamily[] {
  return CUE_FAMILIES.filter((cue) => cue.test(text));
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function uniqueReasons(rows: string[], limit = 4): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const text = row.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Deterministic gap–tactic inventory score (0–100) plus human-readable reasons.
 * Not an LLM. Not embeddings. Engine drafts; a human still accept/rejects.
 */
export function scoreGapTacticMapping(
  gap: MappingGap,
  tactic: MappingTactic,
  extras: MappingScoreExtras = {},
): MappingScore {
  if (extras.covered || extras.rejected) {
    return { score: 0, reasons: [] };
  }

  const needHay = (extras.needs ?? []).map((need) =>
    joinHay([need.statement, need.population, need.comparator, need.outcome]),
  );
  const gapHay = joinHay([gap.name, gap.statement, extras.residual_statement, ...needHay]);
  const tacticPrimary = joinHay([
    tactic.name,
    tactic.evidence_question,
    tactic.population,
    tactic.outcomes,
    tactic.comparator,
    tactic.intervention,
  ]);
  const tacticAll = joinHay([
    tacticPrimary,
    tactic.description,
    tactic.study_design,
    TACTIC_TYPE_LABELS[tactic.type],
  ]);

  const reasons: string[] = [];
  let score = 0;

  const sim = textSimilarity(gap, tactic);
  score += sim * 38;
  if (sim >= 0.42) {
    reasons.push("Gap statement and tactic evidence question share substantial wording.");
  } else if (sim >= 0.18) {
    reasons.push("Related wording in the gap statement and the tactic name or evidence question.");
  }

  const affinity = DOMAIN_TYPE_AFFINITY[gap.domain] ?? [];
  const typeFits = affinity.includes(tactic.type);
  const dissemination = isDisseminationTactic(tactic);
  if (typeFits && !dissemination) {
    score += 22;
    reasons.push(
      `${TACTIC_TYPE_LABELS[tactic.type]} is a generation method that fits ${DOMAIN_LABELS[gap.domain]}.`,
    );
  } else if (typeFits && dissemination && gap.domain === "implementation") {
    score += 14;
    reasons.push(
      `${TACTIC_TYPE_LABELS[tactic.type]} matches this ${DOMAIN_LABELS[gap.domain]} communication gap.`,
    );
  }

  const domainLabel = DOMAIN_LABELS[gap.domain].toLowerCase();
  const domainSlug = gap.domain.replaceAll("_", " ");
  if (tacticAll.toLowerCase().includes(domainLabel) || tacticAll.toLowerCase().includes(domainSlug)) {
    score += 8;
    reasons.push(`Shared ${DOMAIN_LABELS[gap.domain]} cue on the tactic record.`);
  }

  const domainCueIds: Partial<Record<EvidenceDomain, string[]>> = {
    comparative_effectiveness: ["elderly", "soc"],
    treatment_sequencing: ["sequencing"],
    treatment_patterns: ["sequencing"],
    hcru: ["hcru"],
    qol_pro: ["qol"],
    caregiver_burden: ["caregiver", "qol"],
    budget_impact: ["ira"],
    economics: ["recurrence", "hcru"],
    safety: ["ild", "hospital_setting"],
    efficacy: ["cns"],
    adherence: ["persistence"],
    subpopulations: ["elderly"],
  };
  const preferred = new Set(domainCueIds[gap.domain] ?? []);
  const gapCues = cueHits(gapHay).sort(
    (a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)),
  );
  for (const cue of gapCues) {
    if (cue.test(tacticPrimary)) {
      score += 12;
      reasons.push(`Shared ${cue.label} language.`);
    } else if (cue.test(tactic.description)) {
      score += 5;
      reasons.push(`Shared ${cue.label} language.`);
    }
  }

  const needs = extras.needs ?? [];
  const popOverlap = Math.max(
    0,
    ...needs.map((need) => fieldOverlap(need.population, tactic.population)),
    fieldOverlap(gap.statement, tactic.population),
  );
  const compOverlap = Math.max(
    0,
    ...needs.map((need) => fieldOverlap(need.comparator, tactic.comparator)),
  );
  const outOverlap = Math.max(
    0,
    ...needs.map((need) => fieldOverlap(need.outcome, tactic.outcomes)),
  );
  if (popOverlap >= 0.34) {
    score += 8;
    reasons.push("Tactic population overlaps a linked evidence need.");
  }
  if (compOverlap >= 0.34) {
    score += 6;
    reasons.push("Tactic comparator overlaps a linked evidence need.");
  }
  if (outOverlap >= 0.34) {
    score += 6;
    reasons.push("Tactic outcomes overlap a linked evidence need.");
  }

  if (!dissemination) {
    score += 6;
  } else if (gap.domain !== "implementation") {
    score -= 34;
  }

  const finalScore = clampScore(score);
  let finalReasons = uniqueReasons(reasons, 4);
  if (finalScore >= MAPPING_SCORE_FLOOR && finalReasons.length < 2) {
    finalReasons = uniqueReasons(
      [
        ...finalReasons,
        "Inventory fields overlap enough to review this join.",
        "Related wording in the gap statement and the tactic record.",
      ],
      4,
    );
  }
  if (finalScore < MAPPING_SCORE_FLOOR) {
    return { score: finalScore, reasons: finalReasons.slice(0, 4) };
  }
  return { score: finalScore, reasons: finalReasons.slice(0, 4) };
}
