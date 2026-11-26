import { stageWrite } from "@/modules/kernel/stage-publication";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { buildIdeationGapBrief, ideationAcceptanceBasis, type IdeationGapBrief } from "./context";
import { ideationRecommendationSchema, ideationGapOutcomeSchema, type IdeationGapOutcome, type IdeationRecommendation } from "./recommendation-contract";
import { relationshipVersion } from "@/lib/iegp/relationship-version";
import { matchesSuppliedJudgementRecords, inspectJudgementReferences, inspectSuppliedJudgementReferences, judgementReferenceSchema, recordedJudgementReferences, suppliedJudgementRecords, suppliedJudgementRecordSchema, type JudgementReference } from "@/lib/iegp/judgement-references";
import { withRelationshipChange } from "@/lib/iegp/relationship-change";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import * as core from "@/lib/iegp/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import {
  PROPOSER_CRITIC_EXCHANGES,
  runAgenticCycle,
  type Critique,
  type JudgedCandidate,
} from "@/modules/kernel/agentic";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import { modelRows } from "@/modules/kernel/model-rows";
import { NoRouteError } from "@/modules/llm/provider";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import {
  TACTIC_TYPES,
  type EvidenceDomain,
  type TacticType,
} from "@/lib/iegp/enums";
import { appendAudit, reuseTacticForGap, insertLibraryTactic, loadState, readStageState, readState, syncComputedGapStatuses } from "@/lib/iegp/store";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import { displayedGapStatus, isLiveGap, emptyDimensions, unlocked } from "@/lib/iegp/engine";
import { listPlacements, readPlacements } from "@/modules/stages/s8-prioritization/module";
import { plural } from "@/lib/plural";
import { acceptTacticExpansion, expansionScopeSchema, modelExpansionScope, tacticVersion, type ExpansionTransaction } from "@/lib/iegp/tactic-expansions";
import type { ExpansionScope, IegpState, Tactic } from "@/lib/iegp/types";
import { captureProposalDecision } from "@/lib/iegp/learning-capture";

/**
 * The designed study. Every field, the timing included, comes from the model:
 * S10 lays the tactic out on the timeline from `duration_months` and
 * `readout_lag_months`, and `timing_rationale` says where those numbers came from.
 */
const designSchema = z.object({
  population: z.string(),
  comparator: z.string(),
  outcomes: z.string(),
  data_source: z.string(),
  study_design: z.string(),
  /** Months from start to last data in. */
  duration_months: z.number(),
  /** Months from last data in to a readout the team can use. */
  readout_lag_months: z.number(),
  /** Why the model chose that duration and lag. */
  timing_rationale: z.string(),
});

const inputSchema = z.object({
  /** Defaults to every open gap whose priority band a human validated (High only). */
  gap_ids: z.array(z.string()).optional(),
  /** Most ideas the judge may keep for one gap. */
  per_gap: z.number().int().min(1).max(5).default(2),
  dry_run: z.boolean().default(false),
});

