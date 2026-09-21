import { z } from "zod";
import { registerModule } from "@/modules/kernel/registry";
import { recordEdit } from "@/modules/kernel/edit-records";
import { runAgenticCycle } from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { loadState, splitPartialGap } from "@/lib/iegp/store";
import {
  countingCoverages,
  draftResidualGapSuggestion,
  gapNameFromStatement,
  uncoveredDimensions,
} from "@/lib/iegp/engine";

const inputSchema = z.object({
  gap_id: z.string(),
  /** Present when the user has validated a split and wants it applied. */
  apply: z
    .object({
      addressed_name: z.string().min(3),
      addressed_statement: z.string().optional(),
      open_name: z.string().min(3),
      open_statement: z.string().optional(),
      addressed_tactic_ids: z.array(z.string()).default([]),
      open_tactic_ids: z.array(z.string()).default([]),
      rationale: z.string().min(3),
    })
    .optional(),
});

const proposalSchema = z.object({
  parent_gap_id: z.string(),
  addressed_name: z.string(),
  addressed_statement: z.string(),
  addressed_tactic_ids: z.array(z.string()),
  open_name: z.string(),
  open_statement: z.string(),
  uncovered_dimensions: z.array(z.string()),
  confidence: z.number(),
  rationale: z.array(z.string()),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposal: proposalSchema.nullable(),
  applied: z.boolean(),
  edit_id: z.string().nullable(),
});

export type SplitInput = z.infer<typeof inputSchema>;
export type SplitOutput = z.infer<typeof outputSchema>;

type Proposal = z.infer<typeof proposalSchema>;

const SPLIT_PROPOSER_SYSTEM = `You split a partially addressed evidence gap into two child gaps for an IEGP.

The addressed child is the slice the mapped tactics genuinely close. The open child is the leftover question that no mapped tactic answers. Neither child may restate the parent sentence verbatim.

Return JSON only: {"addressed_name":"","addressed_statement":"","open_name":"","open_statement":"","rationale":""}`;

async function llmProposal(
  ctx: ModuleContext,
  base: Proposal,
  context: { statement: string; tactics: { id: string; name: string; question: string }[] },
  hints: string,
): Promise<Proposal[]> {
  const payload = (await ctx.complete({
    system: SPLIT_PROPOSER_SYSTEM,
    user: JSON.stringify({
      hints: hints || undefined,
      parent_statement: context.statement,
      mapped_tactics: context.tactics,
      uncovered_dimensions: base.uncovered_dimensions,
      deterministic_draft: base,
    }),
    purpose: `split-proposer:${base.parent_gap_id}`,
  })) as {
    addressed_name?: string;
    addressed_statement?: string;
    open_name?: string;
    open_statement?: string;
    rationale?: string;
  };
  if (!payload.addressed_name || !payload.open_name) return [];
  return [
    {
      ...base,
      addressed_name: payload.addressed_name.trim(),
      addressed_statement: (payload.addressed_statement ?? payload.addressed_name).trim(),
      open_name: payload.open_name.trim(),
      open_statement: (payload.open_statement ?? payload.open_name).trim(),
      confidence: 70,
      rationale: [(payload.rationale ?? "model-proposed split").trim(), ...base.rationale],
    },
  ];
}

