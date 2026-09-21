import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { runAgenticCycle } from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
import { recordEdit } from "@/modules/kernel/edit-records";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import {
  TACTIC_TYPES,
  type EvidenceDomain,
  type TacticType,
} from "@/lib/iegp/enums";
import { assignTacticToGap, createProposedTactic, loadState } from "@/lib/iegp/store";
import { displayedGapStatus, isLiveGap, similarRecord } from "@/lib/iegp/engine";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

const designSchema = z.object({
  population: z.string(),
  comparator: z.string(),
  outcomes: z.string(),
  data_source: z.string(),
  study_design: z.string(),
  duration_months: z.number(),
  readout_lag_months: z.number(),
});

const inputSchema = z.object({
  /** Defaults to every open gap validated as High. */
  gap_ids: z.array(z.string()).optional(),
  per_gap: z.number().int().min(1).max(5).default(2),
  dry_run: z.boolean().default(false),
});

const proposalSchema = z.object({
  id: z.string(),
  gap_id: z.string(),
  name: z.string(),
  type: z.string(),
  evidence_question: z.string(),
  rationale: z.string(),
  design: designSchema,
  score: z.number(),
  critic_note: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposals: z.array(proposalSchema),
  rejected: z.array(proposalSchema),
  gaps_considered: z.number(),
});

export type IdeationInput = z.infer<typeof inputSchema>;
export type IdeationOutput = z.infer<typeof outputSchema>;

type Design = z.infer<typeof designSchema>;
type Proposal = z.infer<typeof proposalSchema>;

const IDEATION_SYSTEM = `You design evidence tactics that would close a high-priority evidence gap in a pharma IEGP.

Each tactic must be a runnable study, analysis or publication with a population, comparator, outcomes, a data source and a design. Do not restate the gap. Do not propose a tactic that already exists in the library.

Return JSON only: {"tactics":[{"gap_id":"","name":"","type":"","evidence_question":"","rationale":"","population":"","comparator":"","outcomes":"","data_source":"","study_design":"","duration_months":0,"readout_lag_months":0}]}`;

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
    },
  },
];

function localProposals(args: {
  gaps: { id: string; name: string; statement: string; domain: EvidenceDomain }[];
  perGap: number;
}): Proposal[] {
  const out: Proposal[] = [];
  for (const gap of args.gaps) {
    const playbook = PLAYBOOK[gap.domain] ?? FALLBACK;
    for (const entry of [...playbook, ...FALLBACK].slice(0, args.perGap)) {
      out.push({
        id: `${gap.id}-${entry.type}`,
        gap_id: gap.id,
        name: `${entry.type.replaceAll("_", " ")} for ${gap.name}`,
        type: entry.type,
        evidence_question: gap.statement,
        rationale: `${gap.domain.replaceAll("_", " ")} gap; ${entry.design.study_design.toLowerCase()} answers it with ${entry.design.data_source.toLowerCase()}.`,
        design: entry.design,
        score: 60,
        critic_note: "",
      });
    }
  }
  return out;
}

async function llmProposals(
  ctx: ModuleContext,
  args: {
    gaps: { id: string; name: string; statement: string; domain: string }[];
    perGap: number;
    hints: string;
  },
): Promise<Proposal[]> {
  const payload = (await ctx.complete({
    system: IDEATION_SYSTEM,
    user: JSON.stringify({
      hints: args.hints || undefined,
      tactics_per_gap: args.perGap,
      gaps: args.gaps,
    }),
    purpose: "ideation-proposer",
  })) as {
    tactics?: Record<string, unknown>[];
  };
  const out: Proposal[] = [];
  for (const [index, raw] of (payload.tactics ?? []).entries()) {
    const gap_id = String(raw.gap_id ?? "");
    const name = String(raw.name ?? "").trim();
    if (!gap_id || !name) continue;
    const type = TACTIC_TYPES.includes(raw.type as TacticType) ? (raw.type as TacticType) : "rwe_study";
    out.push({
      id: `${gap_id}-L${index + 1}`,
      gap_id,
      name,
      type,
      evidence_question: String(raw.evidence_question ?? "").trim() || name,
      rationale: String(raw.rationale ?? "").trim() || "model-proposed tactic",
      design: {
        population: String(raw.population ?? "To be specified"),
        comparator: String(raw.comparator ?? "To be specified"),
        outcomes: String(raw.outcomes ?? "To be specified"),
        data_source: String(raw.data_source ?? "To be specified"),
        study_design: String(raw.study_design ?? "To be specified"),
        duration_months: Number(raw.duration_months ?? 9),
        readout_lag_months: Number(raw.readout_lag_months ?? 2),
      },
      score: 65,
      critic_note: "",
    });
  }
  return out;
}

