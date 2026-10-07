import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
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
import { NoRouteError } from "@/modules/llm/provider";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import {
  TACTIC_TYPES,
  type EvidenceDomain,
  type TacticType,
} from "@/lib/iegp/enums";
import { appendAudit, insertLibraryTactic, loadState, readState, syncComputedGapStatuses } from "@/lib/iegp/store";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import { displayedGapStatus, isLiveGap, emptyDimensions, unlocked } from "@/lib/iegp/engine";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { plural } from "@/lib/plural";
import { acceptTacticExpansion, expansionScopeSchema, tacticVersion, type ExpansionTransaction } from "@/lib/iegp/tactic-expansions";
import type { ExpansionScope, Tactic } from "@/lib/iegp/types";
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
  proposal_kind: z.enum(["new", "expansion"]).default("new"),
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
  /** The judge's 0–100 confidence in this idea. */
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
  withdrawn: z.array(z.object({ slot_id: z.string(), note: z.string() })).optional(),
});

export type IdeationInput = z.infer<typeof inputSchema>;
export type IdeationOutput = z.infer<typeof outputSchema>;

type Design = z.infer<typeof designSchema>;
type Proposal = z.infer<typeof proposalSchema>;

type IdeationGap = { id: string; name: string; statement: string; domain: EvidenceDomain };

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

const DESIGN_FIELDS = `"population":"","comparator":"","outcomes":"","data_source":"","study_design":"","duration_months":0,"readout_lag_months":0,"timing_rationale":""`;

const IDEATION_SYSTEM = `You design evidence tactics that would close a prioritized evidence gap in a pharma Integrated Evidence Generation Plan.

Each tactic must be a runnable study, analysis or publication with a population, comparator, outcomes, a data source and a design. Do not restate the gap. Consider both expanding an existing accepted active tactic and a new tactic. Explicitly compare evidence quality, incremental cost/effort, time and feasibility in comparative_rationale. Do not invent an expansion when no sensible target exists. A new tactic must not duplicate the library. An expansion must add specified scope beyond the parent and any existing child expansions you are given, and retain target_tactic_id; tactic_id is never the target. Completed trials permit only post-hoc analyses using existing data; prospective additions require a credible protocol amendment on an active study or a new study.

For an expansion, name, evidence_question, population, outcomes and study_design must exactly match expansion_scope. These are the child design, not the parent. If optional type, comparator or data_source are present in expansion_scope they must match the common design too.

type is one of: ${TACTIC_TYPES.join(", ")}.
duration_months is how long the tactic runs from start to last data in; readout_lag_months is how long from last data in to a usable readout. Estimate both for this specific design and say why in timing_rationale. Where a design has no comparator, say so in comparator (for example "None — descriptive") rather than leaving it empty.

Propose candidates_per_gap distinct candidates for every gap you are given; a judge keeps the best. Fill in every field.

When a gap carries revise requests, answer each one: return that tactic with its id, revised to meet the objection, or set "withdraw":true with a reason when it cannot be rescued.

Return JSON only: {"tactics":[{"id":"","gap_id":"","name":"","type":"","evidence_question":"","rationale":"","proposal_kind":"new","target_tactic_id":null,"expansion_scope":null,"comparative_rationale":"",${DESIGN_FIELDS},"withdraw":false,"withdraw_reason":""}]}`;

const EXPANSION_CONTRACT = `Expansion scope fields (all explicit): name, evidence_question, population, outcomes, geography, data_cut, analysis, instrument, study_design, gap_coverage, cost_effort, timing, feasibility_risks, post_hoc, prospective_enrolment, protocol_amendment, start_date, evidence_available. Unused added scope is an empty string; dates are null or ISO dates. Compare expansion and new alternatives for evidence quality, time/cost and feasibility. Never claim an amendment or data access is already approved.`;

const CRITIC_SYSTEM = `You critique proposed evidence tactics for prioritized evidence gaps in a pharma Integrated Evidence Generation Plan.

For each tactic, judge whether it would actually close its gap: is the design runnable, are the population, comparator and outcomes the right ones for this gap, are the data source, duration and readout lag credible for this design, and does the rationale hold. Compare new and expansion alternatives for quality, time/cost and feasibility. For expansions check added scope, post-hoc/prospective constraints and credible amendments. An expansion with a valid additional scope is not a duplicate of its parent. Check new tactics against the tactic library you are given: if an existing tactic already answers the same evidence question for the same population, set duplicate_of to that tactic's id.

verdict is "keep" when the tactic is sound, "revise" when a specific change would make it sound, and "drop" when it duplicates the library or cannot answer the gap. confidence is 0–100 that the tactic belongs in the plan. note is actionable: name the field, what is wrong and what it should become; for "keep" say briefly why it holds. issues is a short list of machine-readable defect tags (for example "comparator", "duration", "duplicate"); empty for "keep".

Review every tactic you are given.

Return JSON only: {"reviews":[{"id":"","verdict":"keep","confidence":0,"note":"","issues":[],"duplicate_of":null}]}`;