export const partialSplitModule: SynapseModule<SplitInput, SplitOutput> = {
  manifest: {
    id: "s6-partial-split.pcj",
    stage: "S6",
    version: "1.0.0",
    title: "Partial split proposal",
    summary:
      "Proposes the addressed slice and the open leftover for a partially addressed gap; applies only what the user validates.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "deterministic-draft", "rationale-required"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
    const state = await loadState();
    const gap = state.gaps.find((row) => row.id === input.gap_id);
    if (!gap) throw new Error(`Unknown gap ${input.gap_id}`);
    const coverages = state.coverages.filter((row) => row.gap_id === gap.id);
    const counting = countingCoverages(coverages, state.tactics);
    const mapped = counting
      .map((coverage) => state.tactics.find((tactic) => tactic.id === coverage.tactic_id))
      .filter((tactic): tactic is NonNullable<typeof tactic> => Boolean(tactic));
    const leftover = draftResidualGapSuggestion({ gap, coverages });
    const missing = uncoveredDimensions(coverages);

    const base: Proposal = {
      parent_gap_id: gap.id,
      addressed_name: gapNameFromStatement(
        mapped.length > 0
          ? `${gap.name} — slice covered by ${mapped[0]!.name}`
          : `${gap.name} — covered slice`,
      ),
      addressed_statement:
        mapped.length > 0
          ? `The part of "${gap.statement}" that ${mapped.map((tactic) => tactic.name).join(", ")} already answers.`
          : `The part of "${gap.statement}" already answered by existing evidence.`,
      addressed_tactic_ids: mapped.map((tactic) => tactic.id),
      open_name: leftover.statement,
      open_statement: leftover.statement,
      uncovered_dimensions: missing,
      confidence: mapped.length > 0 ? 65 : 45,
      rationale: leftover.reasons,
    };

    const outcome = await runAgenticCycle<Proposal>(ctx, "S6", {
      subjectOf: (proposal) => `${proposal.parent_gap_id}:${proposal.open_name}`,
      proposer: {
        local: () => [base],
        llm: canPrompt(ctx.route)
          ? ({ hints }) =>
              llmProposal(
                ctx,
                base,
                {
                  statement: gap.statement,
                  tactics: mapped.map((tactic) => ({
                    id: tactic.id,
                    name: tactic.name,
                    question: tactic.evidence_question,
                  })),
                },
                hints,
              )
          : undefined,
      },
      critic: (proposals) =>
        proposals.map((proposal) => {
          const notes: string[] = [];
          let score = proposal.confidence;
          if (proposal.addressed_tactic_ids.length === 0) {
            score -= 20;
            notes.push("no counting tactic to justify an addressed slice");
          }
          if (proposal.open_name.toLowerCase() === gap.statement.toLowerCase()) {
            score -= 30;
            notes.push("open child restates the parent");
          }
          if (missing.length === 0) {
            score -= 10;
            notes.push("no uncovered dimensions recorded");
          }
          return {
            subject: `${proposal.parent_gap_id}:${proposal.open_name}`,
            verdict: score >= 55 ? ("keep" as const) : score >= 35 ? ("revise" as const) : ("drop" as const),
            note: notes.length ? notes.join("; ") : "addressed slice and leftover are distinct",
            score: Math.max(0, Math.min(100, score)),
          };
        }),
      judge: ({ candidates, critiques }) =>
        candidates.map((proposal) => {
          const subject = `${proposal.parent_gap_id}:${proposal.open_name}`;
          const critique = critiques.find((item) => item.subject === subject);
          const score = critique?.score ?? 50;
          return {
            candidate: proposal,
            subject,
            verdict: score >= 35 ? ("accept" as const) : ("reject" as const),
            score,
            note: critique?.note ?? "no critique",
          };
        }),
    });

    const best = outcome.accepted[0] ?? outcome.proposed[0] ?? null;
    let edit_id: string | null = null;

    if (input.apply) {
      await splitPartialGap({
        parent_gap_id: gap.id,
        addressed_name: input.apply.addressed_name,
        addressed_statement: input.apply.addressed_statement,
        open_name: input.apply.open_name,
        open_statement: input.apply.open_statement,
        tactic_ids: input.apply.addressed_tactic_ids,
        open_tactic_ids: input.apply.open_tactic_ids,
        actor_name: ctx.actor.name,
        actor_function: ctx.actor.function,
        note: input.apply.rationale,
      });
      const edit = await recordEdit({
        workspace_id: ctx.workspace_id,
        stage: "S6",
        entity_type: "gap",
        entity_id: gap.id,
        field: "split",
        action: "split",
        before: gap.statement,
        after: `${input.apply.addressed_name} | ${input.apply.open_name}`,
        rationale: input.apply.rationale,
        actor: ctx.actor,
      });
      edit_id = edit.id;
    }

    return {
      output: {
        mode: outcome.mode,
        proposal: best
          ? { ...best, confidence: outcome.judged.find((item) => item.candidate === best)?.score ?? best.confidence }
          : null,
        applied: Boolean(input.apply),
        edit_id,
      },
      summary: input.apply
        ? `Split ${gap.id} into an addressed slice and an open leftover — "${input.apply.rationale}"`
        : `Proposed a split for ${gap.id}`,
      evals: outcome.metrics,
    };
  },
};

registerModule(partialSplitModule);