export const ideationModule: SynapseModule<IdeationInput, IdeationOutput> = {
  manifest: {
    id: "s9-ideation.pcj",
    stage: "S9",
    version: "1.0.0",
    title: "Tactics ideation (proposer → critic → judge)",
    summary:
      "Designs candidate tactics for high-priority open gaps, critiques them against the library and the gap, and keeps the best per gap.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "design-playbook", "per-gap-cap"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
    const [state, placements] = await Promise.all([loadState(), listPlacements()]);
    const highGapIds = new Set(
      placements
        .filter((placement) => placement.validated && (placement.band === "high" || placement.band === "medium"))
        .filter((placement) => placement.band === "high")
        .map((placement) => placement.gap_id),
    );
    const gaps = state.gaps
      .filter(
        (gap) =>
          isLiveGap(gap) &&
          displayedGapStatus(gap) === "validated_open" &&
          (input.gap_ids?.length ? input.gap_ids.includes(gap.id) : highGapIds.has(gap.id)),
      )
      .map((gap) => ({
        id: gap.id,
        name: gap.name,
        statement: gap.statement,
        domain: gap.domain,
      }));

    if (gaps.length === 0) {
      return {
        output: { mode: "deterministic", proposals: [], rejected: [], gaps_considered: 0 },
        summary: "No high-priority open gaps to ideate for",
      };
    }

    const outcome = await runAgenticCycle<Proposal>(ctx, "S9", {
      subjectOf: (proposal) => proposal.id,
      proposer: {
        local: () => localProposals({ gaps, perGap: input.per_gap }),
        llm: canPrompt(ctx.route)
          ? ({ hints }) => llmProposals(ctx, { gaps, perGap: input.per_gap, hints })
          : undefined,
      },
      critic: (proposals) =>
        proposals.map((proposal) => {
          const gap = gaps.find((item) => item.id === proposal.gap_id);
          const notes: string[] = [];
          let score = 68;
          if (
            state.tactics.some(
              (tactic) =>
                similarRecord(tactic.name, proposal.name) ||
                similarRecord(tactic.evidence_question, proposal.evidence_question, 0.5),
            )
          ) {
            score -= 30;
            notes.push("a library tactic already covers this");
          }
          if (gap?.domain === "comparative_effectiveness" && /to be specified/i.test(proposal.design.comparator)) {
            score -= 20;
            notes.push("comparative gap with no comparator specified");
          }
          if (proposal.design.duration_months <= 0) {
            score -= 15;
            notes.push("no credible duration");
          }
          if (!proposal.rationale.trim()) {
            score -= 10;
            notes.push("no rationale");
          }
          return {
            subject: proposal.id,
            verdict: score >= 60 ? ("keep" as const) : score >= 35 ? ("revise" as const) : ("drop" as const),
            note: notes.length ? notes.join("; ") : "runnable design that answers the gap",
            score: Math.max(0, Math.min(100, score)),
          };
        }),
      judge: ({ candidates, critiques }) => {
        const perGap = new Map<string, number>();
        return [...candidates]
          .sort(
            (a, b) =>
              (critiques.find((item) => item.subject === b.id)?.score ?? 0) -
              (critiques.find((item) => item.subject === a.id)?.score ?? 0),
          )
          .map((proposal) => {
            const critique = critiques.find((item) => item.subject === proposal.id);
            const score = critique?.score ?? 50;
            const used = perGap.get(proposal.gap_id) ?? 0;
            const accept = critique?.verdict !== "drop" && score >= 45 && used < input.per_gap;
            if (accept) perGap.set(proposal.gap_id, used + 1);
            return {
              candidate: { ...proposal, score, critic_note: critique?.note ?? "" },
              subject: proposal.id,
              verdict: accept ? ("accept" as const) : ("reject" as const),
              score,
              note: used >= input.per_gap ? `Rejected: ${input.per_gap} tactic(s) already kept for this gap.` : (critique?.note ?? ""),
            };
          });
      },
    });

    if (!input.dry_run && outcome.accepted.length > 0) {
      await ensurePlatformSchema();
      for (const proposal of outcome.accepted) {
        const values = {
          id: newId("idea"),
          gap_id: proposal.gap_id,
          name: proposal.name,
          type: proposal.type,
          rationale: proposal.rationale,
          evidence_question: proposal.evidence_question,
          design: proposal.design,
          status: "proposed",
          critic_note: proposal.critic_note,
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
      },
      summary: `${outcome.accepted.length} tactic proposal(s) for ${gaps.length} high-priority gap(s)${
        input.dry_run ? " (dry run)" : ""
      }`,
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

registerModule(ideationModule);

export type IdeationProposalRecord = {
  id: string;
  gap_id: string;
  name: string;
  type: string;
  rationale: string;
  evidence_question: string;
  design: Design;
  status: string;
  critic_note: string | null;
  judge_score: number;
  created_at: string;
  decided_by: string | null;
  decision_rationale: string | null;
  tactic_id: string | null;
};

export async function listIdeationProposals(): Promise<IdeationProposalRecord[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.ideationProposals).orderBy(desc(t.ideationProposals.created_at));
  return rows.map((row) => ({
    id: row.id,
    gap_id: row.gap_id,
    name: row.name,
    type: row.type,
    rationale: row.rationale,
    evidence_question: row.evidence_question,
    design: row.design as Design,
    status: row.status,
    critic_note: row.critic_note,
    judge_score: row.judge_score,
    created_at: row.created_at,
    decided_by: row.decided_by,
    decision_rationale: row.decision_rationale,
    tactic_id: row.tactic_id,
  }));
}

/** The S9 human gate: a validated proposal becomes a real proposed tactic mapped to its gap. */
export async function decideIdeationProposal(args: {
  id: string;
  decision: "accept" | "reject";
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<{ tactic_id: string | null }> {
  await ensurePlatformSchema();
  const rows = await db()
    .select()
    .from(t.ideationProposals)
    .where(eq(t.ideationProposals.id, args.id))
    .limit(1);
  const proposal = rows[0];
  if (!proposal) throw new Error(`Unknown proposal ${args.id}`);
  if (proposal.status !== "proposed") throw new Error(`${args.id} was already ${proposal.status}.`);

  let tactic_id: string | null = null;
  if (args.decision === "accept") {
    const design = proposal.design as Design;
    const state = await loadState();
    const before = new Set(state.tactics.map((tactic) => tactic.id));
    await createProposedTactic({
      name: proposal.name,
      type: proposal.type as TacticType,
      description: `Ideated for ${proposal.gap_id}. ${design.study_design}. ${proposal.rationale}`,
      evidence_question: proposal.evidence_question,
      population: design.population,
      intervention: state.asset.name,
      comparator: design.comparator,
      outcomes: design.outcomes,
      geography: state.asset.geography,
      owner: args.actor.name,
      function: args.actor.function,
      residual_ids: [],
      gap_id: proposal.gap_id,
      actor_name: args.actor.name,
      actor_function: args.actor.function,
    });
    const after = await loadState();
    tactic_id = after.tactics.find((tactic) => !before.has(tactic.id))?.id ?? null;
    if (tactic_id) {
      try {
        await assignTacticToGap({
          gap_id: proposal.gap_id,
          tactic_id,
          actor_name: args.actor.name,
          actor_function: args.actor.function,
          note: `Accepted ideation proposal — ${args.rationale}`,
        });
      } catch {
        // createProposedTactic may already have joined the pair.
      }
    }
  }

  await db()
    .update(t.ideationProposals)
    .set({
      status: args.decision === "accept" ? "accepted" : "rejected",
      decided_by: args.actor.name,
      decided_at: nowIso(),
      decision_rationale: args.rationale.trim(),
      tactic_id,
    })
    .where(eq(t.ideationProposals.id, args.id));

  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S9",
    entity_type: "ideation_proposal",
    entity_id: args.id,
    field: "status",
    action: args.decision,
    before: "proposed",
    after: args.decision === "accept" ? "accepted" : "rejected",
    rationale: args.rationale,
    actor: args.actor,
  });

  return { tactic_id };
}
