import type {
  ExtractStrategy,
  GoldInsight,
  ParsedBlock,
  ParsedDocument,
} from "@/lib/schema";

export const ASSET = {
  name: "Velmara",
  molecule: "velmaratinib",
  indication: "2L EGFRm NSCLC after osimertinib",
  as_of: "2026-09-14",
};

type SeedDoc = {
  id: string;
  filename: string;
  title: string;
  stakeholder_function: ParsedDocument["stakeholder_function"];
  mime: string;
  blocks: Omit<ParsedBlock, "id">[];
};

function withIds(doc: SeedDoc): ParsedDocument {
  const blocks = doc.blocks.map((b, i) => ({
    ...b,
    id: `${doc.id}-B${String(i + 1).padStart(2, "0")}`,
  }));
  return {
    id: doc.id,
    filename: doc.filename,
    title: doc.title,
    stakeholder_function: doc.stakeholder_function,
    mime: doc.mime,
    parser: "seed",
    ingested_at: "2026-09-14T10:00:00.000Z",
    blocks,
    fullText: blocks.map((b) => `[${b.location.ref}] ${b.text}`).join("\n"),
  };
}

const commercial: SeedDoc = {
  id: "DOC-COM-001",
  filename: "Velmara_US_Brand_Plan_Q3_2026.pptx",
  title: "Velmara US Brand Plan readout — Q3 2026",
  stakeholder_function: "commercial",
  mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  blocks: [
    {
      location: { kind: "slide", ref: "Slide 1" },
      text: "Velmara US Brand Plan readout — Q3 2026",
      kind: "title",
      heading: "Title",
    },
    {
      location: { kind: "slide", ref: "Slide 2" },
      heading: "Situation",
      text: "Velmara (velmaratinib) is an oral EGFR TKI in development for 2L EGFRm NSCLC after osimertinib.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 2" },
      heading: "Situation",
      text: "PDUFA is 14 Mar 2027; US launch is assumed Q2 2027.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 3" },
      heading: "Demand",
      text: "Unrestricted access supports peak 18% share of 2L EGFRm NSCLC by year 5.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 3" },
      heading: "Demand",
      text: "Share erodes to 11% if two of the top five national accounts remain non-formulary through year 2.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 4" },
      heading: "Access risk",
      text: "Formulary decisions at Aetna and UnitedHealthcare are delayed into Q1 2027 and both accounts have requested additional 6-month discontinuation RWE.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 5" },
      heading: "Competitive",
      text: "Next-generation EGFR-MET bispecific (codename NX-441) is expected to file in 2027 and will contest the post-osimertinib setting.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 6" },
      heading: "Open questions",
      text: "Community oncology adoption versus academic centers remains unquantified. We do not have a reliable split of 2L EGFRm treated lives by site of care. Message testing of CNS differentiation has not been fielded.",
      kind: "paragraph",
    },
    {
      location: { kind: "slide", ref: "Slide 7" },
      heading: "Opportunity",
      text: "Stand up a community-focused peer-to-peer program before the first NPP to close the site-of-care evidence gap.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 8" },
      heading: "REMS",
      text: "FDA has not confirmed whether velmaratinib will require a REMS.",
      kind: "bullet",
    },
  ],
};

