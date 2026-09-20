export type SeedGoldGap = {
  id: string;
  name: string;
  statement: string;
  domain: string;
  source_key: string;
  source_quote: string;
  must_find: boolean;
  is_gap: boolean;
};

export const SEED_GOLD_GAPS: SeedGoldGap[] = [
  {
    id: "GOLD-G-001",
    name: "Economic burden of recurrence after velmaratinib",
    statement:
      "Need to understand the economic burden associated with recurrence after velmaratinib, including direct costs of repeat procedures in routine practice.",
    domain: "economics",
    source_key: "heor-interview",
    source_quote:
      "We need to understand the economic burden associated with recurrence after velmaratinib.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-002",
    name: "Comparative effectiveness versus regional SoC in elderly patients",
    statement:
      "Need comparative effectiveness of Velmara versus regional standard of care in patients aged 65 and over.",
    domain: "comparative_effectiveness",
    source_key: "heor-interview",
    source_quote:
      "We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-003",
    name: "Intracranial outcomes in patients with brain metastases",
    statement:
      "Need intracranial / CNS response and duration evidence in patients with brain metastases.",
    domain: "efficacy",
    source_key: "medical-kol",
    source_quote: "KOLs need to know intracranial outcomes.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-004",
    name: "Real-world treatment sequencing after osimertinib versus NX-441",
    statement:
      "Need to characterise real-world treatment sequencing after osimertinib failure versus NX-441.",
    domain: "treatment_sequencing",
    source_key: "medical-kol",
    source_quote:
      "We need to characterise real-world treatment sequencing after osimertinib failure.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-005",
    name: "Six-month discontinuation and persistence in routine care",
    statement:
      "Need 6-month discontinuation / persistence evidence in routine care for formulary.",
    domain: "adherence",
    source_key: "payer-access",
    source_quote:
      "Aetna and UnitedHealthcare need to understand 6-month discontinuation in routine care.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-006",
    name: "IRA net-price exposure and negotiated-price budget impact",
    statement:
      "Need to quantify IRA net-price exposure and whether the budget-impact model reflects the negotiated-price scenario.",
    domain: "budget_impact",
    source_key: "payer-access",
    source_quote: "We need to quantify IRA net-price exposure for Velmara.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-007",
    name: "Emergency-department and outpatient burden after EGFR TKI recurrence",
    statement:
      "Limited evidence remains on emergency-department use and outpatient burden after EGFR TKI recurrence.",
    domain: "hcru",
    source_key: "tlr",
    source_quote:
      "Limited evidence remains on emergency-department use and outpatient burden in the same cohorts.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-008",
    name: "Comparative effectiveness in the elderly versus regional SoC",
    statement:
      "Evidence gap on comparative effectiveness in the elderly versus regional standard of care is not closed.",
    domain: "comparative_effectiveness",
    source_key: "tlr",
    source_quote:
      "Evidence gap on comparative effectiveness in the elderly is not closed.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-009",
    name: "Caregiver burden and PRO in frail patients",
    statement:
      "Insufficient evidence on caregiver burden and PRO in frail patients.",
    domain: "caregiver_burden",
    source_key: "tlr",
    source_quote:
      "Insufficient evidence on caregiver burden and on PRO in frail patients.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-010",
    name: "Overall survival beyond the primary PFS analysis",
    statement:
      "Need overall survival beyond the primary PFS analysis for the 2026 value story.",
    domain: "long_term_outcomes",
    source_key: "cdp",
    source_quote:
      "We need to understand overall survival beyond the primary PFS analysis.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-011",
    name: "Comparative effectiveness versus regional SoC in the elderly",
    statement:
      "Limited evidence remains on comparative effectiveness versus regional standard of care in the elderly because the registry is single-arm.",
    domain: "comparative_effectiveness",
    source_key: "rwe-strategy",
    source_quote:
      "Limited evidence remains on comparative effectiveness versus regional standard of care in the elderly because the registry is single-arm.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-012",
    name: "ILD and QT incidence in routine care",
    statement:
      "Need ILD and QT incidence and monitoring protocols outside academic centres.",
    domain: "safety",
    source_key: "medical-plan",
    source_quote: "We need to understand ILD and QT incidence in routine care.",
    must_find: true,
    is_gap: true,
  },
  {
    id: "GOLD-G-NEG-001",
    name: "Bigger congress presence in 2027",
    statement:
      "Medical affairs wants a bigger congress presence in 2027. This is a dissemination preference, not an evidence need.",
    domain: "implementation",
    source_key: "medical-plan",
    source_quote: "Medical affairs wants a bigger congress presence in 2027.",
    must_find: false,
    is_gap: false,
  },
];
