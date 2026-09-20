import type { ActorFunction, SourceType } from "./enums";

export type DemoSourceFile = {
  id: string;
  filename: string;
  title: string;
  source_type: SourceType;
  stakeholder_function: ActorFunction;
  text: string;
};

export const DEMO_PACK: DemoSourceFile[] = [
  {
    id: "heor-interview",
    filename: "01-heor-stakeholder-interview.txt",
    title: "HEOR stakeholder interviews",
    source_type: "stakeholder_interview",
    stakeholder_function: "heor",
    text: `HEOR stakeholder interviews — Velmara / velmaratinib, 2L EGFR-mutant NSCLC, Q3 2026.

Burden
We need to understand the economic burden associated with recurrence after velmaratinib. Limited evidence characterises direct costs of repeat procedures in routine practice.

Elderly
We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients. Insufficient evidence in patients aged 65 and over remains an open question for HTA.

A single-arm chart review in patients aged ≥65 is already underway in two EU5 centres. It has no comparative arm versus chemotherapy SoC.`,
  },
  {
    id: "medical-kol",
    filename: "02-medical-kol-interview.txt",
    title: "Medical affairs KOL interviews",
    source_type: "stakeholder_interview",
    stakeholder_function: "medical_affairs",
    text: `Medical affairs KOL interviews — CNS and sequencing.

CNS
KOLs need to know intracranial outcomes. Limited evidence on CNS response and duration in patients with brain metastases remains an open question for medical affairs.

Sequencing
We need to characterise real-world treatment sequencing after osimertinib failure. Insufficient data on where Velmara sits versus NX-441.

A congress abstract on sequencing is planned for 2027, but that is dissemination, not new evidence generation.`,
  },
  {
    id: "payer-access",
    filename: "03-payer-access-interview.txt",
    title: "US payer and access interviews",
    source_type: "advisory_board",
    stakeholder_function: "market_access",
    text: `US national payer advisory — Aetna and UnitedHealthcare.

Persistence
Aetna and UnitedHealthcare need to understand 6-month discontinuation in routine care. Limited evidence on persistence is blocking formulary.

IRA
We need to quantify IRA net-price exposure for Velmara. Unknown whether the current budget-impact model reflects the negotiated-price scenario.

A claims study for 6-month discontinuation is proposed but has not started.`,
  },
  {
    id: "tlr",
    filename: "04-targeted-literature-review.txt",
    title: "Targeted literature review excerpt",
    source_type: "targeted_literature_review",
    stakeholder_function: "heor",
    text: `Targeted literature review — recurrence HCRU, elderly RWE, PRO.

Study A reports hospitalisations after EGFR TKI recurrence. Limited evidence remains on emergency-department use and outpatient burden in the same cohorts.

Study B is a single-arm chart review of patients aged ≥65 treated with an EGFR TKI. No comparative arm versus regional standard of care. Evidence gap on comparative effectiveness in the elderly is not closed.

Study C measures EORTC QLQ-C30 in a mixed-age trial population. Insufficient evidence on caregiver burden and on PRO in frail patients.`,
  },
  {
    id: "cdp",
    filename: "05-clinical-development-plan.txt",
    title: "Clinical development plan excerpt",
    source_type: "clinical_development_plan",
    stakeholder_function: "clinical_development",
    text: `VEL-301 CDP §4.

VEL-301 Phase III versus osimertinib addresses PFS in 2L EGFR-mutant NSCLC. Subgroup analysis in elderly is planned but not a powered comparative effectiveness question versus chemotherapy SoC.

We need to understand overall survival beyond the primary PFS analysis. Limited evidence will be available for the 2026 value story; long-term follow-up is planned.`,
  },
  {
    id: "rwe-strategy",
    filename: "06-rwe-strategy.txt",
    title: "RWE / epidemiology strategy",
    source_type: "rwe_strategy",
    stakeholder_function: "rwe",
    text: `RWE strategy — prospective registry.

The prospective Velmara registry will collect treatment, progression, survival, hospitalisations, sequencing and PROs. It does not include a concurrent SoC comparator in elderly patients.

Limited evidence remains on comparative effectiveness versus regional standard of care in the elderly because the registry is single-arm.`,
  },
  {
    id: "medical-plan",
    filename: "07-medical-action-plan.txt",
    title: "Medical action plan",
    source_type: "medical_strategy",
    stakeholder_function: "medical_affairs",
    text: `Medical action plan 2027.

Medical affairs wants a bigger congress presence in 2027. This is a dissemination preference, not an evidence need.

We need to understand ILD and QT incidence in routine care. Limited evidence characterises monitoring protocols outside academic centres.

A publication of the VEL-301 primary manuscript is planned as a dissemination tactic.`,
  },
];

export function demoSourceById(id: string): DemoSourceFile | undefined {
  return DEMO_PACK.find((file) => file.id === id);
}

export type DemoJsonFixtureMeta = {
  id: string;
  source_key: string;
  filename: string;
  href: string;
  title: string;
  source_type: SourceType;
  stakeholder_function: ActorFunction;
  flavor: "parsed_document" | "llamaparse";
};

/** Static JSON extract fixtures in `public/demo-sources/json/`. Gold `source_key` matches `id` for ParsedDocument files. */
export const DEMO_JSON_PACK: DemoJsonFixtureMeta[] = [
  ...DEMO_PACK.map((file) => ({
    id: file.id,
    source_key: file.id,
    filename: `${file.id}.json`,
    href: `/demo-sources/json/${file.id}.json`,
    title: file.title,
    source_type: file.source_type,
    stakeholder_function: file.stakeholder_function,
    flavor: "parsed_document" as const,
  })),
  {
    id: "medical-kol-llamaparse",
    source_key: "medical-kol",
    filename: "medical-kol.llamaparse.json",
    href: "/demo-sources/json/medical-kol.llamaparse.json",
    title: "Medical affairs KOL interviews (LlamaParse deck)",
    source_type: "stakeholder_interview",
    stakeholder_function: "medical_affairs",
    flavor: "llamaparse",
  },
  {
    id: "payer-access-llamaparse",
    source_key: "payer-access",
    filename: "payer-access.llamaparse.json",
    href: "/demo-sources/json/payer-access.llamaparse.json",
    title: "US payer and access interviews (LlamaParse deck)",
    source_type: "advisory_board",
    stakeholder_function: "market_access",
    flavor: "llamaparse",
  },
];