const marketAccess: SeedDoc = {
  id: "DOC-MA-001",
  filename: "Velmara_Payer_AdBoard_Sep2026.pptx",
  title: "Velmara payer advisory board — September 2026",
  stakeholder_function: "market_access",
  mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  blocks: [
    {
      location: { kind: "slide", ref: "Slide 1" },
      text: "Velmara payer advisory board — September 2026",
      kind: "title",
    },
    {
      location: { kind: "slide", ref: "Slide 2" },
      heading: "Objections",
      text: "ICER-style cost-effectiveness versus chemo-plus-IO is the dominant objection among national pharmacy directors.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 3" },
      heading: "Utilization management",
      text: "Payers will impose a step edit through osimertinib plus documented progression unless CNS and discontinuation data are in the AMCP dossier.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 4" },
      heading: "Medicaid",
      text: "Medicaid plans in Texas, Florida, and New York flagged high risk of preferred-product step therapy.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 5" },
      heading: "Contracting opportunity",
      text: "A regional Blues plan (Horizon) signaled openness to an outcomes-based contract tied to 6-month persistence.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 6" },
      heading: "Unknowns",
      text: "Impact of CMS IRA negotiation eligibility on net price in year 3 is not modeled.",
      kind: "paragraph",
    },
    {
      location: { kind: "slide", ref: "Slide 7" },
      heading: "Evidence gap",
      text: "No payer-ready RWE protocol exists for real-world discontinuation at 6 months.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 8" },
      heading: "Dossier requests",
      text: "National accounts want both CNS metastases subgroup data and a budget-impact model at 1% and 3% uptake.",
      kind: "bullet",
    },
  ],
};

const medical: SeedDoc = {
  id: "DOC-MED-001",
  filename: "Velmara_KOL_Insights_Q3_2026.docx",
  title: "Medical Affairs KOL insights — Q3 2026",
  stakeholder_function: "medical_affairs",
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  blocks: [
    {
      location: { kind: "page", ref: "p.1" },
      heading: "Intracranial data",
      text: "KOLs consistently asked for intracranial activity data. The current clinical package has limited brain-mets representation (n=28).",
      kind: "paragraph",
    },
    {
      location: { kind: "page", ref: "p.1" },
      heading: "Sequencing",
      text: "Sequencing after osimertinib failure is the decision that will determine use; T790M is not the relevant question in 2L post-osi.",
      kind: "paragraph",
    },
    {
      location: { kind: "page", ref: "p.2" },
      heading: "Testing gaps",
      text: "Community biomarker testing still misses liquid biopsy in about 30% of progressing patients in the Southeast.",
      kind: "paragraph",
    },
    {
      location: { kind: "page", ref: "p.2" },
      heading: "Resistance mutations",
      text: "Some KOLs mentioned resistance mutations without specifying which alterations should trigger Velmara versus a clinical trial.",
      kind: "paragraph",
    },
    {
      location: { kind: "page", ref: "p.3" },
      heading: "Medical education",
      text: "Opportunity to fund a medical education series on post-osi resistance testing.",
      kind: "paragraph",
    },
    {
      location: { kind: "page", ref: "p.3" },
      heading: "Supportive data",
      text: "Unknown whether KOLs will accept tumor-agnostic EGFR exon 20 data as supportive.",
      kind: "paragraph",
    },
    {
      location: { kind: "page", ref: "p.4" },
      heading: "REMS",
      text: "A REMS for velmaratinib remains unspecified; no elements have been proposed.",
      kind: "paragraph",
    },
  ],
};

const clinops: SeedDoc = {
  id: "DOC-CO-001",
  filename: "VEL-203_Enrollment_Dashboard_Sep2026.xlsx",
  title: "VEL-203 enrollment dashboard — Sep 2026",
  stakeholder_function: "clinops",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  blocks: [
    {
      location: { kind: "sheet", ref: "Enrollment!B2" },
      heading: "Enrollment",
      text: "Protocol VEL-203 target 420, enrolled 281 (67%) at month 14.",
      kind: "cell",
    },
    {
      location: { kind: "sheet", ref: "Enrollment!B3" },
      heading: "Screen fail",
      text: "Screen fail rate is 41%, primary reason prior TKI washout window.",
      kind: "cell",
    },
    {
      location: { kind: "sheet", ref: "Enrollment!B4" },
      heading: "Site activation",
      text: "Southern EU site activation is 4.2 months versus 2.1 months in the US.",
      kind: "cell",
    },
    {
      location: { kind: "sheet", ref: "Enrollment!B5" },
      heading: "Protocol opportunity",
      text: "Opportunity: protocol amendment to allow concurrent biopsy during washout.",
      kind: "cell",
    },
    {
      location: { kind: "sheet", ref: "Enrollment!B6" },
      heading: "Competitive enrollment",
      text: "Unknown: impact of competing NX-441 phase 3 on remaining US sites.",
      kind: "cell",
    },
    {
      location: { kind: "sheet", ref: "Enrollment!B7" },
      heading: "Japan",
      text: "Japan first-patient-in slipped from May to September 2026.",
      kind: "cell",
    },
  ],
};