const JUDGE_SYSTEM = `You are the judge for proposed evidence tactics in a pharma Integrated Evidence Generation Plan. The user will review the tactics you keep.

Compare expansion versus new alternatives for evidence quality, incremental cost/effort, timing and feasibility; use the full target library status/design. For each gap, decide for every candidate tactic whether to accept or reject it, using the gap, the design and the critic's last review. Accept at most max_per_gap tactics for a gap, and only tactics you would put in front of the evidence team; accepting fewer, or none, is right when the candidates are weak. Rank the accepted tactics 1, 2, … in order of preference. confidence is 0–100 that the tactic belongs in the plan. reason says why it was kept or rejected, in one or two sentences.

Decide every candidate of every gap you are given.

Return JSON only: {"gaps":[{"gap_id":"","decisions":[{"id":"","verdict":"accept","rank":1,"confidence":0,"reason":""}]}]}`;

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
function parseTactic(raw: Record<string, unknown>, library: LibraryTactic[]): { tactic: Omit<Proposal, "id" | "gap_id" | "score" | "critic_note" | "judge_note" | "rank"> } | { problem: string } {
  const problems: string[] = [];
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
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (empty.length > 0) problems.push(`missing ${empty.join(", ")}`);
  if (!finite(raw.duration_months) || raw.duration_months <= 0) {
    problems.push("duration_months must be a positive number of months");
  }
  if (!finite(raw.readout_lag_months) || raw.readout_lag_months < 0) {
    problems.push("readout_lag_months must be zero or a positive number of months");
  }
  if (!text(raw.comparative_rationale)) problems.push("comparative_rationale must explicitly compare expansion and new alternatives for quality, time/cost and feasibility");
  const kind = raw.proposal_kind;
  let scope: ExpansionScope | null = null;
  const target = typeof raw.target_tactic_id === "string" ? raw.target_tactic_id : null;
  if (raw.target_tactic_id !== null && typeof raw.target_tactic_id !== "string") problems.push("target_tactic_id must explicitly be a string or null");
  if (kind !== "new" && kind !== "expansion") problems.push("proposal_kind must be new or expansion");
  if (kind === "new" && (raw.target_tactic_id !== null || raw.expansion_scope !== null)) problems.push("New tactics cannot carry expansion target or scope");
  if (kind === "expansion") {
    try {
      if (!target?.trim()) throw new Error("Expansion requires an explicit nonempty target_tactic_id");
      scope = expansionScopeSchema.parse(raw.expansion_scope);
      assertExpansionDesign({name: fields.name, evidence_question: fields.evidence_question, type, design: fields}, scope);
      validateExpansion(library.find(t => t.id === target), scope, text(raw.comparative_rationale));
    } catch (error) { problems.push(error instanceof Error ? error.message : "Invalid expansion"); }
  }
  if (problems.length > 0) return { problem: problems.join("; ") };
  return {
    tactic: {
      proposal_kind: kind as "new" | "expansion", target_tactic_id: target, expansion_scope: scope, comparative_rationale: text(raw.comparative_rationale),
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
  /** Tactics the critic asked to have revised, with its objection. */
  revise?: { id: string; previous: Omit<Proposal, "score" | "critic_note" | "judge_note" | "rank">; objection: string }[];
  /** What was wrong with the model's last answer for this gap. */
  problems?: string[];
  /** Stable anonymous output positions assigned before generation; contain no human answers. */
  proposal_slots?: string[];
};

/**
 * Gaps per proposer call, tactics per critic call and gaps per judge call. Asking
 * for every High gap in one reply runs past the output budget (KAN-66), so each
 * step asks in slices, in parallel.
 */
export const PROPOSER_GAPS_PER_CALL = 2;
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
): Promise<Record<string, unknown>[]> {
  const answers = await inBatches(args.gaps, PROPOSER_GAPS_PER_CALL, (gaps) => askProposerOnce(ctx, { ...args, gaps }));
  return answers.flat();
}

async function askProposerOnce(
  ctx: ModuleContext,
  args: { gaps: PromptGap[]; perGap: number; hints: string; library: LibraryTactic[]; round: number; plan?: unknown },
): Promise<Record<string, unknown>[]> {
  const payload = (await ctx.complete({
    system: `${IDEATION_SYSTEM}\n${EXPANSION_CONTRACT}\nWhen a gap supplies proposal_slots, return each tactic id from that exact list, once only. Keep that id through all revisions. Never invent a different id.`,
    user: JSON.stringify({
      worked_examples: args.hints || undefined,
      exchange: args.round === 1 ? undefined : `${args.round - 1} of ${PROPOSER_CRITIC_EXCHANGES}`,
      candidates_per_gap: args.perGap,
      // The IEGP context from setup: asset, objectives, key decisions, landscape.
      plan_context: args.plan,
      library: args.library,
      gaps: args.gaps,
    }),
    purpose: "ideation-proposer",
  })) as { tactics?: unknown };
  return Array.isArray(payload?.tactics)
    ? (payload.tactics as unknown[]).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : [];
}

type Review = { verdict: Critique["verdict"]; confidence: number; note: string; issues: string[]; duplicate_of: string | null };
type Decision = { verdict: "accept" | "reject"; rank: number | null; confidence: number; reason: string };

const promptTactic = (proposal: Proposal) => ({
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
    version: "2.2.0",
    title: "Tactics ideation (proposer → critic → judge)",
    summary:
      "A model compares new tactics and expansions, timing included, for open gaps whose priority a human validated as High; a model critic challenges them against the gap and the tactic library over three exchanges; a model judge keeps and ranks up to the per-gap cap. Needs a connected LLM.",
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
      }));

    if (gaps.length === 0) {
      return {
        output: { mode: isTestStub() ? "deterministic" : "llm", proposals: [], rejected: [], gaps_considered: 0 },
        summary: "No open gaps with human-validated High priority to ideate for",
      };
    }

    const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
    const describeGap = (id: string) => gapById.get(id)?.name ?? id;
    const library: LibraryTactic[] = state.tactics.map(tactic => ({...tactic, expansions: state.expansions.filter(child => child.tactic_id === tactic.id).map(child => ({id:child.id,status:child.status,scope:child.scope}))}));
    const libraryIds = new Set(library.map((tactic) => tactic.id));
    let reviewerHints = "";
    let nextId = 0;
    const lastReview = new Map<string, Review>();
    /** The model judge's decisions on the final candidates, set after the last exchange. */
    let judgement: Map<string, Decision> | null = null;

    /** Round 1: every gap gets candidates; a gap with any invalid tactic is asked again. */
    const propose = async (hints: string): Promise<Proposal[]> => {
      const problems = new Map<string, string[]>();
      const byGap = await completeAll<Proposal[]>({
        ids: gaps.map((gap) => gap.id),
        what: "set of tactic designs",
        describe: describeGap,
        remedy: REMEDY,
        ask: async (missing) => {
          const rows = await askProposer(ctx, {
            plan: planContext,
            hints,
            perGap: input.per_gap,
            library,
            round: 1,
            gaps: missing.map((id) => ({ ...gapById.get(id)!, problems: problems.get(id), proposal_slots: proposal_slots?.[id] })),
          });
          const found = new Map<string, Proposal[]>();
          const bad = new Map<string, string[]>();
          for (const raw of rows) {
            const gapId = text(raw.gap_id);
            if (!missing.includes(gapId)) continue;
            const parsed = parseTactic(raw, library);
            if ("problem" in parsed) {
              bad.set(gapId, [...(bad.get(gapId) ?? []), `${text(raw.name) || "unnamed tactic"}: ${parsed.problem}`]);
              continue;
            }
            const slots = proposal_slots?.[gapId];
            const slotId = text(raw.id);
            if (slots && (!slots.includes(slotId) || (found.get(gapId) ?? []).some(p => p.id === slotId))) {
              bad.set(gapId, [...(bad.get(gapId) ?? []), "Return each supplied proposal slot id exactly once; unknown or duplicate slot."]);
              continue;
            }
            nextId += 1;
            found.set(gapId, [
              ...(found.get(gapId) ?? []),
              { ...parsed.tactic, id: slots ? slotId : `${gapId}-L${nextId}`, gap_id: gapId, score: 0, critic_note: "", judge_note: "", rank: null },
            ]);
          }
          const complete = new Map<string, Proposal[]>();
          for (const id of missing) {
            if (bad.has(id)) problems.set(id, bad.get(id)!);
            else if (!found.has(id)) problems.set(id, ["no tactic was returned for this gap"]);
            else if (proposal_slots?.[id] && found.get(id)!.length !== proposal_slots[id].length) problems.set(id, ["Return a proposal for every supplied slot."]);
            else complete.set(id, found.get(id)!);
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
      const answers = await completeAll<Proposal | "withdrawn">({
        ids: [...objections.keys()].filter((id) => byId.has(id)),
        what: "revision",
        describe: (id) => byId.get(id)?.name ?? id,
        remedy: REMEDY,
        ask: async (missing) => {
          const targets = missing.map((id) => byId.get(id)!);
          const rows = await askProposer(ctx, {
            plan: planContext,
            hints,
            perGap: input.per_gap,
            library,
            round,
            gaps: [...new Set(targets.map((proposal) => proposal.gap_id))].map((gapId) => ({
              ...gapById.get(gapId)!,
              revise: targets
                .filter((proposal) => proposal.gap_id === gapId)
                .map((proposal) => ({ id: proposal.id, previous: promptTactic(proposal), objection: objections.get(proposal.id)! })),
              problems: targets
                .filter((proposal) => proposal.gap_id === gapId && problems.has(proposal.id))
                .map((proposal) => `${proposal.id}: ${problems.get(proposal.id)}`),
            })),
          });
          const done = new Map<string, Proposal | "withdrawn">();
          for (const raw of rows) {
            const id = text(raw.id);
            const before = byId.get(id);
            if (!before || !missing.includes(id)) continue;
            if (raw.withdraw === true) {
              done.set(id, "withdrawn");
              continue;
            }
            const parsed = parseTactic(raw, library);
            if ("problem" in parsed) {
              problems.set(id, parsed.problem);
              continue;
            }
            done.set(id, { ...before, ...parsed.tactic });
          }
          for (const id of missing) if (!done.has(id) && !problems.has(id)) problems.set(id, "no revision was returned");
          return done;
        },
      });
      // A tactic the critic dropped, or the proposer withdrew, leaves the dialogue.
      return previous.flatMap((proposal) => {
        if (dropped.has(proposal.id)) return [];
        const answer = answers.get(proposal.id);
        if (answer === "withdrawn") return [];
        return [answer ?? proposal];
      });
    };

    /** The model judge: accept and rank at most per_gap tactics per gap. */
    const judgeWithModel = async (candidates: Proposal[]): Promise<Map<string, Decision>> => {
      const decisions = new Map<string, Decision>();
      const gapIds = [...new Set(candidates.map((proposal) => proposal.gap_id))];
      const problems = new Map<string, string>();
      await completeAll<true>({
        ids: gapIds,
        what: "judgement",
        describe: describeGap,
        remedy: REMEDY,
        ask: async (missingAll) => {
          const done = new Map<string, true>();
          await inBatches(missingAll, JUDGE_GAPS_PER_CALL, async (missing) => {
            const payload = (await ctx.complete({
              system: JUDGE_SYSTEM,
              user: JSON.stringify({
                worked_examples: reviewerHints || undefined,
                max_per_gap: input.per_gap,
                library,
                gaps: missing.map((gapId) => ({
                  ...gapById.get(gapId)!,
                  problem: problems.get(gapId),
                  candidates: candidates
                    .filter((proposal) => proposal.gap_id === gapId)
                    .map((proposal) => {
                      const review = lastReview.get(proposal.id);
                      return {
                        ...promptTactic(proposal),
                        critic: review ? { verdict: review.verdict, confidence: review.confidence, note: review.note } : undefined,
                      };
                    }),
                })),
              }),
              purpose: "ideation-judge",
            })) as { gaps?: { gap_id?: unknown; decisions?: unknown }[] };
            for (const row of Array.isArray(payload?.gaps) ? payload.gaps : []) {
              const gapId = text(row?.gap_id);
              if (!missing.includes(gapId)) continue;
              const ids = candidates.filter((proposal) => proposal.gap_id === gapId).map((proposal) => proposal.id);
              const got = new Map<string, Decision>();
              for (const raw of Array.isArray(row.decisions) ? (row.decisions as Record<string, unknown>[]) : []) {
                const id = text(raw?.id);
                const reason = text(raw?.reason);
                if (!ids.includes(id) || !reason || !finite(raw.confidence)) continue;
                if (raw.verdict !== "accept" && raw.verdict !== "reject") continue;
                if (raw.verdict === "accept" && !finite(raw.rank)) continue;
                got.set(id, {
                  verdict: raw.verdict,
                  rank: raw.verdict === "accept" ? (raw.rank as number) : null,
                  confidence: Math.max(0, Math.min(100, Math.round(raw.confidence))),
                  reason,
                });
              }
              const undecided = ids.filter((id) => !got.has(id));
              const accepted = [...got.values()].filter((decision) => decision.verdict === "accept").length;
              if (undecided.length > 0) {
                problems.set(gapId, `An earlier answer left ${undecided.join(", ")} without a complete decision. Decide every candidate.`);
                continue;
              }
              if (accepted > input.per_gap) {
                problems.set(gapId, `An earlier answer accepted ${accepted} tactics; accept at most ${input.per_gap}.`);
                continue;
              }
              for (const [id, decision] of got) decisions.set(id, decision);
              done.set(gapId, true);
            }
            for (const gapId of missing) if (!done.has(gapId) && !problems.has(gapId)) problems.set(gapId, "No judgement was returned for this gap.");
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
        const reviews = await completeAll<Review>({
          ids: proposals.map((proposal) => proposal.id),
          what: "review",
          describe: (id) => byId.get(id)?.name ?? id,
          remedy: REMEDY,
          ask: async (missingAll, attempt) => {
            const map = new Map<string, Review>();
            await inBatches(missingAll, CRITIC_TACTICS_PER_CALL, async (missing) => {
              const payload = (await ctx.complete({
                system: `${CRITIC_SYSTEM}\n${EXPANSION_CONTRACT}`,
                user: JSON.stringify({
                  worked_examples: reviewerHints || undefined,
                  exchange: `${round} of ${PROPOSER_CRITIC_EXCHANGES}`,
                  note: attempt > 1 ? "An earlier answer left these tactics without a complete review. Review each." : undefined,
                  library,
                  tactics: missing.map((id) => {
                    const proposal = byId.get(id)!;
                    const gap = gapById.get(proposal.gap_id)!;
                    return { ...promptTactic(proposal), gap: { name: gap.name, statement: gap.statement, domain: gap.domain } };
                  }),
                }),
                purpose: "ideation-critic",
              })) as { reviews?: Record<string, unknown>[] };
              for (const row of Array.isArray(payload?.reviews) ? payload.reviews : []) {
                const id = text(row?.id);
                if (!missing.includes(id)) continue;
                if (row.verdict !== "keep" && row.verdict !== "revise" && row.verdict !== "drop") continue;
                if (!finite(row.confidence)) continue;
                const note = text(row.note);
                if (!note) continue;
                const duplicate = row.duplicate_of == null || row.duplicate_of === "" ? null : text(row.duplicate_of);
                // A duplicate must name a tactic that is actually in the library.
                if (duplicate !== null && !libraryIds.has(duplicate)) continue;
                map.set(id, {
                  verdict: row.verdict,
                  confidence: Math.max(0, Math.min(100, Math.round(row.confidence))),
                  note,
                  issues: Array.isArray(row.issues) ? row.issues.map(text).filter(Boolean) : [],
                  duplicate_of: duplicate,
                });
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
    }, { kinds: ["s9_proposal"], text: gaps.map((gap) => `${gap.name} ${gap.statement}`).join(" ") });

    // Hash-only rejection memory is pre-generation provenance, never human answer text.
    // Explicit restore removes that source row from the rejected set.
    outcome.accepted = outcome.accepted.filter(p => {
      if (p.proposal_kind !== "expansion" || !rejectedExpansions.has(expansionKey(p.gap_id,p.target_tactic_id,p.expansion_scope))) return true;
      outcome.withdrawn.push({subject:p.id,score:p.score,note:"Human rejection memory: restore this expansion target/scope before reconsidering it."});
      return false;
    });
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
          design: { ...proposal.design, rank: proposal.rank, origin: "ai", run_id: ctx.run.id,
            slot_id: proposal_slots?.[proposal.gap_id]?.includes(proposal.id) ? proposal.id : null,
            original_ai: { proposal_kind: proposal.proposal_kind, comparative_rationale: proposal.comparative_rationale, ...(proposal.proposal_kind === "expansion" ? {target_tactic_id: proposal.target_tactic_id, expansion_scope: proposal.expansion_scope} : {}), name: proposal.name, type: proposal.type, rationale: proposal.rationale, evidence_question: proposal.evidence_question, design: proposal.design },
          },
          status: "proposed",
          critic_note: [proposal.critic_note, proposal.judge_note && `Judge: ${proposal.judge_note}`]
            .filter(Boolean)
            .join(" — "),
          judge_score: Math.round(proposal.score),
          created_at: nowIso(),
        };
        await db().insert(t.ideationProposals).values(values);
      }
    }

    return {
      output: {
        mode: outcome.mode,
        proposals: outcome.accepted,
        rejected: outcome.rejected.map((item) => item.candidate),
        gaps_considered: gaps.length,
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
  slot_id?: string | null;
  original_ai?: { proposal_kind: "new" | "expansion"; target_tactic_id?: string; expansion_scope?: ExpansionScope; comparative_rationale: string; name: string; type: string; rationale: string; evidence_question: string; design: StoredDesign } | null;
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
  if (!["new", "expansion"].includes(String(kind)) || !text(row.comparative_rationale)) return null;
  if (row.proposal_kind === "expansion" && (!expansionScopeSchema.safeParse(row.expansion_scope).success || !text(row.target_tactic_id))) return null;
  return { proposal_kind: kind as "new" | "expansion", comparative_rationale: text(row.comparative_rationale), ...(kind === "expansion" ? {target_tactic_id: text(row.target_tactic_id), expansion_scope: expansionScopeSchema.parse(row.expansion_scope)} : {}), name: row.name as string, type: row.type as string, rationale: row.rationale as string, evidence_question: row.evidence_question as string, design: design.data };
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
      original_ai: originalProposal(row.original_ai),
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
  proposal_kind: "new" | "expansion";
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
  return rows.map((row) => {
    const { design, meta } = splitDesign(row.design);
    return {
      id: row.id,
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
      proposal_kind: row.proposal_kind as "new" | "expansion", target_tactic_id: row.target_tactic_id, expansion_id: row.expansion_id, expansion_scope: row.expansion_scope as ExpansionScope | null, reviewed_parent: row.reviewed_parent as Tactic | null, comparative_rationale: row.comparative_rationale,
      rank: meta.rank ?? null,
      origin: meta.origin ?? "ai",
      edited_by: meta.edited_by ?? null,
      edited_at: meta.edited_at ?? null,
    };
  });
}

/** The fields a person may write on an idea, by hand or as an edit. */
export type ProposalFields = {
  proposal_kind?: "new" | "expansion";
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
      throw new Error("duration_months must be a positive number of months.");
    }
    next.design.duration_months = value;
  }
  if (fields.readout_lag_months !== undefined) {
    const value = fields.readout_lag_months;
    if (value !== null && (!finite(value) || value < 0)) {
      throw new Error("readout_lag_months must be zero or a positive number of months.");
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
        throw new Error("Expansion target not found in this workspace.");
    if (parent.review_status !== "accepted" || parent.status === "cancelled")
        throw new Error("Expansion requires an accepted active target.");
    if (!comparison.trim())
        throw new Error("Expansion comparative rationale is required.");
    if (parent.status === "completed" && (scope.prospective_enrolment || !scope.post_hoc))
        throw new Error("Completed study expansions must be post-hoc using existing data; prospective enrolment requires a new study.");
    if (scope.prospective_enrolment && (!scope.protocol_amendment || !/amend/i.test(scope.study_design + scope.feasibility_risks)))
        throw new Error("Prospective additions require a credible protocol amendment design and feasibility review.");
    if (/post[- ]?hoc/i.test(scope.analysis) && !scope.post_hoc)
        throw new Error("Post-hoc analysis must be identified as post_hoc.");
}

/** Check the same shared priority owner inside a source mutation transaction. */
async function eligibleGap(id: string, tx?: ExpansionTransaction) {
    const state = tx ? await readState(tx) : await loadState();
    const placements = tx ? await tx.select().from(t.priorityPlacements).where(eq(t.priorityPlacements.gap_id, id)).for("update") : await listPlacements();
    const gap = state.gaps.find(g => g.id === id);
    if (!gap || !isLiveGap(gap) || displayedGapStatus(gap) !== "validated_open" || !ideationBandOrder(placements as Parameters<typeof ideationBandOrder>[0]).has(id)) {
        throw new Error("Ideation requires an open gap with human-validated High priority.");
    }
    return state;
}

/** Apply edits without refreshing the immutable reviewed parent or original AI baseline. */
async function editPending(row: ProposalRow, fields: ProposalFields, rationale: string, actor: Actor, workspace_id: string | undefined, tx: ExpansionTransaction) {
    if (row.status !== "proposed")
        throw new Error(`${row.id} was already ${row.status}; decided ideas are not edited.`);
    if (fields.proposal_kind !== undefined && fields.proposal_kind !== row.proposal_kind || fields.target_tactic_id !== undefined && fields.target_tactic_id !== row.target_tactic_id)
        throw new Error("Proposal kind and target identity are fixed; create a separate proposal to change them.");
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
            throw new Error("Expansion numeric timing is required.");
    }
    else if (fields.expansion_scope)
        throw new Error("New tactics cannot carry expansion scope.");
    const was = { ...before, ...design, expansion_scope: row.expansion_scope, comparative_rationale: row.comparative_rationale };
    const now = { ...next, ...next.design, expansion_scope: scope, comparative_rationale: comparison };
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter(key => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
    if (!changed.length)
        return row;
    const updated = { ...row, ...next, expansion_scope: scope, comparative_rationale: comparison, design: { ...next.design, ...meta, edited_by: actor.name, edited_at: nowIso() } };
    await tx.update(t.ideationProposals).set(updated).where(eq(t.ideationProposals.id, row.id));
    await recordEdit({ workspace_id, stage: "S9", entity_type: "ideation_proposal", entity_id: row.id, field: changed.join(","), action: "edit", before: JSON.stringify(was), after: JSON.stringify(now), rationale, actor }, tx);
    return updated;
}

/** Save human fields on a pending proposal; target snapshot and AI baseline remain immutable. */
export async function editIdeationProposal(args: {
    id: string;
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
  fields: ProposalFields & { name: string; type: string; evidence_question: string };
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<IdeationProposalRecord> {
  await ensurePlatformSchema();
  const rationale = requireRationale(args.rationale);
  const state = await eligibleGap(args.gap_id);
  const kind = args.fields.proposal_kind ?? "new";
  const target = kind === "expansion" ? state.tactics.find(t => t.id === args.fields.target_tactic_id) : null;
  let scope = kind === "expansion" ? expansionScopeSchema.parse(args.fields.expansion_scope) : null;
  if (kind === "expansion") validateExpansion(target ?? undefined, scope!, args.fields.comparative_rationale ?? "");
  else if (args.fields.target_tactic_id || args.fields.expansion_scope) throw new Error("New tactics cannot carry expansion target or scope.");
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
  const next = applyFields({ name: "", type: "", evidence_question: "", rationale, design: empty }, args.fields);
  if (scope) scope = reconcileExpansionDesign(next, scope, args.fields);
  if (kind === "expansion" && (next.design.duration_months === null || next.design.readout_lag_months === null)) throw new Error("Expansion numeric timing is required.");
  if (!next.name) throw new Error("Name is required.");
  if (!next.type) throw new Error("Type is required.");
  if (!next.evidence_question) throw new Error("Evidence question is required.");
  const id = newId("idea");
  const at = nowIso();
  await db()
    .insert(t.ideationProposals)
    .values({
      id,
      proposal_kind:kind,target_tactic_id:target?.id ?? null,expansion_scope:scope,reviewed_parent:target,comparative_rationale:args.fields.comparative_rationale ?? "",
      gap_id: args.gap_id,
      name: next.name,
      type: next.type,
      rationale: next.rationale,
      evidence_question: next.evidence_question,
      design: { ...next.design, rank: null, origin: "human", edited_by: args.actor.name, edited_at: at },
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
    const result = await db().transaction(async (tx) => {
        const [pending] = await tx.select().from(t.ideationProposals).where(eq(t.ideationProposals.id, args.id)).for("update");
        if (!pending)
            throw new Error(`Unknown proposal ${args.id}`);
        if (pending.status !== "proposed")
            throw new Error(`${args.id} was already ${pending.status}.`);
        const originalMeta = splitDesign(pending.design).meta;
        const original = originalMeta.original_ai;
        const proposal = args.decision === "accept" && args.fields ? await editPending(pending, args.fields, rationale, args.actor, args.workspace_id, tx) : pending;
        let tactic_id: string | null = null, expansion_id: string | null = null;
        let state = await readState(tx);
        if (args.decision === "accept") {
            if (proposal.proposal_kind === "expansion" && proposal.target_tactic_id)
                await tx.select().from(core.tactics).where(eq(core.tactics.id, proposal.target_tactic_id)).for("update");
            await tx.select().from(core.gaps).where(eq(core.gaps.id, proposal.gap_id)).for("update");
            state = await eligibleGap(proposal.gap_id, tx);
            if (proposal.proposal_kind === "expansion") {
                const parent = proposal.reviewed_parent as Tactic | null;
                if (!parent || parent.id !== proposal.target_tactic_id)
                    throw new Error("Reviewed expansion target snapshot is unavailable.");
                const timing = splitDesign(proposal.design).design;
                if (timing.duration_months === null || timing.duration_months <= 0 || timing.readout_lag_months === null || timing.readout_lag_months < 0)
                    throw new Error("Expansion requires valid numeric duration and readout lag.");
                const scope = expansionScopeSchema.parse(proposal.expansion_scope);
                assertExpansionDesign({...proposal, design: timing}, scope);
                const acceptedScope = {...scope, type: proposal.type as TacticType, comparator: timing.comparator, data_source: timing.data_source};
                validateExpansion(state.tactics.find(t => t.id === proposal.target_tactic_id), scope, proposal.comparative_rationale);
                const child = await acceptTacticExpansion({ proposal_id: proposal.id, tactic_id: parent.id, gap_id: proposal.gap_id, scope: acceptedScope, expected_tactic_version: tacticVersion(parent), rationale, actor: args.actor }, tx);
                tactic_id = child.tactic_id;
                expansion_id = child.id;
            }
            else {
                const { design } = splitDesign(proposal.design);
                tactic_id = await insertLibraryTactic({ name: proposal.name, type: proposal.type as TacticType, description: `Ideated for ${proposal.gap_id}. ${proposal.rationale}`, evidence_question: proposal.evidence_question, population: design.population, intervention: state.asset.name, comparator: design.comparator, outcomes: design.outcomes, study_design: design.study_design, data_source: design.data_source, geography: state.asset.geography, owner: args.actor.name, function: args.actor.function, residual_ids: [], status: "proposed", lifecycle_stage: "proposed", actor_name: args.actor.name, actor_function: args.actor.function, audit_action: "create_proposed" }, tx);
                await tx.insert(core.coverages).values({ id: newId("COV"), gap_id: proposal.gap_id, tactic_id, dimensions: emptyDimensions(), overall: "unassessed", overall_rationale: rationale, overall_lock: unlocked(), stale: false, needs_review: false });
                await syncComputedGapStatuses(proposal.gap_id, undefined, tx);
            }
        }
        await tx.update(t.ideationProposals).set({ status: args.decision === "accept" ? "accepted" : "rejected", decided_by: args.actor.name, decided_at: nowIso(), decision_rationale: rationale, tactic_id, expansion_id }).where(eq(t.ideationProposals.id, args.id));
        const edit = await recordEdit({ workspace_id: args.workspace_id, stage: "S9", entity_type: "ideation_proposal", entity_id: args.id, field: "status", action: args.decision, before: "proposed", after: args.decision === "accept" ? "accepted" : "rejected", rationale, actor: args.actor }, tx);
        return { tactic_id, expansion_id, proposal, originalMeta, original, edit, gap: state.gaps.find(g => g.id === proposal.gap_id) };
    });
    // Shared learning storage runs after the workspace commit, never while its connection is held.
    if (result.originalMeta.origin !== "human" && !result.original)
        console.warn("[learning] S9 decision omitted: immutable original AI baseline unavailable", args.id);
    if (result.originalMeta.origin !== "human" && result.original)
        await captureProposalDecision({ proposal: { id: result.proposal.id, ...result.original, slot_id: result.originalMeta.slot_id }, capture_key: result.edit.id, run_id: result.originalMeta.run_id, actor: args.actor, gap: result.gap ? { name: result.gap.name, statement: result.gap.statement } : null, decision: args.decision, final: args.decision === "accept" ? { name: result.proposal.name, type: result.proposal.type, evidence_question: result.proposal.evidence_question, rationale: result.proposal.rationale, design: splitDesign(result.proposal.design).design, proposal_kind: result.proposal.proposal_kind as "new" | "expansion", comparative_rationale: result.proposal.comparative_rationale, ...(result.proposal.proposal_kind === "expansion" ? { target_tactic_id: result.proposal.target_tactic_id, expansion_scope: result.proposal.expansion_scope } : {}) } : null, rationale, workspace_id: args.workspace_id });
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
    rationale: string;
    actor: Actor;
    workspace_id?: string;
}): Promise<IdeationProposalRecord> {
    await ensurePlatformSchema();
    const rationale = requireRationale(args.rationale);
    await db().transaction(async (tx) => {
        const [proposal] = await tx.select().from(t.ideationProposals).where(eq(t.ideationProposals.id, args.id)).for("update");
        if (!proposal || proposal.status !== "rejected")
            throw new Error(`${args.id} is not rejected; accepted proposals are changed on the tactic.`);
        await tx.update(t.ideationProposals).set({ status: "proposed", decided_by: null, decided_at: null, decision_rationale: null, tactic_id: null, expansion_id: null }).where(eq(t.ideationProposals.id, args.id));
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
  const [state, placements, proposals] = await Promise.all([loadState(), listPlacements(), db().select().from(t.ideationProposals)]);
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
