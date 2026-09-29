import type { TacticType } from "@/lib/iegp/enums";

/**
 * One colour per family of tactic type, as in the design (KAN-8): trials indigo,
 * real-world data teal, evidence synthesis violet, patient voice purple, economics
 * green, collaborations blue, communication grey. Used for chips and timeline bars.
 */
const FAMILY_COLORS = {
  trial: "#4f46e5",
  rwe: "#0f766e",
  synthesis: "#6d28d9",
  patient: "#9333ea",
  economics: "#15803d",
  collaboration: "#1d4ed8",
  communication: "#6b7280",
} as const;

/** The families in legend order, with the label the legend shows. */
export const TACTIC_TYPE_FAMILIES: { label: string; color: string }[] = [
  { label: "Trial & follow-up", color: FAMILY_COLORS.trial },
  { label: "Real-world data", color: FAMILY_COLORS.rwe },
  { label: "Evidence synthesis", color: FAMILY_COLORS.synthesis },
  { label: "Patient voice", color: FAMILY_COLORS.patient },
  { label: "Economics", color: FAMILY_COLORS.economics },
  { label: "Collaboration", color: FAMILY_COLORS.collaboration },
  { label: "Communication", color: FAMILY_COLORS.communication },
];

const FAMILY: Record<TacticType, keyof typeof FAMILY_COLORS> = {
  phase3_trial: "trial",
  long_term_followup: "trial",
  subgroup_analysis: "trial",
  secondary_analysis: "trial",
  rwe_study: "rwe",
  registry: "rwe",
  chart_review: "rwe",
  hcru_study: "rwe",
  natural_history_study: "rwe",
  slr: "synthesis",
  nma: "synthesis",
  itc: "synthesis",
  maic: "synthesis",
  pro_study: "patient",
  patient_survey: "patient",
  cea: "economics",
  budget_impact_model: "economics",
  iis: "collaboration",
  academic_collaboration: "collaboration",
  publication: "communication",
  congress_abstract: "communication",
  evidence_dissemination: "communication",
};

export function tacticTypeColor(type: string): string {
  const family = FAMILY[type as TacticType];
  return family ? FAMILY_COLORS[family] : FAMILY_COLORS.communication;
}