const marketing: SeedDoc = {
  id: "DOC-MKT-001",
  filename: "Velmara_Unbranded_Campaign_Readout_Q3.pptx",
  title: "Velmara unbranded campaign readout — Q3 2026",
  stakeholder_function: "marketing",
  mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  blocks: [
    {
      location: { kind: "slide", ref: "Slide 1" },
      text: "Velmara unbranded campaign readout — Q3 2026",
      kind: "title",
    },
    {
      location: { kind: "slide", ref: "Slide 2" },
      heading: "Channel mix",
      text: "Unbranded disease-awareness impressions over-index 3.2x in academic versus community settings.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 3" },
      heading: "Message recall",
      text: "Message recall is 64% for once-daily oral and 19% for CNS coverage.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 4" },
      heading: "Patient support",
      text: "Patient support program NPS is not measured.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 5" },
      heading: "Email",
      text: "HCP email open rate is 28% versus a 22% benchmark.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 6" },
      heading: "Media opportunity",
      text: "Opportunity: shift 40% of unbranded spend to community oncology networks in Texas, Florida, and Ohio.",
      kind: "bullet",
    },
    {
      location: { kind: "slide", ref: "Slide 7" },
      heading: "Message unknown",
      text: "Unknown whether the post-osi sequencing message is differentiated versus competitor unbranded campaigns.",
      kind: "paragraph",
    },
  ],
};

export const SEED_DOCUMENTS: ParsedDocument[] = [
  commercial,
  marketAccess,
  medical,
  clinops,
  marketing,
].map(withIds);

export const THEME_CATALOG = [
  {
    id: "THEME-ACCESS",
    name: "Access & formulary",
    summary:
      "National and Medicaid coverage, step edits, and the RWE the accounts are using to delay decisions.",
    keywords: [
      "formulary",
      "aetna",
      "unitedhealthcare",
      "medicaid",
      "step",
      "amcp",
      "account",
      "access",
      "horizon",
      "contract",
      "payer",
    ],
  },
  {
    id: "THEME-EVIDENCE",
    summary:
      "CNS, discontinuation, intracranial, and payer-ready RWE packages that multiple functions say are missing.",
    name: "Evidence gaps",
    keywords: [
      "rwe",
      "cns",
      "discontinuation",
      "intracranial",
      "brain",
      "dossier",
      "n=28",
      "persistence",
      "evidence",
    ],
  },
  {
    id: "THEME-COMPETITIVE",
    name: "Competitive dynamics",
    summary: "NX-441 and other post-osi threats to share, sites, and messaging.",
    keywords: ["nx-441", "bispecific", "competitor", "competitive", "file"],
  },
  {
    id: "THEME-SITE-OF-CARE",
    name: "Community vs academic",
    summary:
      "Where 2L lives are treated, whether community adopts, and whether spend and testing follow.",
    keywords: [
      "community",
      "academic",
      "site of care",
      "peer-to-peer",
      "southeast",
    ],
  },
  {
    id: "THEME-TRIAL",
    name: "Trial execution",
    summary: "VEL-203 enrollment, screen fail, activation lag, and protocol design.",
    keywords: [
      "enrolled",
      "screen fail",
      "washout",
      "site activation",
      "japan",
      "vel-203",
      "protocol",
      "biopsy",
    ],
  },
  {
    id: "THEME-HCP",
    name: "HCP engagement & messaging",
    summary: "Recall, channel mix, NPS, and whether sequencing copy is differentiated.",
    keywords: [
      "message",
      "recall",
      "nps",
      "email",
      "unbranded",
      "impressions",
      "spend",
    ],
  },
  {
    id: "THEME-SEQUENCING",
    name: "Sequencing & resistance",
    summary:
      "Post-osi use, T790M irrelevance, and unspecified resistance mutations KOLs keep raising.",
    keywords: [
      "sequencing",
      "t790m",
      "resistance",
      "post-osi",
      "exon",
      "liquid biopsy",
    ],
  },
  {
    id: "THEME-POLICY",
    name: "Pricing & policy",
    summary: "IRA negotiation, net price, ICER-style objections, and budget impact.",
    keywords: ["ira", "cms", "icer", "net price", "budget-impact", "uptake"],
  },
  {
    id: "THEME-RESIDUAL",
    name: "Unassigned",
    summary:
      "Insights that did not clear the catalog threshold. Held once, never copied, and queued for a new theme proposal rather than forced into a blob.",
    keywords: [],
  },
];