const proposalSchema = z.object({
  references: z.array(judgementReferenceSchema).default([]),
  proposal_kind: z.enum(["new", "expansion", "reuse"]).default("new"),
  recommendation: ideationRecommendationSchema.optional(),
  supporting_context_basis: z.string().optional(),
  target_tactic_id: z.string().nullable().default(null),
  expansion_scope: expansionScopeSchema.nullable().default(null),
  comparative_rationale: z.string().default(""),
  id: z.string(),
  gap_id: z.string(),
  name: z.string(),
  type: z.string(),
  evidence_question: z.string(),
  rationale: z.string(),
  design: designSchema,
  /** Non-probabilistic 0–100 review rating; not a probability of success. */
  score: z.number(),
  critic_note: z.string(),
  /** Why the judge kept or rejected it, and for a kept idea its rank within the gap. */
  judge_note: z.string(),
  /** 1 is the judge's first choice for the gap; null when rejected. */
  rank: z.number().nullable(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposals: z.array(proposalSchema),
  rejected: z.array(proposalSchema),
  gaps_considered: z.number(),
  gap_outcomes: z.array(ideationGapOutcomeSchema).default([]),
  withdrawn: z.array(z.object({ slot_id: z.string(), note: z.string() })).optional(),
});

export type IdeationInput = z.infer<typeof inputSchema>;
export type IdeationOutput = z.infer<typeof outputSchema>;

type Design = z.infer<typeof designSchema>;
type Proposal = z.infer<typeof proposalSchema>;

type IdeationGap = { id: string; name: string; statement: string; domain: EvidenceDomain; brief?: IdeationGapBrief; supporting_context_basis?: string };

/** Listing order of the validated bands. Ideation itself serves High only. */
export const BAND_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * The gaps S9 (and "Add idea by hand") serves: open gaps whose priority a human
 * validated as High, as in the owner's Figma design (KAN-8, 2026-09-29). Medium,
 * Low and Defer gaps are not ideated here; their tactics come from the Tactic
 * Library or the gap. No rule decides beyond the human's validated band.
 */
export function ideationBandOrder(
  placements: { gap_id: string; validated: boolean; band: "high" | "medium" | "low" | "defer" | null }[],
): Map<string, number> {
  const order = new Map<string, number>();
  for (const placement of placements) {
    if (!placement.validated || placement.band !== "high") continue;
    order.set(placement.gap_id, BAND_RANK.high);
  }
  return order;
}
type LibraryTactic = Tactic & { expansions?: {id:string; status:string; scope:ExpansionScope}[] };

const REFERENCE_EXAMPLE = `"references":[{"entity_type":"gap","entity_id":"supplied gap id","reason":"specific supported claim"}]`;
const RECOMMENDATION_EXAMPLE = `{"remaining_need":"unresolved requirement","incremental_contribution":"contribution to that requirement","alternatives_rationale":"relevant trade-offs","feasibility":{"status":"conditional","required_checks":["confirm data access"]},"coverage_discrepancy":null,"deadline":{"status":"unknown","explanation":"confirm evidence availability"}}`;
const DESIGN_FIELDS = `"population":"","comparator":"","outcomes":"","data_source":"","study_design":"","duration_months":6,"readout_lag_months":0,"timing_rationale":""`;

const IDEATION_SYSTEM = `You recommend options that contribute to the remaining evidence need of a prioritized evidence gap in a pharma Integrated Evidence Generation Plan.

Each tactic must be a runnable study, analysis or publication with a population, comparator, outcomes, a data source and a design. Do not restate the gap. Consider reuse of existing accepted produced or planned output unchanged, expansion of an existing accepted tactic, and new work. Do not force an option for each route. Reuse adds no work; any new analysis of existing data is expansion. Planned output is not delivered evidence. A reuse option must name target_tactic_id and preserve its exact evidence_question, population, comparator, outcomes, data_source and study_design; do not redesign it. Explain relevant alternatives for evidence quality, incremental cost/effort, time and feasibility in comparative_rationale; a blanket three-route comparison is not required. Do not invent an expansion when no sensible target exists. A new tactic must not duplicate the library. An expansion must add specified scope beyond the parent and any existing child expansions you are given, and retain target_tactic_id; tactic_id is never the target. Completed trials permit only post-hoc analyses using existing data; prospective additions require a credible protocol amendment on an active study or a new study.

For an expansion, name, evidence_question, population, outcomes and study_design must exactly match expansion_scope. These are the child design, not the parent. If optional type, comparator or data_source are present in expansion_scope they must match the common design too.

type is one of: ${TACTIC_TYPES.join(", ")}.
duration_months is how long the tactic runs from start to last data in; readout_lag_months is how long from last data in to a usable readout. Estimate both for this specific design and say why in timing_rationale. Where a design has no comparator, say so in comparator (for example "None — descriptive") rather than leaving it empty. For reuse, preserve an empty/unknown recorded field unchanged instead of inventing a value.

Propose at most candidates_per_gap distinct useful candidates per gap; fewer or none may be appropriate. If no credible option or no timely option exists, return gap_outcomes with gap_id, status (no_credible_option or no_timely_option), and explanation. Preserve the evidence deadline; identify useful longer-term options separately. Fill in every field for returned candidates.

When a gap carries revise requests, answer each one: return that tactic with its id, revised to meet the objection, or set "withdraw":true with a reason when it cannot be rescued. If there is no credible or timely option after withdrawal, include one gap_outcomes entry for that gap.

Return JSON only: {"tactics":[{"id":"","gap_id":"","name":"","type":"","evidence_question":"","rationale":"","proposal_kind":"new","target_tactic_id":null,"expansion_scope":null,"comparative_rationale":"","contract_version":2,"recommendation":${RECOMMENDATION_EXAMPLE},${REFERENCE_EXAMPLE},${DESIGN_FIELDS},"withdraw":false,"withdraw_reason":""}],"gap_outcomes":[{"gap_id":"","status":"no_credible_option","explanation":""}]}`;

const SUPPORT_CONTRACT = `Every tactic, critic review and judge decision must include references: [{"entity_type":"gap|objective|source","entity_id":"supplied id","reason":"specific claim supported by this record"}]. Cite at least one supplied record with a nonempty excerpt. Use only supporting_records supplied with the relevant gap. Do not invent references or URLs.`;

const EXPANSION_CONTRACT = `Expansion scope fields (all explicit): name, evidence_question, population, outcomes, geography, data_cut, analysis, instrument, study_design, gap_coverage, cost_effort, timing, feasibility_risks, post_hoc, prospective_enrolment, protocol_amendment, start_date, evidence_available. post_hoc, prospective_enrolment and protocol_amendment are JSON booleans (true or false), never text: explain them in feasibility_risks. Unused added scope is an empty string; dates are null or ISO dates (YYYY-MM-DD). Compare expansion and new alternatives for evidence quality, time/cost and feasibility. Never claim an amendment or data access is already approved.`;

const CRITIC_SYSTEM = `You critique proposed evidence tactics for prioritized evidence gaps in a pharma Integrated Evidence Generation Plan.

For each tactic, judge its incremental contribution to the remaining need: is the design runnable, are the population, comparator and outcomes the right ones for this gap, are the data source, duration and readout lag credible for this design, and does the rationale hold. Compare relevant reuse, expansion and new alternatives for quality, time/cost and feasibility. Reuse should request coverage reassessment when unchanged existing output may answer the need; it must not be dropped solely for matching its target. Any added analysis is expansion. For expansions check added scope, post-hoc/prospective constraints and credible amendments. An expansion with a valid additional scope is not a duplicate of its parent. Check new tactics against the tactic library you are given: if a new tactic repeats existing output, identify its id in duplicate_of and request revision to reuse or explain why additional work is needed; matching population/outcomes alone is not proof it answers a comparative need.

verdict is "keep" when the tactic is sound, "revise" when a specific change would make it sound, and "drop" when it cannot credibly contribute. confidence is a non-probabilistic 0–100 review rating, not a probability of success. note is actionable: name the field, what is wrong and what it should become; for "keep" say briefly why it holds. issues is a short list of machine-readable defect tags (for example "comparator", "duration", "duplicate"); empty for "keep".

Review every tactic you are given.

Return JSON only: {"reviews":[{"id":"","verdict":"keep","confidence":0,"note":"","issues":[],"duplicate_of":null,${REFERENCE_EXAMPLE}}]}`;

const JUDGE_SYSTEM = `You are the judge for proposed evidence tactics in a pharma Integrated Evidence Generation Plan. The user will review the tactics you keep.

Compare relevant reuse, expansion and new alternatives by their additional contribution toward the remaining need, evidence quality, incremental cost/effort, timing and feasibility; use the full target library status/design. For each gap, decide for every candidate tactic whether to accept or reject it, using the gap, the design and the critic's last review. Accept at most max_per_gap tactics for a gap, and only tactics you would put in front of the evidence team; accepting fewer, or none, is right when the candidates are weak. Rank the accepted tactics 1, 2, … in order of preference. confidence is a non-probabilistic 0–100 review rating, not a probability of success. reason says why it was kept or rejected, in one or two sentences.

Return decisions only for entries in candidates. On retry, use accepted_ranks to avoid reusing a rank. Entries in completed_candidates contain fixed decisions from earlier calls. Use those decisions alongside the new decisions when assessing the gap outcome. When outcome_requested is true, include an outcome object with status options, no_credible_option or no_timely_option and an explicit explanation. Preserve the required checks for conditional options. If all credible options are late, state that the evidence need remains unresolved by the deadline.

Return JSON only: {"gaps":[{"gap_id":"","outcome":{"status":"options","explanation":""},"decisions":[{"id":"","verdict":"accept","rank":1,"confidence":0,"reason":"",${REFERENCE_EXAMPLE}}]}]}`;

/** Same reasoning safeguards apply during generation, revision, criticism and judgement. */
const RECOMMENDATION_CONTRACT = `The per-gap brief is sourced context, not a new assessment. S4 recorded coverage remains authoritative: never close the gap or overwrite coverage. Keep missing/conflicting requirements explicit; a planning comparator is not a confirmed requirement. Any suggested requirement requires human confirmation. Separate studies cannot silently become comparative evidence; explain methodological feasibility and comparator availability/design compatibility checks. Surface apparent disagreement with recorded coverage as coverage_discrepancy, preserving the assessment and making the option conditional on review. Judge additional contribution toward the remaining need, not generic scientific plausibility. Unknown feasibility must remain conditional with required checks. Never silently relax evidence_needed_by or imply planned output is available today. Ratings are non-probabilistic review ratings.
Every currently generated tactic must contain contract_version:2 and recommendation:{remaining_need:"meaningful remaining need",incremental_contribution:"specific added contribution, or review of unchanged output for reuse",alternatives_rationale:"why preferable to relevant alternatives",feasibility:{status:"credible|conditional|infeasible|unknown",required_checks:["specific unresolved checks"]},coverage_discrepancy:null,deadline:{status:"timely|conditional|late|unknown",explanation:"relation to the recorded evidence deadline and limitations"}}. If a discrepancy exists, coverage_discrepancy is an explanation and required_checks must include its review. Conditional/unknown feasibility requires nonempty required_checks. The critic and judge must explicitly assess these fields and preserve unresolved checks; reject or revise unsupported claims rather than filling in missing facts.`;

const REMEDY = "run ideation again or switch the S9 route in /admin/control.";

/**
 * Test stub only. These fixed designs stand in for the model when
 * SYNAPSE_TEST_STUB_LLM is set, and every one is labelled as test output; they
 * are never a production fallback.
 */
const STUB_TIMING = "Test stub: fixed playbook timing, no model was called.";

const PLAYBOOK: Partial<Record<EvidenceDomain, { type: TacticType; design: Design }[]>> = {
  comparative_effectiveness: [
    {
      type: "itc",
      design: {
        population: "Licensed indication population matched across trials",
        comparator: "Regional standard of care",
        outcomes: "PFS, OS, response",
        data_source: "Published trial data plus internal IPD",
        study_design: "Indirect treatment comparison (anchored where a common comparator exists)",
        duration_months: 6,
        readout_lag_months: 2,
        timing_rationale: STUB_TIMING,
      },
    },
    {
      type: "rwe_study",
      design: {
        population: "Treated patients in routine care",
        comparator: "Physician's-choice standard of care",
        outcomes: "Time to next treatment, OS",
        data_source: "Multi-country EMR / claims",
        study_design: "Retrospective comparative cohort with propensity weighting",
        duration_months: 12,
        readout_lag_months: 3,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
  economics: [
    {
      type: "cea",
      design: {
        population: "Reimbursement-relevant population",
        comparator: "Standard of care",
        outcomes: "Incremental cost per QALY",
        data_source: "Trial efficacy, national unit costs",
        study_design: "Partitioned-survival cost-effectiveness model",
        duration_months: 8,
        readout_lag_months: 1,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
  budget_impact: [
    {
      type: "budget_impact_model",
      design: {
        population: "Eligible national cohort",
        comparator: "Current treatment mix",
        outcomes: "Net budget impact over 3 years",
        data_source: "Epidemiology, price and uptake assumptions",
        study_design: "Budget-impact model with payer-configurable inputs",
        duration_months: 5,
        readout_lag_months: 1,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
  hcru: [
    {
      type: "hcru_study",
      design: {
        population: "Patients on therapy in routine care",
        comparator: "Pre-treatment period / standard of care",
        outcomes: "Hospitalisations, ED visits, outpatient contacts",
        data_source: "Claims database",
        study_design: "Retrospective HCRU analysis",
        duration_months: 9,
        readout_lag_months: 2,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
  qol_pro: [
    {
      type: "pro_study",
      design: {
        population: "Patients receiving therapy",
        comparator: "Baseline and standard of care arm",
        outcomes: "EORTC QLQ-C30, EQ-5D-5L",
        data_source: "Prospective PRO collection",
        study_design: "Prospective observational PRO study",
        duration_months: 14,
        readout_lag_months: 3,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
  treatment_patterns: [
    {
      type: "chart_review",
      design: {
        population: "Consecutive treated patients at participating sites",
        comparator: "None (descriptive)",
        outcomes: "Sequencing, duration, discontinuation reasons",
        data_source: "Site chart abstraction",
        study_design: "Multi-site retrospective chart review",
        duration_months: 7,
        readout_lag_months: 2,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
  safety: [
    {
      type: "long_term_followup",
      design: {
        population: "Trial-exposed patients",
        comparator: "Historical safety benchmark",
        outcomes: "Long-term adverse events of special interest",
        data_source: "Extension study and registry linkage",
        study_design: "Long-term follow-up cohort",
        duration_months: 24,
        readout_lag_months: 4,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
  subpopulations: [
    {
      type: "subgroup_analysis",
      design: {
        population: "Subgroup of interest (e.g. ≥65 years)",
        comparator: "Overall trial population",
        outcomes: "Efficacy and safety within the subgroup",
        data_source: "Existing trial dataset",
        study_design: "Pre-specified secondary subgroup analysis",
        duration_months: 4,
        readout_lag_months: 1,
        timing_rationale: STUB_TIMING,
      },
    },
  ],
};

const FALLBACK: { type: TacticType; design: Design }[] = [
  {
    type: "rwe_study",
    design: {
      population: "Population described in the gap",
      comparator: "Standard of care where the gap is comparative",
      outcomes: "Outcomes named in the gap statement",
      data_source: "Real-world data source to be selected",
      study_design: "Retrospective observational cohort",
      duration_months: 10,
      readout_lag_months: 3,
      timing_rationale: STUB_TIMING,
    },
  },
  {
    type: "slr",
    design: {
      population: "Indication population",
      comparator: "All relevant comparators in the literature",
      outcomes: "Outcomes named in the gap statement",
      data_source: "Published literature",
      study_design: "Systematic literature review with evidence-gap table",
      duration_months: 4,
      readout_lag_months: 1,
      timing_rationale: STUB_TIMING,
    },
  },
];

/** Test stub proposer: the fixed playbook for each gap's domain, labelled as such. */
function stubProposals(args: { gaps: IdeationGap[]; perGap: number }): Proposal[] {
  if (!isTestStub()) throw new NoRouteError("Ideation has no rule-based fallback.");
  const out: Proposal[] = [];
  for (const gap of args.gaps) {
    const playbook = PLAYBOOK[gap.domain] ?? FALLBACK;
    for (const entry of [...playbook, ...FALLBACK].slice(0, args.perGap)) {
      out.push({
        proposal_kind: "new", target_tactic_id: null, expansion_scope: null, comparative_rationale: "Test stub: no model comparison.",
        supporting_context_basis: gap.supporting_context_basis,
        recommendation: {
          remaining_need: gap.statement,
          incremental_contribution: "Test stub: illustrative additional work; no scientific inference was made.",
          alternatives_rationale: "Test stub: relevant existing output must be reviewed before commissioning additional work.",
          feasibility: {status: "unknown", required_checks: ["Test stub: confirm requirements, comparator compatibility, data availability and recorded coverage before use."]},
          coverage_discrepancy: null,
          deadline: {status: "unknown", explanation: "Test stub: no evidence deadline feasibility judgement was made."},
        },
        references: [{ entity_type: "gap", entity_id: gap.id, reason: "Test fixture: the supplied gap defines the evidence need; no model was called." }],
        id: `${gap.id}-${entry.type}`,
        gap_id: gap.id,
        name: `${entry.type.replaceAll("_", " ")} for ${gap.name}`,
        type: entry.type,
        evidence_question: gap.statement,
        rationale: `Test stub: fixed ${gap.domain.replaceAll("_", " ")} playbook design; no model was called.`,
        design: entry.design,
        score: 50,
        critic_note: "",
        judge_note: "",
        rank: null,
      });
    }
  }
  return out;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Checks one tactic from the model. Returns what is wrong with it, so the model
 * can be asked again; nothing is filled in on its behalf.
 */
function parseTactic(raw: Record<string, unknown>, library: LibraryTactic[], supplied: ReturnType<typeof suppliedJudgementRecords>): { tactic: Omit<Proposal, "id" | "gap_id" | "score" | "critic_note" | "judge_note" | "rank"> } | { problem: string } {
  const problems: string[] = [];
  const references = inspectSuppliedJudgementReferences(supplied, raw.references);
  if (!references.length) problems.push("Supporting references must identify supplied records and the claims they support");
  const type = text(raw.type);
  if (!TACTIC_TYPES.includes(type as TacticType)) problems.push(`type "${type}" is not one of the allowed types`);
  const fields = {
    name: text(raw.name),
    evidence_question: text(raw.evidence_question),
    rationale: text(raw.rationale),
    population: text(raw.population),
    comparator: text(raw.comparator),
    outcomes: text(raw.outcomes),
    data_source: text(raw.data_source),
    study_design: text(raw.study_design),
    timing_rationale: text(raw.timing_rationale),
  };
  const empty = Object.entries(fields)
    .filter(([key, value]) => !value && !(raw.proposal_kind === "reuse" && ["evidence_question", "population", "comparator", "outcomes", "data_source", "study_design"].includes(key)))
    .map(([key]) => key);
  if (empty.length > 0) problems.push(`missing ${empty.join(", ")}`);
  if (!finite(raw.duration_months) || raw.duration_months <= 0) {
    problems.push("duration_months must be a positive number of months");
  }
  if (!finite(raw.readout_lag_months) || raw.readout_lag_months < 0) {
    problems.push("readout_lag_months must be zero or a positive number of months");
  }
  if (!text(raw.comparative_rationale)) problems.push("comparative_rationale must explicitly compare expansion and new alternatives for quality, time/cost and feasibility");
  const recommendationResult = ideationRecommendationSchema.safeParse(raw.recommendation);
  if (!recommendationResult.success) problems.push("recommendation must explain remaining need, incremental contribution, alternatives, feasibility checks, coverage discrepancy and deadline");
  if (raw.contract_version !== 2) problems.push("contract_version must be 2");
  const kind = raw.proposal_kind;
  let scope: ExpansionScope | null = null;
  const target = typeof raw.target_tactic_id === "string" ? raw.target_tactic_id : null;
  if (raw.target_tactic_id !== null && typeof raw.target_tactic_id !== "string") problems.push("target_tactic_id must explicitly be a string or null");
  if (kind !== "new" && kind !== "expansion" && kind !== "reuse") problems.push("proposal_kind must be new, expansion or reuse");
  if (kind === "reuse") {
    const existing = library.find(tactic => tactic.id === target);
    if (!existing || existing.review_status !== "accepted" || existing.status === "cancelled") problems.push("Reuse requires an existing eligible accepted tactic");
    if (existing && (type !== existing.type || (["evidence_question", "population", "comparator", "outcomes", "data_source", "study_design"] as const).some(key => fields[key] !== existing[key].trim()))) problems.push("Reuse must preserve the target's recorded design and question unchanged; added analysis or changed scope is expansion");
    if (raw.expansion_scope !== null) problems.push("Reuse adds no work and cannot carry expansion scope; new analysis is expansion");
  }
  if (kind === "new" && (raw.target_tactic_id !== null || raw.expansion_scope !== null)) problems.push("New tactics cannot carry expansion target or scope");
  if (kind === "expansion") {
    try {
      if (!target?.trim()) throw new TrustedApplicationError("Expansion requires an explicit nonempty target_tactic_id");
      scope = expansionScopeSchema.parse(modelExpansionScope(raw.expansion_scope));
      assertExpansionDesign({name: fields.name, evidence_question: fields.evidence_question, type, design: fields}, scope);
      validateExpansion(library.find(t => t.id === target), scope, text(raw.comparative_rationale));
    } catch (error) { problems.push(error instanceof Error ? error.message : "Invalid expansion"); }
  }
  if (problems.length > 0) return { problem: problems.join("; ") };
  return {
    tactic: {
      references: references.map(({ entity_type, entity_id, reason }) => ({ entity_type, entity_id, reason })),
      proposal_kind: kind as "new" | "expansion" | "reuse", target_tactic_id: target, expansion_scope: scope, comparative_rationale: text(raw.comparative_rationale),
      ...(recommendationResult.success ? { recommendation: recommendationResult.data } : {}),
      name: fields.name,
      type,
      evidence_question: fields.evidence_question,
      rationale: fields.rationale,
      design: {
        population: fields.population,
        comparator: fields.comparator,
        outcomes: fields.outcomes,
        data_source: fields.data_source,
        study_design: fields.study_design,
        duration_months: raw.duration_months as number,
        readout_lag_months: raw.readout_lag_months as number,
        timing_rationale: fields.timing_rationale,
      },
    },
  };
}

type PromptGap = IdeationGap & {
  supporting_records?: ReturnType<typeof suppliedJudgementRecords>;
  /** Tactics the critic asked to have revised, with its objection. */
  revise?: { id: string; previous: Omit<Proposal, "score" | "critic_note" | "judge_note" | "rank">; objection: string }[];
  /** What was wrong with the model's last answer for this gap. */
  problems?: string[];
  /** Stable anonymous output positions assigned before generation; contain no human answers. */
  proposal_slots?: string[];
  repair_slots?: string[];
  outcome_requested?: boolean;
};

/**
 * Gaps per proposer call, tactics per critic call and gaps per judge call. Asking
 * for every High gap in one reply runs past the output budget (KAN-66), so each
 * step asks in slices, in parallel. The proposer asks one gap at a time: a
 * revision round restates each design with the critic's objection, and two gaps'
 * worth ran past the 16k output budget on Claude (KAN-148).
 */
export const PROPOSER_GAPS_PER_CALL = 1;
export const CRITIC_TACTICS_PER_CALL = 4;
export const JUDGE_GAPS_PER_CALL = 2;

/** Runs `ask` on consecutive slices of `items` in parallel and returns every answer. */
async function inBatches<T, R>(items: T[], size: number, ask: (slice: T[]) => Promise<R>): Promise<R[]> {
  const slices: T[][] = [];
  for (let i = 0; i < items.length; i += size) slices.push(items.slice(i, i + size));
  return Promise.all(slices.map(ask));
}

async function askProposer(
  ctx: ModuleContext,
  args: { gaps: PromptGap[]; perGap: number; hints: string; library: LibraryTactic[]; round: number; plan?: unknown },
): Promise<{ gaps: PromptGap[]; response: unknown }[]> {
  return inBatches(args.gaps, PROPOSER_GAPS_PER_CALL, async (gaps) => ({
    gaps,
    response: await ctx.complete({
      system: `${IDEATION_SYSTEM}
${SUPPORT_CONTRACT}
${EXPANSION_CONTRACT}
${RECOMMENDATION_CONTRACT}
Use only the supplied proposal_slots or revise ids, once each. Leave slots unused initially when fewer useful options exist. When repair_slots is supplied, answer each of those slots and keep its id. When outcome_requested is true, return one valid gap_outcomes entry for that gap with an explanation. When neither proposal_slots nor revise ids are supplied, return an empty tactics list. Never invent an id.`,
      user: JSON.stringify({
        worked_examples: args.hints || undefined,
        exchange: args.round === 1 ? undefined : `${args.round - 1} of ${PROPOSER_CRITIC_EXCHANGES}`,
        candidates_per_gap: args.perGap,
        plan_context: args.plan,
        library: args.library,
        gaps,
      }),
      purpose: "ideation-proposer",
    }),
  }));
}

type Review = { references: JudgementReference[]; verdict: Critique["verdict"]; confidence: number; note: string; issues: string[]; duplicate_of: string | null };
type Decision = { references: JudgementReference[]; verdict: "accept" | "reject"; rank: number | null; confidence: number; reason: string };

const promptTactic = (proposal: Proposal) => ({
  references: proposal.references,
  recommendation: proposal.recommendation,
  supporting_context_basis: proposal.supporting_context_basis,
  id: proposal.id,
  gap_id: proposal.gap_id,
  name: proposal.name,
  type: proposal.type,
  evidence_question: proposal.evidence_question,
  rationale: proposal.rationale,
  design: proposal.design,
  proposal_kind: proposal.proposal_kind, target_tactic_id: proposal.target_tactic_id, expansion_scope: proposal.expansion_scope, comparative_rationale: proposal.comparative_rationale,
});

export const ideationModule: SynapseModule<IdeationInput, IdeationOutput> = {
  manifest: {
    id: "s9-ideation.pcj",
    stage: "S9",
    version: "2.3.0",
    title: "Tactics ideation (proposer → critic → judge)",
    summary:
      "A model compares unchanged reuse, expansions and new tactics, including feasibility checks and evidence deadlines, for open gaps whose priority a human validated as High; a model critic challenges them against the gap and the tactic library over three exchanges; a model judge keeps and ranks up to the per-gap cap. Needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "llm-critic", "llm-judge", "per-gap-cap"],
  },
  inputSchema,
  outputSchema,
  freeze: freezeFacts,
  async run(input, ctx) {
    requireLlm(ctx, "Ideation");
    const frozen = (ctx.replay?.facts as Awaited<ReturnType<typeof freezeFacts>> | undefined) ?? await freezeFacts(input);
    const {state,placements} = frozen;
    const rejectedExpansions = new Set(frozen.rejected_expansions ?? []);
    const proposal_slots = ctx.replay?.facts.proposal_slots as Record<string, string[]> | undefined;
    const planContext = prioritizationContextFromState(state);
    // Ideation is for open gaps a human validated as High (KAN-8). Explicit gap_ids pick among them.
    const order = ideationBandOrder(placements);
    const gaps: IdeationGap[] = state.gaps
      .filter(
        (gap) =>
          isLiveGap(gap) &&
          displayedGapStatus(gap) === "validated_open" &&
          order.has(gap.id) && (!input.gap_ids?.length || input.gap_ids.includes(gap.id)),
      )
      .sort((a, b) => (order.get(a.id) ?? BAND_RANK.low + 1) - (order.get(b.id) ?? BAND_RANK.low + 1))
      .map((gap) => ({
        id: gap.id,
        name: gap.name,
        statement: gap.statement,
        domain: gap.domain,
        brief: buildIdeationGapBrief(state, gap.id, placements),
        supporting_context_basis: ideationAcceptanceBasis(state, gap.id, placements),
      }));

    if (gaps.length === 0) {
      return {
        output: { mode: isTestStub() ? "deterministic" : "llm", proposals: [], rejected: [], gaps_considered: 0, gap_outcomes: [] },
        summary: "No open gaps with human-validated High priority to ideate for",
      };
    }

    const supportFor = (gapId: string) => suppliedJudgementRecords(state, [gapId]);
    const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
    const describeGap = (id: string) => gapById.get(id)?.name ?? id;
    const library: LibraryTactic[] = state.tactics.map(tactic => ({...tactic, expansions: state.expansions.filter(child => child.tactic_id === tactic.id).map(child => ({id:child.id,status:child.status,scope:child.scope}))}));
    const libraryIds = new Set(library.map((tactic) => tactic.id));
    let reviewerHints = "";
    const report = (details: { field: string; id?: string; problem: string }) => ctx.run.note("answer:invalid", details);
    const gapSlots = (gapId: string) => proposal_slots?.[gapId] ??
      Array.from({ length: input.per_gap + 1 }, (_, index) => `${gapId}:proposal:${index + 1}`);
    const lastReview = new Map<string, Review>();
    /** The model judge's decisions on the final candidates, set after the last exchange. */
    let judgement: Map<string, Decision> | null = null;
    const gapOutcomes = new Map<string, IdeationGapOutcome>();

    /** Generate candidates by gap, retaining valid slots across repairs. */
    const propose = async (hints: string): Promise<Proposal[]> => {
      const problems = new Map<string, string>();
      const slotProblems = new Map<string, string>();
      const tacticReplyProblems = new Map<string, string>();
      const outcomeReplyProblems = new Map<string, string>();
      const accepted = new Map<string, Proposal>();
      const byGap = await completeAll<Proposal[]>({
        ids: gaps.map((gap) => gap.id),
        what: "set of tactic designs",
        describe: describeGap,
        problems,
        remedy: REMEDY,
        ask: async (missing) => {
          const answers = await askProposer(ctx, {
            plan: planContext,
            hints,
            perGap: input.per_gap + 1,
            library,
            round: 1,
            gaps: missing.map((id) => {
              const slots = gapSlots(id);
              const repair = slots.filter(slot => slotProblems.has(slot));
              const outcome = gapOutcomes.get(id);
              const outcomeRequested = outcomeReplyProblems.has(id);
              const needsOptions = !slots.some(slot => accepted.has(slot)) && (!outcome || outcome.status === "options");
              const openSlots = slots.filter(slot => !accepted.has(slot));
              return {
                ...gapById.get(id)!,
                supporting_records: supportFor(id),
                problems: problems.has(id) ? [problems.get(id)!] : undefined,
                proposal_slots: repair.length ? repair : tacticReplyProblems.has(id) || (needsOptions && !outcomeRequested) ? openSlots : [],
                ...(repair.length ? { repair_slots: repair } : {}),
                ...(outcomeRequested ? { outcome_requested: true } : {}),
              };
            }),
          });
          const complete = new Map<string, Proposal[]>();
          for (const { gaps: asked, response } of answers) {
            const gap = asked[0]!;
            const slots = gap.proposal_slots!;
            const raw = response as { tactics?: Record<string, unknown>[]; gap_outcomes?: unknown } | null;
            if (!Array.isArray(raw?.tactics)) {
              const problem = "tactics must be a list, even if it is empty.";
              tacticReplyProblems.set(gap.id, problem);
              report({ field: "tactics", id: gap.id, problem });
            } else {
              tacticReplyProblems.delete(gap.id);
              const returned = new Set(raw.tactics.map(row => text(row?.id)));
              const unidentified: string[] = [];
              const rows = modelRows({ payload: raw, field: "tactics", idField: "id", ids: slots, problems: slotProblems, report: details => {
                unidentified.push(details.id ? `${details.id}: ${details.problem}` : details.problem);
                report({ ...details, id: details.id ?? gap.id });
              } });
              const omitted = slots.filter(slot => !returned.has(slot));
              // Unused optional slots are valid unless a malformed row needs a target.
              for (const slot of omitted) if (!gap.repair_slots?.includes(slot)) slotProblems.delete(slot);
              for (const [id, row] of rows) {
                const parsed = parseTactic(row, library, supportFor(gap.id));
                const problem = row.gap_id !== gap.id ? "gap_id must match the gap offered for this slot."
                  : row.withdraw === true ? "A proposal slot requires a tactic, or omit the slot initially."
                  : "problem" in parsed ? parsed.problem : undefined;
                if (problem) {
                  slotProblems.set(id, problem);
                  report({ field: "tactics", id, problem });
                } else if ("tactic" in parsed) {
                  accepted.set(id, { ...parsed.tactic, id, gap_id: gap.id, supporting_context_basis: gap.supporting_context_basis, score: 0, critic_note: "", judge_note: "", rank: null });
                }
              }
              for (const [index, problem] of unidentified.entries()) {
                const slot = omitted[index];
                if (slot) slotProblems.set(slot, `Unidentified tactic row (${problem}); use the offered id.`);
              }
              const excess = unidentified.slice(omitted.length);
              if (excess.length) tacticReplyProblems.set(gap.id, `Discard extra tactic rows (${excess.join("; ")}).`);
            }

            const outcomeOffered = raw?.gap_outcomes !== undefined && !(Array.isArray(raw.gap_outcomes) && raw.gap_outcomes.length === 0);
            if (gap.outcome_requested || (!gapOutcomes.has(gap.id) && outcomeOffered)) {
              const outcomeProblems = new Map<string, string>();
              const unexpected: string[] = [];
              const outcome = modelRows({ payload: raw, field: "gap_outcomes", idField: "gap_id", ids: [gap.id], problems: outcomeProblems, report: details => {
                unexpected.push(details.id ? `${details.id}: ${details.problem}` : details.problem);
                report({ ...details, id: details.id ?? gap.id });
              } }).get(gap.id);
              const parsed = ideationGapOutcomeSchema.safeParse(outcome);
              if (parsed.success && unexpected.length === 0) {
                gapOutcomes.set(gap.id, parsed.data);
                outcomeReplyProblems.delete(gap.id);
              } else {
                const problem = unexpected.join("; ") || outcomeProblems.get(gap.id) || "Return a valid gap outcome status and explanation.";
                outcomeReplyProblems.set(gap.id, problem);
                report({ field: "gap_outcomes", id: gap.id, problem });
              }
            }
            const allSlots = gapSlots(gap.id);
            const invalid = allSlots.flatMap(slot => slotProblems.has(slot) ? [`${slot}: ${slotProblems.get(slot)}`] : []);
            const tacticReplyProblem = tacticReplyProblems.get(gap.id);
            const outcomeReplyProblem = outcomeReplyProblems.get(gap.id);
            if (tacticReplyProblem) invalid.push(tacticReplyProblem);
            if (outcomeReplyProblem) invalid.push(outcomeReplyProblem);
            const found = allSlots.flatMap(slot => accepted.has(slot) ? [accepted.get(slot)!] : []);
            const outcome = gapOutcomes.get(gap.id);
            if (invalid.length) problems.set(gap.id, invalid.join(" "));
            else if (found.length || (outcome && outcome.status !== "options")) complete.set(gap.id, found);
            else problems.set(gap.id, "Return candidates or an explicit no_credible_option/no_timely_option outcome explaining the unresolved need.");
          }
          return complete;
        },
      });
      return gaps.flatMap((gap) => byGap.get(gap.id)!);
    };

    /** Rounds 2–4: the model answers each "revise" with a revised tactic or a withdrawal. */
    const revise = async (hints: string, round: number, previous: Proposal[], critiques: Critique[]): Promise<Proposal[]> => {
      const objections = new Map(
        critiques.filter((critique) => critique.verdict === "revise").map((critique) => [critique.subject, critique.note]),
      );
      const dropped = new Set(critiques.filter((critique) => critique.verdict === "drop").map((c) => c.subject));
      const byId = new Map(previous.map((proposal) => [proposal.id, proposal]));
      const problems = new Map<string, string>();
      const revisionOutcomes = new Map<string, IdeationGapOutcome>();
      const answers = await completeAll<Proposal | "withdrawn">({
        ids: [...objections.keys()].filter((id) => byId.has(id)),
        what: "revision",
        problems,
        describe: (id) => byId.get(id)?.name ?? id,
        remedy: REMEDY,
        ask: async (missing) => {
          const targets = missing.map((id) => byId.get(id)!);
          const answers = await askProposer(ctx, {
            plan: planContext,
            hints,
            perGap: input.per_gap,
            library,
            round,
            gaps: [...new Set(targets.map((proposal) => proposal.gap_id))].map((gapId) => ({
              ...gapById.get(gapId)!,
              supporting_records: supportFor(gapId),
              revise: targets
                .filter((proposal) => proposal.gap_id === gapId)
                .map((proposal) => ({ id: proposal.id, previous: promptTactic(proposal), objection: objections.get(proposal.id)! })),
              problems: targets
                .filter((proposal) => proposal.gap_id === gapId && problems.has(proposal.id))
                .map((proposal) => `${proposal.id}: ${problems.get(proposal.id)}`),
            })),
          });
          const done = new Map<string, Proposal | "withdrawn">();
          for (const { gaps: asked, response } of answers) {
            const ids = asked.flatMap(gap => (gap.revise ?? []).map(row => row.id));
            for (const [id, raw] of modelRows({ payload: response, field: "tactics", idField: "id", ids, problems, report })) {
              const before = byId.get(id)!;
              if (raw.gap_id !== before.gap_id) {
                problems.set(id, "gap_id must match the requested revision.");
                continue;
              }
              if (raw.withdraw === true) {
                if (!text(raw.withdraw_reason)) problems.set(id, "withdraw_reason is required when withdrawing a tactic.");
                else done.set(id, "withdrawn");
                continue;
              }
              const parsed = parseTactic(raw, library, supportFor(before.gap_id));
              if ("problem" in parsed) problems.set(id, parsed.problem);
              else done.set(id, { ...before, ...parsed.tactic });
            }
            const outcomes = response && typeof response === "object" && "gap_outcomes" in response ? response.gap_outcomes : undefined;
            if (outcomes === undefined || (Array.isArray(outcomes) && !outcomes.length)) continue;
            const outcomeProblems = new Map<string, string>();
            const rows = modelRows({
              payload: response, field: "gap_outcomes", idField: "gap_id", ids: asked.map(gap => gap.id), problems: outcomeProblems, report,
            });
            for (const [gapId, raw] of rows) {
              const parsed = ideationGapOutcomeSchema.safeParse({ ...raw, gap_id: gapId });
              if (parsed.success) {
                if (parsed.data.status !== "options" && !revisionOutcomes.has(gapId)) revisionOutcomes.set(gapId, parsed.data);
              } else outcomeProblems.set(gapId, "Return a valid gap outcome status and explanation.");
            }
            for (const [id, problem] of outcomeProblems) report({ field: "gap_outcomes", id, problem });
          }
          return done;
        },
      });
      // A tactic the critic dropped, or the proposer withdrew, leaves the dialogue.
      const next = previous.flatMap((proposal) => {
        if (dropped.has(proposal.id)) return [];
        const answer = answers.get(proposal.id);
        if (answer === "withdrawn") return [];
        return [answer ?? proposal];
      });
      const remaining = new Set(next.map(proposal => proposal.gap_id));
      for (const [id, answer] of answers) {
        if (answer !== "withdrawn") continue;
        const gapId = byId.get(id)!.gap_id;
        const revisionOutcome = revisionOutcomes.get(gapId);
        if (revisionOutcome && !remaining.has(gapId)) gapOutcomes.set(gapId, revisionOutcome);
      }
      return next;
    };

    /** Judge individual candidates and gap outcomes without replacing completed decisions. */
    const judgeWithModel = async (candidates: Proposal[]): Promise<Map<string, Decision>> => {
      const decisions = new Map<string, Decision>();
      const gapIds = [...new Set(candidates.map(proposal => proposal.gap_id))];
      const outcomeKey = (gapId: string) => `outcome:${gapId}`;
      const byId = new Map(candidates.map(proposal => [proposal.id, proposal]));
      const problems = new Map<string, string>();
      await completeAll<true>({
        ids: [...byId.keys(), ...gapIds.map(outcomeKey)],
        what: "judgement",
        describe: id => byId.get(id)?.name ?? describeGap(id.slice("outcome:".length)),
        problems,
        remedy: REMEDY,
        ask: async (missing) => {
          const done = new Map<string, true>();
          const missingSet = new Set(missing);
          const pendingGaps = gapIds.filter(gapId => missingSet.has(outcomeKey(gapId)) ||
            candidates.some(proposal => proposal.gap_id === gapId && missingSet.has(proposal.id)));
          await inBatches(pendingGaps, JUDGE_GAPS_PER_CALL, async (batch) => {
            const requested = (gapId: string) => candidates.filter(proposal => proposal.gap_id === gapId && missingSet.has(proposal.id));
            const acceptedRanks = (gapId: string) => new Set(candidates
              .filter(proposal => proposal.gap_id === gapId)
              .flatMap(proposal => decisions.get(proposal.id)?.rank ?? []));
            const completedCandidates = (gapId: string) => candidates.flatMap(proposal => {
              const decision = decisions.get(proposal.id);
              return proposal.gap_id === gapId && decision ? [{ ...promptTactic(proposal), decision }] : [];
            });
            const payload = await ctx.complete({
              system: `${JUDGE_SYSTEM}
${SUPPORT_CONTRACT}
${RECOMMENDATION_CONTRACT}`,
              user: JSON.stringify({
                worked_examples: reviewerHints || undefined,
                max_per_gap: input.per_gap,
                library,
                gaps: batch.map(gapId => ({
                  ...gapById.get(gapId)!,
                  supporting_records: supportFor(gapId),
                  outcome_requested: missingSet.has(outcomeKey(gapId)),
                  accepted_ranks: [...acceptedRanks(gapId)],
                  completed_candidates: completedCandidates(gapId),
                  problem: [problems.get(outcomeKey(gapId)), ...requested(gapId).map(proposal => problems.get(proposal.id))].filter(Boolean).join(" ") || undefined,
                  candidates: requested(gapId).map(proposal => {
                    const review = lastReview.get(proposal.id);
                    return {
                      ...promptTactic(proposal),
                      critic: review ? { verdict: review.verdict, confidence: review.confidence, note: review.note } : undefined,
                    };
                  }),
                })),
              }),
              purpose: "ideation-judge",
            });
            const gapProblems = new Map<string, string>();
            const rows = modelRows({ payload, field: "gaps", idField: "gap_id", ids: batch, problems: gapProblems, report });
            for (const gapId of batch) {
              const row = rows.get(gapId);
              const outcomeId = outcomeKey(gapId);
              const ids = requested(gapId).map(proposal => proposal.id);
              if (!row) {
                const problem = gapProblems.get(gapId)!;
                for (const id of [...ids, ...(missingSet.has(outcomeId) ? [outcomeId] : [])]) problems.set(id, problem);
                continue;
              }
              const ranks = acceptedRanks(gapId);
              for (const [id, raw] of modelRows({ payload: row, field: "decisions", idField: "id", ids, problems, report })) {
                const reason = text(raw.reason);
                const references = inspectSuppliedJudgementReferences(supportFor(gapId), raw.references);
                const rank = raw.verdict === "accept" && finite(raw.rank) ? raw.rank : null;
                if (!references.length) problems.set(id, "Supporting references must cite only supplied records for this gap.");
                else if (!reason || !finite(raw.confidence) || (raw.verdict !== "accept" && raw.verdict !== "reject")) {
                  problems.set(id, "Return a verdict, confidence and reason for this candidate.");
                } else if (raw.verdict === "accept" && (rank === null || !Number.isInteger(rank) || rank < 1 || rank > input.per_gap || ranks.has(rank))) {
                  problems.set(id, `Use a unique integer rank from 1 to ${input.per_gap}; accept at most ${input.per_gap} candidates per gap.`);
                } else {
                  if (rank !== null) ranks.add(rank);
                  decisions.set(id, {
                    references: references.map(({ entity_type, entity_id, reason }) => ({ entity_type, entity_id, reason })),
                    verdict: raw.verdict,
                    rank,
                    confidence: Math.max(0, Math.min(100, Math.round(raw.confidence))),
                    reason,
                  });
                  done.set(id, true);
                }
              }
              if (!missingSet.has(outcomeId)) continue;
              // The gap outcome describes the whole judgement, so it needs all candidate decisions.
              if (ids.some(id => !done.has(id))) {
                problems.set(outcomeId, "Return the gap outcome together with the remaining candidate decisions.");
                continue;
              }
              const value = row.outcome;
              const parsed = ideationGapOutcomeSchema.safeParse(value && typeof value === "object" ? { ...value, gap_id: gapId } : null);
              if (parsed.success) {
                gapOutcomes.set(gapId, parsed.data);
                problems.delete(outcomeId);
                done.set(outcomeId, true);
              } else problems.set(outcomeId, "Return an outcome with a valid status and explanation.");
            }
          });
          return done;
        },
      });
      return decisions;
    };

    const outcome = await runAgenticCycle<Proposal>(ctx, "S9", {
      subjectOf: (proposal) => proposal.id,
      proposer: {
        /**
         * Test stub only: the kernel calls this when SYNAPSE_TEST_STUB_LLM is set
         * and never otherwise. Revisions keep the fixed designs unchanged.
         */
        local: ({ round, previous }) => (round === 1 ? stubProposals({ gaps, perGap: input.per_gap }) : previous),
        llm: async ({ hints, round, critiques, previous }) => {
          reviewerHints = hints;
          const next = round === 1 ? await propose(hints) : await revise(hints, round, previous, critiques);
          // After the last exchange the final set is fixed, so the model judge rules on it here.
          if (round === PROPOSER_CRITIC_EXCHANGES + 1) {
            judgement = await ctx.run.step("judge:model", () => judgeWithModel(next), `${next.length} candidate(s) to judge`);
          }
          return next;
        },
      },
      critic: async (proposals, round) => {
        if (isTestStub()) {
          return proposals.map((proposal) => ({
            subject: proposal.id,
            verdict: "keep" as const,
            note: "Test stub: no model critic was called.",
            score: 50,
          }));
        }
        const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
        const problems = new Map<string, string>();
        const reviews = await completeAll<Review>({
          ids: proposals.map((proposal) => proposal.id),
          what: "review",
          describe: (id) => byId.get(id)?.name ?? id,
          problems,
          remedy: REMEDY,
          ask: async (missingAll) => {
            const map = new Map<string, Review>();
            await inBatches(missingAll, CRITIC_TACTICS_PER_CALL, async (missing) => {
              const payload = await ctx.complete({
                system: `${CRITIC_SYSTEM}
${SUPPORT_CONTRACT}
${EXPANSION_CONTRACT}
${RECOMMENDATION_CONTRACT}`,
                user: JSON.stringify({
                  worked_examples: reviewerHints || undefined,
                  exchange: `${round} of ${PROPOSER_CRITIC_EXCHANGES}`,
                  library,
                  tactics: missing.map((id) => {
                    const proposal = byId.get(id)!;
                    const gap = gapById.get(proposal.gap_id)!;
                    return { ...promptTactic(proposal), problem: problems.get(id), gap: { ...gap, supporting_records: supportFor(gap.id) } };
                  }),
                }),
                purpose: "ideation-critic",
              });
              for (const [id, row] of modelRows({ payload, field: "reviews", idField: "id", ids: missing, problems, report })) {
                const note = text(row.note);
                const duplicate = row.duplicate_of == null || row.duplicate_of === "" ? null : text(row.duplicate_of);
                const references = inspectSuppliedJudgementReferences(supportFor(byId.get(id)!.gap_id), row.references);
                if (!references.length) problems.set(id, "Supporting references must cite only supplied records for this gap.");
                else if (duplicate !== null && !libraryIds.has(duplicate)) problems.set(id, "duplicate_of must identify a tactic supplied in the library.");
                else if (!finite(row.confidence) || !note || (row.verdict !== "keep" && row.verdict !== "revise" && row.verdict !== "drop")) {
                  problems.set(id, "Return a verdict, confidence and actionable note for this review.");
                } else {
                  map.set(id, {
                    references: references.map(({ entity_type, entity_id, reason }) => ({ entity_type, entity_id, reason })),
                    verdict: row.verdict,
                    confidence: Math.max(0, Math.min(100, Math.round(row.confidence))),
                    note,
                    issues: Array.isArray(row.issues) ? row.issues.map(text).filter(Boolean) : [],
                    duplicate_of: duplicate,
                  });
                }
              }
            });
            return map;
          },
        });
        return proposals.map((proposal) => {
          const review = reviews.get(proposal.id)!;
          lastReview.set(proposal.id, review);
          return {
            subject: proposal.id,
            verdict: review.verdict,
            note: review.duplicate_of ? `${review.note} (duplicates library tactic ${review.duplicate_of})` : review.note,
            score: review.confidence,
            issues: review.issues,
          };
        });
      },
      /**
       * The model judge already ruled after the last exchange; this carries its
       * decisions into the kernel's shape, in its rank order per gap.
       */
      judge: ({ candidates, critiques }) => {
        const noteOf = (id: string) => critiques.find((critique) => critique.subject === id)?.note ?? "";
        if (isTestStub()) {
          const kept = new Map<string, number>();
          return candidates.map((proposal): JudgedCandidate<Proposal> => {
            const used = kept.get(proposal.gap_id) ?? 0;
            const accept = used < input.per_gap;
            if (accept) kept.set(proposal.gap_id, used + 1);
            const judge_note = "Test stub: no model judge was called.";
            return {
              candidate: { ...proposal, score: 50, critic_note: noteOf(proposal.id), judge_note, rank: accept ? used + 1 : null },
              subject: proposal.id,
              verdict: accept ? "accept" : "reject",
              score: 50,
              note: judge_note,
            };
          });
        }
        const decisions = judgement;
        if (!decisions) throw new Error(`The S9 model judge did not run; ${REMEDY}`);
        const order = (proposal: Proposal) => decisions.get(proposal.id)?.rank ?? Number.POSITIVE_INFINITY;
        const gapOrder = new Map(gaps.map((gap, index) => [gap.id, index]));
        return [...candidates]
          .sort((a, b) => (gapOrder.get(a.gap_id)! - gapOrder.get(b.gap_id)!) || order(a) - order(b))
          .map((proposal) => {
            const decision = decisions.get(proposal.id)!;
            return {
              candidate: {
                ...proposal,
                references: [...proposal.references, ...(lastReview.get(proposal.id)?.references ?? []), ...decision.references],
                score: decision.confidence,
                critic_note: noteOf(proposal.id),
                judge_note: decision.reason,
                rank: decision.rank,
              },
              subject: proposal.id,
              verdict: decision.verdict,
              score: decision.confidence,
              note: decision.reason,
            };
          });
      },
    }, { kinds: ["s9_proposal"], subject_ids: gaps.map(item => item.id), text: gaps.map((gap) => `${gap.name} ${gap.statement}`).join(" ") });

    // Hash-only rejection memory is pre-generation provenance, never human answer text.
    // Explicit restore removes that source row from the rejected set.
    outcome.accepted = outcome.accepted.filter(p => {
      if (p.proposal_kind !== "expansion" || !rejectedExpansions.has(expansionKey(p.gap_id,p.target_tactic_id,p.expansion_scope))) return true;
      outcome.withdrawn.push({subject:p.id,score:p.score,note:"Human rejection memory: restore this expansion target/scope before reconsidering it."});
      return false;
    });
    await stageWrite(ctx, async () => {
      if (!ctx.replay?.evaluation && !input.dry_run && outcome.accepted.length > 0) {
        await ensurePlatformSchema();
        for (const proposal of outcome.accepted) {
          const values = {
            proposal_kind: proposal.proposal_kind, target_tactic_id: proposal.target_tactic_id, expansion_scope: proposal.expansion_scope, comparative_rationale: proposal.comparative_rationale,
            reviewed_parent: proposal.target_tactic_id ? state.tactics.find(t => t.id === proposal.target_tactic_id) : null,
            id: newId("idea"),
            gap_id: proposal.gap_id,
            name: proposal.name,
            type: proposal.type,
            rationale: proposal.rationale,
            evidence_question: proposal.evidence_question,
            design: { ...proposal.design, recommendation: proposal.recommendation, supporting_context_basis: proposal.supporting_context_basis, write_version: newId("IPV"), supporting_references: proposal.references, supplied_records: supportFor(proposal.gap_id), rank: proposal.rank, origin: "ai", run_id: ctx.run.id,
              slot_id: proposal_slots?.[proposal.gap_id]?.includes(proposal.id) ? proposal.id : null,
              original_ai: { recommendation: proposal.recommendation, supporting_context_basis: proposal.supporting_context_basis, proposal_kind: proposal.proposal_kind, comparative_rationale: proposal.comparative_rationale, ...(proposal.proposal_kind !== "new" ? {target_tactic_id: proposal.target_tactic_id, expansion_scope: proposal.expansion_scope} : {}), name: proposal.name, type: proposal.type, rationale: proposal.rationale, evidence_question: proposal.evidence_question, design: proposal.design },
            },
            status: "proposed",
            critic_note: [proposal.critic_note, proposal.judge_note && `Judge: ${proposal.judge_note}`]
              .filter(Boolean)
              .join(" — "),
            judge_score: Math.round(proposal.score),
            created_at: nowIso(),
          };
          await db().transaction(async tx => {
            const references = inspectSuppliedJudgementReferences(supportFor(proposal.gap_id), proposal.references);
            if (!references.length || !inspectJudgementReferences(await readState(tx), [proposal.gap_id], proposal.references).length) throw new TrustedApplicationError("Supporting references are missing, inaccessible or unrelated to this option.");
            await tx.insert(t.ideationProposals).values(values);
            await recordEdit({ stage: "S9", entity_type: "ideation_proposal", entity_id: values.id,
              field: "model_suggestion", action: "add", before: null, after: JSON.stringify(proposal),
              rationale: proposal.judge_note || proposal.rationale, references: proposal.references, reference_gap_ids: [proposal.gap_id],
              actor: { name: isTestStub() ? "S9 test fixture (no model called)" : "S9 model", function: ctx.actor.function },
            }, tx);
          });
        }
      }
    });

    return {
      output: {
        mode: outcome.mode,
        proposals: outcome.accepted,
        rejected: outcome.rejected.map((item) => item.candidate),
        gaps_considered: gaps.length,
        gap_outcomes: gaps.map(gap => {
          const accepted = outcome.accepted.filter(proposal => proposal.gap_id === gap.id);
          const recorded = gapOutcomes.get(gap.id);
          if (!accepted.length) {
            if (recorded && recorded.status !== "options") return recorded;
            return {gap_id: gap.id, status: "no_credible_option" as const, explanation: "No candidate survived final review and rejection-memory checks; the evidence need remains unresolved."};
          }
          if (accepted.every(proposal => proposal.recommendation?.deadline.status === "late")) return {
            gap_id: gap.id, status: "no_timely_option" as const,
            explanation: recorded?.status === "no_timely_option" ? recorded.explanation : `No accepted option meets the evidence deadline; the need remains unresolved. Longer-term options: ${accepted.map(proposal => proposal.recommendation!.deadline.explanation).join(" ")}`,
          };
          if (recorded?.status === "no_timely_option" && !accepted.some(proposal => proposal.recommendation?.deadline.status === "timely")) return recorded;
          return recorded?.status === "options" ? recorded : {
            gap_id: gap.id, status: "options" as const,
            explanation: "Options require human review; recorded coverage remains authoritative.",
          };
        }),
        withdrawn: outcome.withdrawn.map(item => ({ slot_id: item.subject, note: item.note })),
      },
      summary: `${plural(outcome.accepted.length, "tactic proposal")} for ${plural(gaps.length, "prioritized gap")}${
        input.dry_run ? " (dry run)" : ""
      }${outcome.accepted.length === 0 ? duplicateNote(outcome) : ""}`,
      evals: [
        ...outcome.metrics,
        {
          name: "gaps_with_a_proposal",
          value:
            gaps.length === 0
              ? 0
              : Number((new Set(outcome.accepted.map((p) => p.gap_id)).size / gaps.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
      ],
    };
  },
};

ideationModule.evals = {
  async reserveGold(facts, subject_ids) {
    const source = facts as Awaited<ReturnType<typeof freezeFacts>>;
    // Old snapshots cannot acquire provenance from current proposal records.
    if (!Array.isArray(source.proposal_lineage)) return { facts, cases: [], subject_ids: [], reason: "Frozen S9 library proposal lineage is unavailable." };
    const order = ideationBandOrder(source.placements);
    const gaps = source.state.gaps.filter(gap => subject_ids.includes(gap.id) && order.has(gap.id) && isLiveGap(gap) && displayedGapStatus(gap) === "validated_open");
    const ids = gaps.map(gap => gap.id);
    const libraryIds = new Set(source.state.tactics.map(tactic => tactic.id));
    const linked = source.proposal_lineage.filter(row => row.tactic_id && libraryIds.has(row.tactic_id));
    if (linked.some(row => row.origin !== "human" && !row.run_id)) return { facts, cases: [], subject_ids: [], reason: "Frozen S9 library contains a proposal with unknown originating run." };
    const slots = Object.fromEntries(ids.map(id => [id, source.proposal_slots[id] ?? []]));
    const perGap = ids.length ? slots[ids[0]].length : 0;
    if (ids.some(id => !slots[id].length || slots[id].length !== perGap)) return { facts, cases: [], subject_ids: [], reason: "Frozen S9 gold proposal slots are incomplete." };
    const state = Object.fromEntries(Object.entries(source.state).map(([key, value]) =>
      [key, key === "gaps" ? gaps : ["asset", "objectives", "tactics"].includes(key) ? value : Array.isArray(value) ? [] : value],
    )) as typeof source.state;
    return {
      facts: { state, placements: source.placements.filter(row => ids.includes(row.gap_id)), proposal_slots: slots, proposal_lineage: linked, rejected_expansions: [] },
      subject_ids: ids, lineage_subject_ids: linked.flatMap(row => [row.subject_id, row.gap_id]),
      lineage_run_ids: linked.flatMap(row => row.run_id ? [row.run_id] : []),
      // Existing coverage/design ratios use only these withheld gaps/proposals.
      cases: ids.length ? [{ name: "heldout-prioritized-gaps", input: { gap_ids: ids, per_gap: perGap, dry_run: true } }] : [],
    };
  },
  async cases() {
    return [{ name: "prioritized-open-gaps", input: { per_gap: 2, dry_run: true } }];
  },
  score({ output }) {
    const proposals = output.proposals;
    // Nothing left to propose (every prioritized gap already has its tactics) is not a
    // quality failure, so that case carries no target.
    if (proposals.length === 0) {
      return [
        { name: "gaps_covered", value: 0, unit: "ratio", detail: "no proposals" },
        { name: "designs_specified", value: 0, unit: "ratio", detail: "no proposals" },
        { name: "designs_runnable", value: 0, unit: "ratio", detail: "no proposals" },
      ];
    }
    const specified = proposals.filter(
      (proposal) =>
        !/to be specified/i.test(proposal.design.comparator) &&
        !/to be specified/i.test(proposal.design.outcomes),
    ).length;
    const runnable = proposals.filter(
      (proposal) => proposal.design.duration_months > 0 && proposal.design.study_design.trim().length > 0,
    ).length;
    return [
      {
        name: "gaps_covered",
        value:
          output.gaps_considered === 0
            ? 0
            : Number(
                (new Set(proposals.map((proposal) => proposal.gap_id)).size / output.gaps_considered).toFixed(3),
              ),
        unit: "ratio",
        target: 1,
      },
      {
        name: "designs_specified",
        value: proposals.length === 0 ? 0 : Number((specified / proposals.length).toFixed(3)),
        unit: "ratio",
        target: 0.8,
      },
      {
        name: "designs_runnable",
        value: proposals.length === 0 ? 0 : Number((runnable / proposals.length).toFixed(3)),
        unit: "ratio",
        target: 1,
      },
    ];
  },
};

/**
 * Why a run came back empty, when it did because every idea repeated a tactic already in
 * the library (KAN-69): the customer sees the summary, not the critic's notes.
 */
export function duplicateNote(outcome: {
  withdrawn: { note: string; issues?: string[] }[];
  rejected: { note: string }[];
}): string {
  const notes = [
    ...outcome.withdrawn.map((row) => `${row.note} ${(row.issues ?? []).join(" ")}`),
    ...outcome.rejected.map((row) => row.note),
  ];
  if (notes.length === 0 || !notes.every((note) => /duplicat/i.test(note))) return "";
  const ids = [...new Set(notes.flatMap((note) => note.match(/\bTAC-\d+\b/g) ?? []))];
  const which = ids.length ? ` (${ids.join(", ")})` : "";
  return `. Every idea repeated a tactic already in the library${which}: plan or extend that tactic on the gap, or add an idea by hand.`;
}

registerModule(ideationModule);

/** A design as stored: a hand-written idea may leave its timing for S10 to estimate. */
export type StoredDesign = Omit<Design, "duration_months" | "readout_lag_months"> & {
  duration_months: number | null;
  readout_lag_months: number | null;
};

/**
 * Provenance kept next to the design in the proposal's `design` column: the
 * judge's rank, who authored the idea, and who last edited it. A proposal a
 * person wrote or edited is theirs; a re-run of S9 only ever inserts new rows,
 * so it never replaces or rewrites it.
 */
type DesignMeta = {
  write_version?: string;
  supporting_references?: JudgementReference[];
  supplied_records?: ReturnType<typeof suppliedJudgementRecords>;
  slot_id?: string | null;
  recommendation?: IdeationRecommendation;
  conditions?: string[];
  supporting_context_basis?: string;
  renewed_review?: { basis: string; actor: string; at: string; rationale: string };
  original_ai?: { recommendation?: IdeationRecommendation; supporting_context_basis?: string; proposal_kind: "new" | "expansion" | "reuse"; target_tactic_id?: string; expansion_scope?: ExpansionScope; comparative_rationale: string; name: string; type: string; rationale: string; evidence_question: string; design: StoredDesign } | null;
  rank?: number | null;
  run_id?: string | null;
  origin?: "ai" | "human";
  edited_by?: string | null;
  edited_at?: string | null;
};

const DESIGN_TEXT_FIELDS = [
  "population",
  "comparator",
  "outcomes",
  "data_source",
  "study_design",
  "timing_rationale",
] as const;

/** Read a saved immutable AI baseline; malformed or missing history stays absent. */
function originalProposal(raw: unknown): DesignMeta["original_ai"] {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const design = designSchema.safeParse(row.design);
  if (!["name", "type", "rationale", "evidence_question"].every(key => typeof row[key] === "string") || !design.success) return null;
  // Legacy absent kind is unambiguously new, but a missing historical comparison
  // cannot be recovered from the mutable source row and is ineligible for learning.
  const kind = row.proposal_kind ?? "new";
  if (!["new", "expansion", "reuse"].includes(String(kind)) || !text(row.comparative_rationale)) return null;
  if (row.proposal_kind === "expansion" && (!expansionScopeSchema.safeParse(row.expansion_scope).success || !text(row.target_tactic_id))) return null;
  if (kind === "reuse" && !text(row.target_tactic_id)) return null;
  return { recommendation: ideationRecommendationSchema.safeParse(row.recommendation).data, supporting_context_basis: contextBasis(row.supporting_context_basis), proposal_kind: kind as "new" | "expansion" | "reuse", ...(kind === "reuse" ? { target_tactic_id: text(row.target_tactic_id) } : {}), comparative_rationale: text(row.comparative_rationale), ...(kind === "expansion" ? {target_tactic_id: text(row.target_tactic_id), expansion_scope: expansionScopeSchema.parse(row.expansion_scope)} : {}), name: row.name as string, type: row.type as string, rationale: row.rationale as string, evidence_question: row.evidence_question as string, design: design.data };
}

/** Accept only versioned semantic basis tokens from stored JSON. */
function contextBasis(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw) ? raw : undefined;
}

function splitDesign(raw: unknown): { design: StoredDesign; meta: DesignMeta } {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const num = (value: unknown) => (finite(value) ? value : null);
  return {
    design: {
      population: str(row.population),
      comparator: str(row.comparator),
      outcomes: str(row.outcomes),
      data_source: str(row.data_source),
      study_design: str(row.study_design),
      duration_months: num(row.duration_months),
      readout_lag_months: num(row.readout_lag_months),
      timing_rationale: str(row.timing_rationale),
    },
    meta: {
      write_version: typeof row.write_version === "string" ? row.write_version : undefined,
      supporting_references: z.array(judgementReferenceSchema).safeParse(row.supporting_references).data ?? [],
      supplied_records: z.array(suppliedJudgementRecordSchema).safeParse(row.supplied_records).data ?? [],
      original_ai: originalProposal(row.original_ai),
      recommendation: ideationRecommendationSchema.safeParse(row.recommendation).data,
      conditions: z.array(z.string().trim().min(1)).safeParse(row.conditions).data ?? [],
      supporting_context_basis: contextBasis(row.supporting_context_basis),
      renewed_review: z.object({ basis: z.string().regex(/^[a-f0-9]{64}$/), actor: z.string(), at: z.string(), rationale: z.string() }).strict().safeParse(row.renewed_review).data,
      slot_id: typeof row.slot_id === "string" ? row.slot_id : null,
      rank: num(row.rank),
      run_id: typeof row.run_id === "string" ? row.run_id : null,
      origin: row.origin === "human" ? "human" : "ai",
      edited_by: typeof row.edited_by === "string" ? row.edited_by : null,
      edited_at: typeof row.edited_at === "string" ? row.edited_at : null,
    },
  };
}

export type IdeationProposalRecord = {
  version?: string;
  supporting_references?: ReturnType<typeof recordedJudgementReferences>;
  id: string;
  gap_id: string;
  name: string;
  type: string;
  rationale: string;
  evidence_question: string;
  design: StoredDesign;
  status: string;
  critic_note: string | null;
  judge_score: number;
  created_at: string;
  decided_by: string | null;
  decision_rationale: string | null;
  tactic_id: string | null;
  recommendation?: IdeationRecommendation;
  conditions?: string[];
  supporting_context_basis?: string;
  current_context_basis?: string;
  current_context?: IdeationGapBrief;
  context_stale?: boolean;
  renewed_review?: DesignMeta["renewed_review"];
  proposal_kind: "new" | "expansion" | "reuse";
  target_tactic_id: string | null;
  expansion_id: string | null;
  expansion_scope: ExpansionScope | null;
  reviewed_parent: Tactic | null;
  comparative_rationale: string;
  /** The judge's rank within its gap (1 is first choice); null for a hand-written idea. */
  rank: number | null;
  /** "human" when a person wrote the idea with no model run. */
  origin: "ai" | "human";
  /** Who last edited the idea by hand, if anyone. */
  edited_by: string | null;
  edited_at: string | null;
};

export async function listIdeationProposals(): Promise<IdeationProposalRecord[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.ideationProposals).orderBy(desc(t.ideationProposals.created_at));
  const [state, placements] = await Promise.all([loadState(), listPlacements()]);
  return rows.map(row => ideationProposalReadback(row, state, placements));
}

/** Shared, authorised option inspection for review and gap details; never a write snapshot refresh. */
export function ideationProposalReadback(row: typeof t.ideationProposals.$inferSelect, state: IegpState, placements: Parameters<typeof ideationAcceptanceBasis>[2] = []): IdeationProposalRecord {
  const { design, meta } = splitDesign(row.design);
  // Historical options can outlive their gap; keep their reasoning inspectable.
  // Acceptance still requires an existing eligible gap through eligibleGap.
  const gapExists = state.gaps.some(gap => gap.id === row.gap_id);
  const currentBasis = gapExists ? ideationAcceptanceBasis(state, row.gap_id, placements) : undefined;
  const currentContext = gapExists ? buildIdeationGapBrief(state, row.gap_id, placements) : undefined;
  return {
    id: row.id,
    version: proposalVersion(row),
    supporting_references: recordedJudgementReferences(state, meta.supporting_references),
    gap_id: row.gap_id,
    name: row.name,
    type: row.type,
    rationale: row.rationale,
    evidence_question: row.evidence_question,
    design,
    status: row.status,
    critic_note: row.critic_note,
    judge_score: row.judge_score,
    created_at: row.created_at,
    decided_by: row.decided_by,
    decision_rationale: row.decision_rationale,
    tactic_id: row.tactic_id,
    recommendation: meta.recommendation, conditions: meta.conditions ?? [], supporting_context_basis: meta.supporting_context_basis,
    current_context_basis: currentBasis,
    current_context: currentContext,
    context_stale: Boolean(row.status === "proposed" && meta.supporting_context_basis && meta.supporting_context_basis !== currentBasis),
    renewed_review: meta.renewed_review,
    proposal_kind: row.proposal_kind as "new" | "expansion" | "reuse", target_tactic_id: row.target_tactic_id, expansion_id: row.expansion_id, expansion_scope: row.expansion_scope as ExpansionScope | null, reviewed_parent: row.reviewed_parent as Tactic | null, comparative_rationale: row.comparative_rationale,
    rank: meta.rank ?? null,
    origin: meta.origin ?? "ai",
    edited_by: meta.edited_by ?? null,
    edited_at: meta.edited_at ?? null,
  };
}

/** Retained accepted-option context, keyed by exact tactic/expansion and source proposal. */
export function acceptedIdeationContexts(proposals: IdeationProposalRecord[]) {
  return proposals.filter(proposal => proposal.status === "accepted" && proposal.tactic_id).map(proposal => ({
    proposal_id: proposal.id, gap_id: proposal.gap_id, tactic_id: proposal.tactic_id!, expansion_id: proposal.expansion_id,
    proposal_kind: proposal.proposal_kind, recommendation: proposal.recommendation,
    conditions: [...new Set([...(proposal.conditions ?? []), ...(proposal.recommendation?.feasibility.required_checks ?? [])])],
    comparative_rationale: proposal.comparative_rationale,
    ...(proposal.supporting_context_basis ? { supporting_context_basis: proposal.supporting_context_basis } : {}),
    ...(proposal.renewed_review ? { renewed_review: proposal.renewed_review } : {}),
  }));
}

/** Retain each gap's latest successful outcome, including runs with no proposal rows. */
export async function listIdeationGapOutcomes(): Promise<IdeationGapOutcome[]> {
  await ensurePlatformSchema();
  const runs = await db().select({ output: t.moduleRuns.output }).from(t.moduleRuns).where(and(eq(t.moduleRuns.stage, "S9"), eq(t.moduleRuns.module_id, ideationModule.manifest.id), eq(t.moduleRuns.status, "ok"))).orderBy(desc(t.moduleRuns.started_at));
  const latest = new Map<string, IdeationGapOutcome>();
  for (const run of runs) {
    const output = run.output && typeof run.output === "object" ? run.output as Record<string, unknown> : {};
    const outcomes = z.array(ideationGapOutcomeSchema).safeParse(output.gap_outcomes).data ?? [];
    for (const outcome of outcomes) if (!latest.has(outcome.gap_id)) latest.set(outcome.gap_id, outcome);
  }
  return [...latest.values()];
}

/** The fields a person may write on an idea, by hand or as an edit. */
export type ProposalFields = {
  recommendation?: IdeationRecommendation;
  conditions?: string[];
  proposal_kind?: "new" | "expansion" | "reuse";
  target_tactic_id?: string | null;
  expansion_scope?: ExpansionScope;
  comparative_rationale?: string;
  name?: string;
  type?: string;
  evidence_question?: string;
  /** Why this tactic would close the gap. */
  idea_rationale?: string;
  population?: string;
  comparator?: string;
  outcomes?: string;
  data_source?: string;
  study_design?: string;
  duration_months?: number | null;
  readout_lag_months?: number | null;
  timing_rationale?: string;
};

type ProposalRow = typeof t.ideationProposals.$inferSelect;

/**
 * Applies a person's fields over an idea. Text fields are trimmed; a given
 * name, type or evidence question may not be blank; the timing must be a
 * positive duration and a non-negative lag, or null to leave it to S10.
 */
function applyFields(
  base: { name: string; type: string; evidence_question: string; rationale: string; design: StoredDesign },
  fields: ProposalFields,
) {
  const next = { ...base, design: { ...base.design } };
  const required = (value: string | undefined, label: string) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) throw new Error(`${label} is required.`);
    return trimmed;
  };
  if (fields.name !== undefined) next.name = required(fields.name, "Name");
  if (fields.type !== undefined) {
    const type = fields.type.trim();
    if (!TACTIC_TYPES.includes(type as TacticType)) throw new Error(`type "${type}" is not one of the allowed tactic types.`);
    next.type = type;
  }
  if (fields.evidence_question !== undefined) {
    next.evidence_question = required(fields.evidence_question, "Evidence question");
  }
  if (fields.idea_rationale !== undefined && fields.idea_rationale.trim()) next.rationale = fields.idea_rationale.trim();
  for (const key of DESIGN_TEXT_FIELDS) {
    if (fields[key] !== undefined) next.design[key] = (fields[key] ?? "").trim();
  }
  if (fields.duration_months !== undefined) {
    const value = fields.duration_months;
    if (value !== null && (!finite(value) || value <= 0)) {
      throw new TrustedApplicationError("duration_months must be a positive number of months.");
    }
    next.design.duration_months = value;
  }
  if (fields.readout_lag_months !== undefined) {
    const value = fields.readout_lag_months;
    if (value !== null && (!finite(value) || value < 0)) {
      throw new TrustedApplicationError("readout_lag_months must be zero or a positive number of months.");
    }
    next.design.readout_lag_months = value;
  }
  return next;
}

async function recordById(id: string): Promise<IdeationProposalRecord> {
  const record = (await listIdeationProposals()).find((row) => row.id === id);
  if (!record) throw new Error(`Unknown proposal ${id}`);
  return record;
}

/** Reuse cannot alter canonical scientific design or add scope. */
function assertReuseDesign(value: {type: string; evidence_question: string; design: StoredDesign}, target: Tactic | undefined) {
  if (!target || target.review_status !== "accepted" || target.status === "cancelled") throw new TrustedApplicationError("Reuse target not found or no longer eligible.", "not_found", 404);
  for (const key of ["type", "evidence_question"] as const) if (value[key] !== target[key]) throw new Error(`Reuse must preserve existing ${key}; added work needs an expansion or new tactic.`);
  for (const key of ["population", "comparator", "outcomes", "data_source", "study_design"] as const) if (value.design[key] !== target[key]) throw new Error(`Reuse must preserve existing ${key}; added work needs an expansion or new tactic.`);
}

/** Duplicated representations must describe the same accepted child, never its parent. */
function assertExpansionDesign(value: {name: string; evidence_question: string; type: string; design: {population: string; outcomes: string; study_design: string; comparator: string; data_source: string}}, scope: ExpansionScope) {
    const common = {...value.design, name: value.name, evidence_question: value.evidence_question, type: value.type};
    for (const key of ["name", "evidence_question", "population", "outcomes", "study_design", "type", "comparator", "data_source"] as const) {
        if (scope[key] !== undefined && scope[key] !== common[key]) throw new Error(`Conflicting expansion design field: ${key}. Review both representations.`);
    }
}

/** Reconcile a single human edit against the saved source; contradictory two-sided changes are refused. */
function reconcileExpansionDesign(next: ReturnType<typeof applyFields>, scope: ExpansionScope, fields: ProposalFields, before?: ReturnType<typeof applyFields>, previousScope?: ExpansionScope) {
    const result = {...scope};
    for (const key of ["name", "evidence_question", "population", "outcomes", "study_design"] as const) {
        const oldCommon = key === "name" || key === "evidence_question" ? before?.[key] : before?.design[key];
        const common = key === "name" || key === "evidence_question" ? next[key] : next.design[key];
        const commonChanged = fields[key] !== undefined && common !== oldCommon;
        const scopeChanged = fields.expansion_scope !== undefined && result[key] !== previousScope?.[key];
        if (commonChanged && scopeChanged && common !== result[key]) throw new Error(`Conflicting expansion design field: ${key}. Review both representations.`);
        if (commonChanged) result[key] = common;
        if (key === "name" || key === "evidence_question") next[key] = result[key];
        else next.design[key] = result[key];
    }
    // Optional fields only enter canonical scope when their source explicitly supplied them.
    for (const key of ["type", "comparator", "data_source"] as const) {
        if (result[key] === undefined) continue;
        const common = key === "type" ? next.type : next.design[key];
        const oldCommon = key === "type" ? before?.type : before?.design[key];
        if (fields[key] !== undefined && common !== oldCommon) {
            if (fields.expansion_scope && result[key] !== previousScope?.[key] && result[key] !== common) throw new Error(`Conflicting expansion design field: ${key}. Review both representations.`);
            if (key === "type") result.type = common as TacticType;
            else result[key] = common;
        } else if (key === "type") next.type = result[key]!;
        else next.design[key] = result[key]!;
    }
    assertExpansionDesign(next, result);
    return expansionScopeSchema.parse(result);
}

/** Enforce credible additional scope before generation, editing or acceptance. */
function validateExpansion(parent: Tactic | undefined, scope: ExpansionScope, comparison: string) {
    if (!parent)
        throw new TrustedApplicationError("Expansion target not found in this workspace.", "not_found", 404);
    if (parent.review_status !== "accepted" || parent.status === "cancelled")
        throw new TrustedApplicationError("Expansion requires an accepted active target.");
    if (!comparison.trim())
        throw new TrustedApplicationError("Expansion comparative rationale is required.");
    if (parent.status === "completed" && (scope.prospective_enrolment || !scope.post_hoc))
        throw new TrustedApplicationError("Completed study expansions must be post-hoc using existing data; prospective enrolment requires a new study.");
    if (scope.prospective_enrolment && (!scope.protocol_amendment || !/amend/i.test(scope.study_design + scope.feasibility_risks)))
        throw new TrustedApplicationError("Prospective additions require a credible protocol amendment design and feasibility review.");
    if (/post[- ]?hoc/i.test(scope.analysis) && !scope.post_hoc)
        throw new TrustedApplicationError("Post-hoc analysis must be identified as post_hoc.");
}

/** Check the same shared priority owner inside a source mutation transaction. */
async function eligibleGap(id: string, tx?: ExpansionTransaction) {
    const state = tx ? await readState(tx) : await loadState();
    const placements = tx ? await tx.select().from(t.priorityPlacements).where(eq(t.priorityPlacements.gap_id, id)).for("update") : await listPlacements();
    const gap = state.gaps.find(g => g.id === id);
    if (!gap || !isLiveGap(gap) || displayedGapStatus(gap) !== "validated_open" || !ideationBandOrder(placements as Parameters<typeof ideationBandOrder>[0]).has(id)) {
        throw new TrustedApplicationError("Ideation requires an open gap with human-validated High priority.");
    }
    return state;
}

function proposalVersion(row: ProposalRow): string {
  return createHash("sha256").update(relationshipVersion(row)).digest("hex");
}

function requireProposalVersion(row: ProposalRow, expected?: string) {
  // Trusted internal callers can omit a browser token, like the tactic editor owner.
  if (expected === undefined) return;
  if (!expected || expected !== proposalVersion(row)) throw new TrustedApplicationError("Proposal changed or its opening snapshot is missing. Your fields and reason have not been saved. Reopen the latest proposal before retrying.");
}

/** Validate the original supplied records; never reconstruct missing model provenance. */
async function optionSupport(row: ProposalRow, tx: ExpansionTransaction): Promise<JudgementReference[]> {
  const { meta } = splitDesign(row.design);
  const records = meta.supplied_records ?? [];
  const references = meta.supporting_references ?? [];
  if (!records.length || !inspectSuppliedJudgementReferences(records, references).length) throw new TrustedApplicationError("Supporting references or the original supplied context are missing. Make an explicit manual judgement with a reason instead.");
  for (const [kind, table] of [["objective", core.objectives], ["source", core.sources], ["gap", core.gaps]] as const) {
    for (const id of [...new Set(records.filter(record => record.entity_type === kind).map(record => record.entity_id))].sort()) await tx.select({ id: table.id }).from(table).where(eq(table.id, id)).for("update");
  }
  const state = await readState(tx);
  if (!inspectJudgementReferences(state, [row.gap_id], references).length) throw new TrustedApplicationError("Supporting references are missing, inaccessible or unrelated to this option. Make a manual judgement with a reason instead.");
  if (!matchesSuppliedJudgementRecords(state, [row.gap_id], records)) throw new TrustedApplicationError("Model option context changed. Regenerate it or make a manual judgement with a reason.");
  return references;
}

/** Apply edits without refreshing the immutable reviewed parent or original AI baseline. */
async function editPending(row: ProposalRow, fields: ProposalFields, rationale: string, actor: Actor, workspace_id: string | undefined, tx: ExpansionTransaction) {
    if (row.status !== "proposed")
        throw new TrustedApplicationError("This idea was already decided. Review its current decision; edit an accepted idea on the tactic instead.");
    if (fields.proposal_kind !== undefined && fields.proposal_kind !== row.proposal_kind || fields.target_tactic_id !== undefined && fields.target_tactic_id !== row.target_tactic_id)
        throw new TrustedApplicationError("Proposal kind and target identity are fixed; create a separate proposal to change them.");
    const { design, meta } = splitDesign(row.design);
    const before = { name: row.name, type: row.type, evidence_question: row.evidence_question, rationale: row.rationale, design };
    const next = applyFields(before, fields);
    let scope = fields.expansion_scope ?? row.expansion_scope as ExpansionScope | null;
    const comparison = fields.comparative_rationale?.trim() ?? row.comparative_rationale;
    if (row.proposal_kind === "expansion") {
        scope = reconcileExpansionDesign(next, expansionScopeSchema.parse(scope), fields, before, row.expansion_scope as ExpansionScope);
        const state = await readState(tx);
        validateExpansion(state.tactics.find(t => t.id === row.target_tactic_id), expansionScopeSchema.parse(scope), comparison);
        if (next.design.duration_months === null || next.design.readout_lag_months === null)
            throw new TrustedApplicationError("Expansion numeric timing is required.");
    }
    else if (fields.expansion_scope)
        throw new TrustedApplicationError("New tactics cannot carry expansion scope.");
    if (row.proposal_kind === "reuse") {
      const state = await readState(tx);
      assertReuseDesign(next, state.tactics.find(tactic => tactic.id === row.target_tactic_id));
    }
    let recommendation = fields.recommendation === undefined ? meta.recommendation : ideationRecommendationSchema.parse(fields.recommendation);
    // The visible "Relevant alternatives" reasoning is structured recommendation
    // metadata. When a person edits that field directly, keep the current record
    // coherent by updating its rendered structured value too. The immutable AI
    // baseline remains in the separately recorded original proposal/audit trail.
    if (fields.comparative_rationale !== undefined && comparison && comparison !== row.comparative_rationale) {
        recommendation = recommendation
            ? { ...recommendation, alternatives_rationale: comparison }
            : recommendation;
    }
    const conditions = fields.conditions === undefined ? meta.conditions : z.array(z.string().trim().min(1)).parse(fields.conditions);
    const was = { recommendation: meta.recommendation, conditions: meta.conditions, ...before, ...design, expansion_scope: row.expansion_scope, comparative_rationale: row.comparative_rationale };
    const now = { recommendation, conditions, ...next, ...next.design, expansion_scope: scope, comparative_rationale: comparison };
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter(key => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
    if (!changed.length)
        return row;
    const updated = { ...row, ...next, expansion_scope: scope, comparative_rationale: comparison, design: { ...next.design, ...meta, recommendation, conditions, write_version: newId("IPV"), edited_by: actor.name, edited_at: nowIso() } };
    await tx.update(t.ideationProposals).set(updated).where(eq(t.ideationProposals.id, row.id));
    await recordEdit({ workspace_id, stage: "S9", entity_type: "ideation_proposal", entity_id: row.id, field: changed.join(","), action: "edit", before: JSON.stringify(was), after: JSON.stringify(now), rationale, actor }, tx);
    return updated;
}

/** Save human fields on a pending proposal; target snapshot and AI baseline remain immutable. */
export async function editIdeationProposal(args: {
    id: string;
    expected_version?: string;
    fields: ProposalFields;
    rationale: string;
    actor: Actor;
    workspace_id?: string;
}): Promise<IdeationProposalRecord> {
    await ensurePlatformSchema();
    const rationale = requireRationale(args.rationale);
    await db().transaction(async (tx) => {
        const [row] = await tx.select().from(t.ideationProposals).where(eq(t.ideationProposals.id, args.id)).for("update");
        if (!row)
            throw new Error(`Unknown proposal ${args.id}`);
        requireProposalVersion(row, args.expected_version);
        await editPending(row, args.fields, rationale, args.actor, args.workspace_id, tx);
    });
    return recordById(args.id);
}

/**
 * A person writes an idea for an Open gap with no model run. It lands as a
 * proposed idea like any other and goes through the same accept/reject gate.
 */
export async function addIdeationProposal(args: {
  gap_id: string;
  fields: ProposalFields;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<IdeationProposalRecord> {
  await ensurePlatformSchema();
  const rationale = requireRationale(args.rationale);
  const state = await eligibleGap(args.gap_id);
  const kind = args.fields.proposal_kind ?? "new";
  const target = kind !== "new" ? state.tactics.find(t => t.id === args.fields.target_tactic_id) : null;
  let scope = kind === "expansion" ? expansionScopeSchema.parse(args.fields.expansion_scope) : null;
  if (kind === "expansion") validateExpansion(target ?? undefined, scope!, args.fields.comparative_rationale ?? "");
  else if (kind === "reuse") {
    if (!target || target.review_status !== "accepted" || target.status === "cancelled" || args.fields.expansion_scope) throw new TrustedApplicationError("Reuse requires an accepted eligible target and no added scope.");
  }
  else if (args.fields.target_tactic_id || args.fields.expansion_scope) throw new TrustedApplicationError("New tactics cannot carry expansion target or scope.");
  const empty: StoredDesign = {
    population: "",
    comparator: "",
    outcomes: "",
    data_source: "",
    study_design: "",
    duration_months: null,
    readout_lag_months: null,
    timing_rationale: "",
  };
  const base = kind === "reuse" && target ? { name: target.name, type: target.type, evidence_question: target.evidence_question, rationale, design: { ...empty, population: target.population, comparator: target.comparator, outcomes: target.outcomes, data_source: target.data_source, study_design: target.study_design } } : { name: "", type: "", evidence_question: "", rationale, design: empty };
  const next = applyFields(base, args.fields);
  if (kind === "reuse") assertReuseDesign(next, target ?? undefined);
  const recommendation = args.fields.recommendation === undefined ? undefined : ideationRecommendationSchema.parse(args.fields.recommendation);
  const conditions = z.array(z.string().trim().min(1)).parse(args.fields.conditions ?? []);
  if (scope) scope = reconcileExpansionDesign(next, scope, args.fields);
  if (kind === "expansion" && (next.design.duration_months === null || next.design.readout_lag_months === null)) throw new TrustedApplicationError("Expansion numeric timing is required.");
  if (!next.name) throw new TrustedApplicationError("Name is required.");
  if (!next.type) throw new TrustedApplicationError("Type is required.");
  if (!next.evidence_question) throw new TrustedApplicationError("Evidence question is required.");
  const id = newId("idea");
  const at = nowIso();
  await db().transaction(async tx => {
    await tx.select().from(core.gaps).where(eq(core.gaps.id, args.gap_id)).for("update");
    const current = await eligibleGap(args.gap_id, tx);
    const placements = await tx.select().from(t.priorityPlacements);
    await tx
      .insert(t.ideationProposals)
      .values({
        id,
        proposal_kind:kind,target_tactic_id:target?.id ?? null,expansion_scope:scope,reviewed_parent:target,comparative_rationale:args.fields.comparative_rationale ?? "",
        gap_id: args.gap_id,
        name: next.name,
        type: next.type,
        rationale: next.rationale,
        evidence_question: next.evidence_question,
        design: { ...next.design, recommendation, conditions, supporting_context_basis: ideationAcceptanceBasis(current, args.gap_id, placements as Parameters<typeof ideationAcceptanceBasis>[2]), write_version: newId("IPV"), rank: null, origin: "human", edited_by: args.actor.name, edited_at: at },
        status: "proposed",
        critic_note: null,
        judge_score: 0,
        created_at: at,
      });
    await recordEdit({
      workspace_id: args.workspace_id,
      stage: "S9",
      entity_type: "ideation_proposal",
      entity_id: id,
      field: "created",
      action: "add",
      before: null,
      after: `${next.name} (${next.type}) for ${args.gap_id}`,
      rationale,
      actor: args.actor,
    }, tx);
  });
  return recordById(id);
}

/**
 * The S9 human gate: create a new proposed tactic or a proposed child scope
 * on its reviewed parent, atomically with the source decision. `fields` lets the person accept an edited version in one step;
 * the edit is audited before the decision.
 */
export async function decideIdeationProposal(args: {
    id: string;
    decision: "accept" | "reject";
    expected_version?: string;
    judgement_origin?: "model" | "manual";
    reviewed_context_basis?: string;
    rationale: string;
    actor: Actor;
    workspace_id?: string;
    fields?: ProposalFields;
}): Promise<{
    tactic_id: string | null;
    expansion_id: string | null;
}> {
    await ensurePlatformSchema();
    const rationale = requireRationale(args.rationale);
    const result = await withRelationshipChange({ actor_name: args.actor.name, actor_function: args.actor.function, rationale }, () => db().transaction(async (tx) => {
        const [pending] = await tx.select().from(t.ideationProposals).where(eq(t.ideationProposals.id, args.id)).for("update");
        if (!pending)
            throw new Error(`Unknown proposal ${args.id}`);
        requireProposalVersion(pending, args.expected_version);
        if (pending.status !== "proposed")
            throw new TrustedApplicationError(pending.status === "accepted" ? "This idea was already accepted. Open the linked tactic to make further changes." : "This idea was already decided. Refresh the idea list before making another decision.");
        const originalMeta = splitDesign(pending.design).meta;
        const original = originalMeta.original_ai;
        // Match the relationship owner's scientific lock order: tactic, then supplied context.
        if (args.decision === "accept" && pending.proposal_kind !== "new" && pending.target_tactic_id)
            await tx.select().from(core.tactics).where(eq(core.tactics.id, pending.target_tactic_id)).for("update");
        const manual = args.judgement_origin === "manual";
        const references = args.decision === "accept" && originalMeta.origin !== "human" && !manual ? await optionSupport(pending, tx) : [];
        const proposal = args.decision === "accept" && args.fields ? await editPending(pending, args.fields, rationale, args.actor, args.workspace_id, tx) : pending;
        let tactic_id: string | null = null, expansion_id: string | null = null;
        let state = await readState(tx);
        if (args.decision === "accept") {
            await tx.select().from(core.gaps).where(eq(core.gaps.id, proposal.gap_id)).for("update");
            state = await eligibleGap(proposal.gap_id, tx);
            if (proposal.proposal_kind !== "new" && !state.tactics.some(tactic => tactic.id === proposal.target_tactic_id)) throw new TrustedApplicationError("Proposal target not found in this workspace.", "not_found", 404);
            const placements = await tx.select().from(t.priorityPlacements).for("update");
            const currentBasis = ideationAcceptanceBasis(state, proposal.gap_id, placements as Parameters<typeof ideationAcceptanceBasis>[2]);
            const stale = originalMeta.supporting_context_basis && originalMeta.supporting_context_basis !== currentBasis;
            if (stale && (!manual || args.reviewed_context_basis !== currentBasis)) throw new TrustedApplicationError("Ideation context changed; this proposal is stale. Review the current requirements, coverage, priority and tactic lifecycle, then submit its current review token with a manual judgement.");
            if (stale) {
              proposal.design = { ...(proposal.design as Record<string, unknown>), renewed_review: { basis: currentBasis, actor: args.actor.name, at: nowIso(), rationale } };
              await recordEdit({workspace_id: args.workspace_id, stage: "S9", entity_type: "ideation_proposal", entity_id: proposal.id, field: "renewed_context_review", action: "validate", before: originalMeta.supporting_context_basis!, after: currentBasis, rationale, actor: args.actor}, tx);
            }
            if (proposal.proposal_kind === "reuse") {
                assertReuseDesign({...proposal, design: splitDesign(proposal.design).design}, state.tactics.find(tactic => tactic.id === proposal.target_tactic_id));
                tactic_id = proposal.target_tactic_id!;
                await reuseTacticForGap({tactic_id, gap_id: proposal.gap_id, actor_name: args.actor.name, actor_function: args.actor.function, rationale}, tx);
            }
            else if (proposal.proposal_kind === "expansion") {
                const parent = proposal.reviewed_parent as Tactic | null;
                if (!parent || parent.id !== proposal.target_tactic_id)
                    throw new TrustedApplicationError("Reviewed expansion target snapshot is unavailable.");
                const timing = splitDesign(proposal.design).design;
                if (timing.duration_months === null || timing.duration_months <= 0 || timing.readout_lag_months === null || timing.readout_lag_months < 0)
                    throw new TrustedApplicationError("Expansion requires valid numeric duration and readout lag.");
                const scope = expansionScopeSchema.parse(proposal.expansion_scope);
                assertExpansionDesign({...proposal, design: timing}, scope);
                const acceptedScope = {...scope, type: proposal.type as TacticType, comparator: timing.comparator, data_source: timing.data_source};
                validateExpansion(state.tactics.find(t => t.id === proposal.target_tactic_id), scope, proposal.comparative_rationale);
                const child = await acceptTacticExpansion({ proposal_id: proposal.id, tactic_id: parent.id, gap_id: proposal.gap_id, scope: acceptedScope, expected_tactic_version: tacticVersion(stale ? state.tactics.find(tactic => tactic.id === parent.id)! : parent), rationale, actor: args.actor }, tx);
                tactic_id = child.tactic_id;
                expansion_id = child.id;
            }
            else {
                const { design } = splitDesign(proposal.design);
                tactic_id = await insertLibraryTactic({ name: proposal.name, type: proposal.type as TacticType, description: `Ideated for ${proposal.gap_id}. ${proposal.rationale}`, evidence_question: proposal.evidence_question, population: design.population, intervention: state.asset.name, comparator: design.comparator, outcomes: design.outcomes, study_design: design.study_design, data_source: design.data_source, geography: state.asset.geography, owner: args.actor.name, function: args.actor.function, residual_ids: [], status: "proposed", lifecycle_stage: "proposed", actor_name: args.actor.name, actor_function: args.actor.function, audit_action: "create_proposed", audit_reason: rationale }, tx);
                await tx.insert(core.coverages).values({ id: newId("COV"), gap_id: proposal.gap_id, tactic_id, dimensions: emptyDimensions(), overall: "unassessed", overall_rationale: rationale, overall_lock: unlocked(), stale: false, needs_review: false });
                await syncComputedGapStatuses(proposal.gap_id, undefined, tx);
            }
        }
        await tx.update(t.ideationProposals).set({ design: { ...(proposal.design as Record<string, unknown>), write_version: newId("IPV") }, status: args.decision === "accept" ? "accepted" : "rejected", decided_by: args.actor.name, decided_at: nowIso(), decision_rationale: rationale, tactic_id, expansion_id }).where(eq(t.ideationProposals.id, args.id));
        const edit = await recordEdit({ workspace_id: args.workspace_id, stage: "S9", entity_type: "ideation_proposal", entity_id: args.id, field: manual ? "manual_status" : references.length ? "supported_model_status" : "status", references, reference_gap_ids: [proposal.gap_id], action: args.decision, before: "proposed", after: args.decision === "accept" ? "accepted" : "rejected", rationale, actor: args.actor }, tx);
        return { tactic_id, expansion_id, proposal, originalMeta, original, edit, gap: state.gaps.find(g => g.id === proposal.gap_id) };
    }));
    // Shared learning storage runs after the workspace commit, never while its connection is held.
    if (result.originalMeta.origin !== "human" && !result.original)
        console.warn("[learning] S9 decision omitted: immutable original AI baseline unavailable", args.id);
    if (result.originalMeta.origin !== "human" && result.original)
        await captureProposalDecision({ proposal: { id: result.proposal.id, ...result.original, slot_id: result.originalMeta.slot_id }, capture_key: result.edit.id, run_id: result.originalMeta.run_id, actor: args.actor, gap: result.gap ? { name: result.gap.name, statement: result.gap.statement } : null, decision: args.decision, final: args.decision === "accept" ? { name: result.proposal.name, type: result.proposal.type, evidence_question: result.proposal.evidence_question, rationale: result.proposal.rationale, design: splitDesign(result.proposal.design).design, recommendation: splitDesign(result.proposal.design).meta.recommendation, supporting_context_basis: splitDesign(result.proposal.design).meta.supporting_context_basis, proposal_kind: result.proposal.proposal_kind as "new" | "expansion" | "reuse", comparative_rationale: result.proposal.comparative_rationale, ...(result.proposal.proposal_kind !== "new" ? { target_tactic_id: result.proposal.target_tactic_id, expansion_scope: result.proposal.expansion_scope } : {}) } : null, rationale, workspace_id: args.workspace_id });
    return { tactic_id: result.tactic_id, expansion_id: result.expansion_id };
}

/**
 * Undo a rejection (KAN-16): a rejected proposal goes back to "proposed" so a
 * person can edit, accept or reject it again. The earlier decision stays in the
 * edit records; the restore is audited with its own rationale. An accepted
 * proposal already became a tactic and is changed on that tactic instead.
 */
export async function restoreIdeationProposal(args: {
    id: string;
    expected_version?: string;
    rationale: string;
    actor: Actor;
    workspace_id?: string;
}): Promise<IdeationProposalRecord> {
    await ensurePlatformSchema();
    const rationale = requireRationale(args.rationale);
    await db().transaction(async (tx) => {
        const [proposal] = await tx.select().from(t.ideationProposals).where(eq(t.ideationProposals.id, args.id)).for("update");
        if (proposal) requireProposalVersion(proposal, args.expected_version);
        if (!proposal || proposal.status !== "rejected")
            throw new Error(`${args.id} is not rejected; accepted proposals are changed on the tactic.`);
        await tx.update(t.ideationProposals).set({ design: { ...(proposal.design as Record<string, unknown>), write_version: newId("IPV") }, status: "proposed", decided_by: null, decided_at: null, decision_rationale: null, tactic_id: null, expansion_id: null }).where(eq(t.ideationProposals.id, args.id));
        await recordEdit({ workspace_id: args.workspace_id, stage: "S9", entity_type: "ideation_proposal", entity_id: args.id, field: "status", action: "edit", before: "rejected", after: "proposed", rationale, actor: args.actor }, tx);
        await appendAudit(args.actor.name, args.actor.function, "ideation_proposal", args.id, "restore", `rejected → proposed: ${rationale}`, tx);
    });
    return recordById(args.id);
}

/** Stable scope identity keeps rejected human decisions out of repeated proposals. */
function expansionKey(gap_id: string, target: string | null, scope: unknown): string {
  const sorted = scope && typeof scope === "object" ? Object.fromEntries(Object.entries(scope).sort(([a],[b]) => a.localeCompare(b))) : scope;
  return createHash("sha256").update(JSON.stringify([gap_id,target,sorted])).digest("hex");
}

/** Freeze the source facts this stage consumes, before any proposal or human decision. */
async function freezeFacts(input: z.infer<typeof inputSchema>) {
  const state = await readStageState();
  const [placements, proposals] = await Promise.all([readPlacements(state), db().select().from(t.ideationProposals)]);
  // Capture the persisted acceptance linkage now, before generation. Library
  // provenance contains identities only, never another proposal's answer text.
  const proposal_lineage = proposals.map(proposal => {
    const meta = splitDesign(proposal.design).meta;
    return { subject_id: proposal.id, gap_id: proposal.gap_id, tactic_id: proposal.tactic_id, run_id: meta.run_id ?? null, origin: meta.origin ?? "ai" };
  });
  const proposal_slots = Object.fromEntries(state.gaps.map(gap => [gap.id, Array.from({length:input.per_gap},(_,index)=>`${gap.id}:proposal:${index+1}`)]));
  const rejected_expansions = proposals.filter(p => p.proposal_kind === "expansion" && p.status === "rejected").map(p => expansionKey(p.gap_id,p.target_tactic_id,p.expansion_scope));
  return { state, placements, proposal_slots, proposal_lineage, rejected_expansions };
}