export const GOLD_INSIGHTS: GoldInsight[] = [
  {
    id: "GOLD-001",
    statement:
      "Velmara (velmaratinib) is an oral EGFR TKI in development for 2L EGFRm NSCLC after osimertinib.",
    source_document_id: "DOC-COM-001",
    classification: "known",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-SEQUENCING"],
    must_find: true,
  },
  {
    id: "GOLD-002",
    statement: "PDUFA is 14 Mar 2027; US launch is assumed Q2 2027.",
    source_document_id: "DOC-COM-001",
    classification: "known",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-003",
    statement:
      "Unrestricted access supports peak 18% share of 2L EGFRm NSCLC by year 5.",
    source_document_id: "DOC-COM-001",
    classification: "known",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-004",
    statement:
      "Share erodes to 11% if two of the top five national accounts remain non-formulary through year 2.",
    source_document_id: "DOC-COM-001",
    classification: "known",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-005",
    statement:
      "Formulary decisions at Aetna and UnitedHealthcare are delayed into Q1 2027.",
    source_document_id: "DOC-COM-001",
    classification: "known",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-006",
    statement:
      "Aetna and UnitedHealthcare have requested additional 6-month discontinuation RWE.",
    source_document_id: "DOC-COM-001",
    classification: "known",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-EVIDENCE", "THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-007",
    statement:
      "Next-generation EGFR-MET bispecific NX-441 is expected to file in 2027 and will contest the post-osimertinib setting.",
    source_document_id: "DOC-COM-001",
    classification: "known",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-COMPETITIVE"],
    must_find: true,
  },
  {
    id: "GOLD-008",
    statement:
      "Community oncology adoption versus academic centers remains unquantified.",
    source_document_id: "DOC-COM-001",
    classification: "unknown",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-SITE-OF-CARE"],
    must_find: true,
  },
  {
    id: "GOLD-009",
    statement:
      "There is no reliable split of 2L EGFRm treated lives by site of care.",
    source_document_id: "DOC-COM-001",
    classification: "unknown",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-SITE-OF-CARE"],
    must_find: true,
  },
  {
    id: "GOLD-010",
    statement: "Message testing of CNS differentiation has not been fielded.",
    source_document_id: "DOC-COM-001",
    classification: "unknown",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-HCP", "THEME-EVIDENCE"],
    must_find: true,
  },
  {
    id: "GOLD-011",
    statement:
      "Stand up a community-focused peer-to-peer program before the first NPP to close the site-of-care evidence gap.",
    source_document_id: "DOC-COM-001",
    classification: "opportunity",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-SITE-OF-CARE"],
    must_find: true,
  },
  {
    id: "GOLD-012",
    statement:
      "ICER-style cost-effectiveness versus chemo-plus-IO is the dominant objection among national pharmacy directors.",
    source_document_id: "DOC-MA-001",
    classification: "known",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-POLICY"],
    must_find: true,
  },
  {
    id: "GOLD-013",
    statement:
      "Payers will impose a step edit through osimertinib plus documented progression unless CNS and discontinuation data are in the AMCP dossier.",
    source_document_id: "DOC-MA-001",
    classification: "known",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-ACCESS", "THEME-EVIDENCE"],
    must_find: true,
  },
  {
    id: "GOLD-014",
    statement:
      "Medicaid plans in Texas, Florida, and New York flagged high risk of preferred-product step therapy.",
    source_document_id: "DOC-MA-001",
    classification: "known",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-015",
    statement:
      "Horizon signaled openness to an outcomes-based contract tied to 6-month persistence.",
    source_document_id: "DOC-MA-001",
    classification: "opportunity",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-016",
    statement:
      "Impact of CMS IRA negotiation eligibility on net price in year 3 is not modeled.",
    source_document_id: "DOC-MA-001",
    classification: "unknown",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-POLICY"],
    must_find: true,
  },
  {
    id: "GOLD-017",
    statement:
      "No payer-ready RWE protocol exists for real-world discontinuation at 6 months.",
    source_document_id: "DOC-MA-001",
    classification: "unknown",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-EVIDENCE", "THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-018",
    statement: "National accounts want CNS metastases subgroup data.",
    source_document_id: "DOC-MA-001",
    classification: "known",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-EVIDENCE", "THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-019",
    statement:
      "National accounts want a budget-impact model at 1% and 3% uptake.",
    source_document_id: "DOC-MA-001",
    classification: "known",
    stakeholder_function: "market_access",
    theme_ids: ["THEME-POLICY", "THEME-ACCESS"],
    must_find: true,
  },
  {
    id: "GOLD-020",
    statement: "KOLs consistently asked for intracranial activity data.",
    source_document_id: "DOC-MED-001",
    classification: "known",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-EVIDENCE"],
    must_find: true,
  },
  {
    id: "GOLD-021",
    statement:
      "The current clinical package has limited brain-mets representation (n=28).",
    source_document_id: "DOC-MED-001",
    classification: "known",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-EVIDENCE"],
    must_find: true,
  },
  {
    id: "GOLD-022",
    statement:
      "Sequencing after osimertinib failure is the decision that will determine use.",
    source_document_id: "DOC-MED-001",
    classification: "known",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-SEQUENCING"],
    must_find: true,
  },
  {
    id: "GOLD-023",
    statement: "T790M is not the relevant question in 2L post-osi.",
    source_document_id: "DOC-MED-001",
    classification: "known",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-SEQUENCING"],
    must_find: true,
  },
  {
    id: "GOLD-024",
    statement:
      "Community biomarker testing still misses liquid biopsy in about 30% of progressing patients in the Southeast.",
    source_document_id: "DOC-MED-001",
    classification: "known",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-SITE-OF-CARE", "THEME-SEQUENCING"],
    must_find: true,
  },
  {
    id: "GOLD-025",
    statement:
      "Some KOLs mentioned resistance mutations without specifying which alterations should trigger Velmara versus a clinical trial.",
    source_document_id: "DOC-MED-001",
    classification: "unknown",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-SEQUENCING"],
    must_find: true,
  },
  {
    id: "GOLD-026",
    statement:
      "Opportunity to fund a medical education series on post-osi resistance testing.",
    source_document_id: "DOC-MED-001",
    classification: "opportunity",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-SEQUENCING"],
    must_find: true,
  },
  {
    id: "GOLD-027",
    statement:
      "Unknown whether KOLs will accept tumor-agnostic EGFR exon 20 data as supportive.",
    source_document_id: "DOC-MED-001",
    classification: "unknown",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-EVIDENCE"],
    must_find: true,
  },
  {
    id: "GOLD-028",
    statement: "Protocol VEL-203 is at 281 enrolled of 420 target (67%) at month 14.",
    source_document_id: "DOC-CO-001",
    classification: "known",
    stakeholder_function: "clinops",
    theme_ids: ["THEME-TRIAL"],
    must_find: true,
  },
  {
    id: "GOLD-029",
    statement:
      "Screen fail rate is 41%, primary reason prior TKI washout window.",
    source_document_id: "DOC-CO-001",
    classification: "known",
    stakeholder_function: "clinops",
    theme_ids: ["THEME-TRIAL"],
    must_find: true,
  },
  {
    id: "GOLD-030",
    statement:
      "Southern EU site activation is 4.2 months versus 2.1 months in the US.",
    source_document_id: "DOC-CO-001",
    classification: "known",
    stakeholder_function: "clinops",
    theme_ids: ["THEME-TRIAL"],
    must_find: true,
  },
  {
    id: "GOLD-031",
    statement:
      "Protocol amendment to allow concurrent biopsy during washout.",
    source_document_id: "DOC-CO-001",
    classification: "opportunity",
    stakeholder_function: "clinops",
    theme_ids: ["THEME-TRIAL"],
    must_find: true,
  },
  {
    id: "GOLD-032",
    statement:
      "Impact of competing NX-441 phase 3 on remaining US sites is unknown.",
    source_document_id: "DOC-CO-001",
    classification: "unknown",
    stakeholder_function: "clinops",
    theme_ids: ["THEME-COMPETITIVE", "THEME-TRIAL"],
    must_find: true,
  },
  {
    id: "GOLD-033",
    statement: "Japan first-patient-in slipped from May to September 2026.",
    source_document_id: "DOC-CO-001",
    classification: "known",
    stakeholder_function: "clinops",
    theme_ids: ["THEME-TRIAL"],
    must_find: true,
  },
  {
    id: "GOLD-034",
    statement:
      "Unbranded disease-awareness impressions over-index 3.2x in academic versus community settings.",
    source_document_id: "DOC-MKT-001",
    classification: "known",
    stakeholder_function: "marketing",
    theme_ids: ["THEME-HCP"],
    must_find: true,
  },
  {
    id: "GOLD-035",
    statement:
      "Message recall is 64% for once-daily oral and 19% for CNS coverage.",
    source_document_id: "DOC-MKT-001",
    classification: "known",
    stakeholder_function: "marketing",
    theme_ids: ["THEME-HCP"],
    must_find: true,
  },
  {
    id: "GOLD-036",
    statement: "Patient support program NPS is not measured.",
    source_document_id: "DOC-MKT-001",
    classification: "unknown",
    stakeholder_function: "marketing",
    theme_ids: ["THEME-HCP"],
    must_find: true,
  },
  {
    id: "GOLD-037",
    statement: "HCP email open rate is 28% versus a 22% benchmark.",
    source_document_id: "DOC-MKT-001",
    classification: "known",
    stakeholder_function: "marketing",
    theme_ids: ["THEME-HCP"],
    must_find: false,
  },
  {
    id: "GOLD-038",
    statement:
      "Shift 40% of unbranded spend to community oncology networks in Texas, Florida, and Ohio.",
    source_document_id: "DOC-MKT-001",
    classification: "opportunity",
    stakeholder_function: "marketing",
    theme_ids: ["THEME-SITE-OF-CARE", "THEME-HCP"],
    must_find: true,
  },
  {
    id: "GOLD-039",
    statement:
      "Unknown whether the post-osi sequencing message is differentiated versus competitor unbranded campaigns.",
    source_document_id: "DOC-MKT-001",
    classification: "unknown",
    stakeholder_function: "marketing",
    theme_ids: ["THEME-HCP", "THEME-SEQUENCING", "THEME-COMPETITIVE"],
    must_find: true,
  },
  {
    id: "GOLD-040",
    statement:
      "FDA has not confirmed whether velmaratinib will require a REMS.",
    source_document_id: "DOC-COM-001",
    classification: "unknown",
    stakeholder_function: "commercial",
    theme_ids: ["THEME-RESIDUAL"],
    must_find: false,
  },
  {
    id: "GOLD-041",
    statement:
      "A REMS for velmaratinib remains unspecified; no elements have been proposed.",
    source_document_id: "DOC-MED-001",
    classification: "unknown",
    stakeholder_function: "medical_affairs",
    theme_ids: ["THEME-RESIDUAL"],
    must_find: false,
  },
];

export const STRATEGY_BY_VERSION: Record<string, ExtractStrategy> = {
  "v1.0-baseline": "bullet-only",
  "v1.1-atomic": "claim-split",
  "v1.2-gap-sensitive": "gap-scan",
  "v1.3-cross-functional": "full",
};
