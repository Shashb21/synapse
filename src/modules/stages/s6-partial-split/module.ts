import { z } from "zod";
import { registerModule } from "@/modules/kernel/registry";
import { recordEdit } from "@/modules/kernel/edit-records";
import { PROPOSER_CRITIC_EXCHANGES, runAgenticCycle } from "@/modules/kernel/agentic";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { loadState, splitPartialGap } from "@/lib/iegp/store";
import { displayedGapStatus, tacticCountsTowardAddressing } from "@/lib/iegp/engine";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";

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
type Review = { verdict: "keep" | "revise"; confidence: number; note: string; issues: string[] };
type Judgement = { verdict: "accept" | "reject"; confidence: number; note: string };

const REMEDY = "run the split proposal again or switch the S6 route in /admin/control.";

const SPLIT_PROPOSER_SYSTEM = `You split a partially addressed evidence gap from a pharma Integrated Evidence Generation Plan into two child gaps.

You are given the parent gap, the evidence needs behind it, and every tactic mapped to it with its pressure-test coverage verdict (overall and per dimension, with rationales; human_locked marks a verdict a person confirmed). Only tactics with counts_toward_addressing true can close part of a gap.

- The addressed child is the slice the mapped tactics genuinely close. addressed_tactic_ids lists the tactics that close it, chosen only from tactics with counts_toward_addressing true; name at least one.
- The open child is the leftover question that no mapped tactic answers. uncovered_dimensions lists the coverage dimensions (from coverage_dimensions) the leftover is about; name at least one.
- Names are short gap titles; statements are one full sentence each. Neither child may restate the parent verbatim, and the two children must not overlap.
- confidence is 0–100 that this split is right. rationale says, in one or two sentences, which coverage evidence drove the split.

When you are given a previous proposal and a critic objection, answer the objection: change what it names, or keep it and say why in the rationale.

Return JSON only: {"addressed_name":"","addressed_statement":"","addressed_tactic_ids":[""],"open_name":"","open_statement":"","uncovered_dimensions":[""],"confidence":0,"rationale":""}`;

const SPLIT_CRITIC_SYSTEM = `You review a proposed split of a partially addressed evidence gap from a pharma Integrated Evidence Generation Plan into an addressed child and an open leftover child.

Check the proposal against the parent gap, its evidence needs, and the coverage verdicts of the mapped tactics. Challenge an addressed slice the named tactics do not actually close, a leftover that some mapped tactic already answers or that misses what is still uncovered, uncovered dimensions the coverage does not support, children that restate the parent or overlap each other, and anything that contradicts a reviewer correction.

verdict is "keep" when the split is defensible and "revise" when anything should change. confidence is 0–100 that the split is right. note names what should change and why; for "keep" say briefly why it holds. issues is a list of short snake_case defect labels (empty for "keep").

Return JSON only: {"verdict":"keep","confidence":0,"note":"","issues":[]}`;

const SPLIT_JUDGE_SYSTEM = `You are the final judge of a proposed split of a partially addressed evidence gap from a pharma Integrated Evidence Generation Plan into an addressed child and an open leftover child. The proposal has been through ${PROPOSER_CRITIC_EXCHANGES} proposer–critic exchanges; you see the final version and the last critique.

Accept the split when a reviewer could adopt it as a starting point: the addressed slice is really closed by the named tactics, the leftover is a real open question no mapped tactic answers, and neither child restates the parent. Reject it otherwise; a rejected split is not shown to the user.

confidence is 0–100 that the split is right. note gives the reason in one or two sentences.

Return JSON only: {"verdict":"accept","confidence":0,"note":""}`;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function confidenceOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))];
}

/**
 * Reads a proposer answer. An answer with a field missing, or naming a tactic or
 * dimension the gap does not allow, is left out so the caller asks again;
 * nothing is filled in on the model's behalf.
 */
function parseProposal(raw: unknown, gapId: string, countingIds: Set<string>): Proposal | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const addressed_name = nonEmpty(row.addressed_name);
  const addressed_statement = nonEmpty(row.addressed_statement);
  const open_name = nonEmpty(row.open_name);
  const open_statement = nonEmpty(row.open_statement);
  const rationale = nonEmpty(row.rationale);
  const confidence = confidenceOf(row.confidence);
  const tactics = stringList(row.addressed_tactic_ids);
  const dimensions = stringList(row.uncovered_dimensions);
  if (!addressed_name || !addressed_statement || !open_name || !open_statement || !rationale) return null;
  if (confidence === null || !tactics || !dimensions) return null;
  if (tactics.length === 0 || tactics.some((id) => !countingIds.has(id))) return null;
  const allowed: readonly string[] = COVERAGE_DIMENSIONS;
  if (dimensions.length === 0 || dimensions.some((dimension) => !allowed.includes(dimension))) return null;
  return {
    parent_gap_id: gapId,
    addressed_name,
    addressed_statement,
    addressed_tactic_ids: tactics,
    open_name,
    open_statement,
    uncovered_dimensions: dimensions,
    confidence,
    rationale: [rationale],
  };
}

function parseReview(raw: unknown): Review | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  if (row.verdict !== "keep" && row.verdict !== "revise") return null;
  const confidence = confidenceOf(row.confidence);
  const note = nonEmpty(row.note);
  if (confidence === null || !note) return null;
  return { verdict: row.verdict, confidence, note, issues: stringList(row.issues) ?? [] };
}

function parseJudgement(raw: unknown): Judgement | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  if (row.verdict !== "accept" && row.verdict !== "reject") return null;
  const confidence = confidenceOf(row.confidence);
  const note = nonEmpty(row.note);
  if (confidence === null || !note) return null;
  return { verdict: row.verdict, confidence, note };
}

function promptProposal(proposal: Proposal) {
  return {
    addressed_name: proposal.addressed_name,
    addressed_statement: proposal.addressed_statement,
    addressed_tactic_ids: proposal.addressed_tactic_ids,
    open_name: proposal.open_name,
    open_statement: proposal.open_statement,
    uncovered_dimensions: proposal.uncovered_dimensions,
    confidence: proposal.confidence,
    rationale: proposal.rationale.join(" "),
  };
}

export const partialSplitModule: SynapseModule<SplitInput, SplitOutput> = {
  manifest: {
    id: "s6-partial-split.pcj",
    stage: "S6",
    version: "2.0.0",
    title: "Partial split proposal",
    summary:
      "A model proposes the addressed slice and the open leftover for a partially addressed gap, a model critic challenges it over three exchanges and a model judge decides whether it is shown; applies only what the user validates. Proposing needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "llm-critic", "llm-judge", "rationale-required"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
    if (input.apply) return applySplit(input.gap_id, input.apply, ctx);

    requireLlm(ctx, "The partial split proposal");
    const state = await loadState();
    const gap = state.gaps.find((row) => row.id === input.gap_id);
    if (!gap) throw new Error(`Unknown gap ${input.gap_id}`);
    const coverages = state.coverages.filter((row) => row.gap_id === gap.id);
    const tacticById = new Map(state.tactics.map((tactic) => [tactic.id, tactic]));
    const countingIds = new Set(
      coverages
        .map((coverage) => tacticById.get(coverage.tactic_id))
        .filter((tactic) => tactic !== undefined && tacticCountsTowardAddressing(tactic))
        .map((tactic) => tactic!.id),
    );
    if (countingIds.size === 0) {
      throw new Error(
        `${gap.id} has no completed, ongoing or planned tactic mapped, so no tactic can close an addressed slice. Map the tactic that closes part of it, or rewrite the gap instead of splitting it.`,
      );
    }
    const needIds = new Set(
      state.need_gap_links.filter((link) => link.gap_id === gap.id).map((link) => link.need_id),
    );
    // What every model call sees: the facts of the gap, never a pre-drafted split.
    const facts = {
      gap: { id: gap.id, name: gap.name, statement: gap.statement, domain: gap.domain },
      evidence_needs: state.needs
        .filter((need) => needIds.has(need.id))
        .map((need) => ({
          id: need.id,
          statement: need.statement,
          stakeholder: need.stakeholder,
          decision_supported: need.decision_supported,
          population: need.population,
          intervention: need.intervention,
          comparator: need.comparator,
          outcome: need.outcome,
          geography: need.geography,
          timing: need.timing,
        })),
      mapped_tactics: coverages.flatMap((coverage) => {
        const tactic = tacticById.get(coverage.tactic_id);
        if (!tactic) return [];
        return [
          {
            id: tactic.id,
            name: tactic.name,
            type: tactic.type,
            status: tactic.status,
            counts_toward_addressing: countingIds.has(tactic.id),
            evidence_question: tactic.evidence_question,
            population: tactic.population,
            intervention: tactic.intervention,
            comparator: tactic.comparator,
            outcomes: tactic.outcomes,
            geography: tactic.geography,
            coverage: {
              overall: coverage.overall,
              rationale: coverage.overall_rationale,
              human_locked: coverage.overall_lock.locked,
              dimensions: Object.fromEntries(
                Object.entries(coverage.dimensions).map(([dimension, assessment]) => [
                  dimension,
                  { value: assessment.value, rationale: assessment.rationale },
                ]),
              ),
            },
          },
        ];
      }),
      coverage_dimensions: COVERAGE_DIMENSIONS,
    };

    // The kernel hands reviewer corrections to the proposer; the critic and judge weigh them too.
    let reviewerHints = "";
    let judgement: Judgement | null = null;

    /** One model answer for this gap, asked again while it is incomplete or invalid. */
    const askOne = async <T,>(args: {
      what: string;
      system: string;
      purpose: string;
      retryNote: string;
      body: Record<string, unknown>;
      parse: (raw: unknown) => T | null;
    }): Promise<T> => {
      const answers = await completeAll({
        ids: [gap.id],
        what: args.what,
        describe: () => gap.name,
        remedy: REMEDY,
        ask: async (_missing, attempt) => {
          const payload = await ctx.complete({
            system: args.system,
            user: JSON.stringify({
              reviewer_corrections: reviewerHints || undefined,
              note: attempt > 1 ? args.retryNote : undefined,
              ...facts,
              ...args.body,
            }),
            purpose: `${args.purpose}:${gap.id}`,
          });
          const row = args.parse(payload);
          return new Map(row === null ? [] : [[gap.id, row]]);
        },
      });
      return answers.get(gap.id)!;
    };

    const propose = (round: number, previous?: Proposal, objection?: string) =>
      askOne({
        what: "split proposal",
        system: SPLIT_PROPOSER_SYSTEM,
        purpose: "split-proposer",
        retryNote:
          "An earlier answer was incomplete, or named a tactic or dimension that is not allowed. Return every field.",
        body: {
          exchange: round > 1 ? `${round - 1} of ${PROPOSER_CRITIC_EXCHANGES}` : undefined,
          previous: previous ? promptProposal(previous) : undefined,
          objection,
        },
        parse: (raw) => parseProposal(raw, gap.id, countingIds),
      });

    const outcome = await runAgenticCycle<Proposal>(ctx, "S6", {
      // One split per gap: the subject stays put while the proposer revises it.
      subjectOf: (proposal) => proposal.parent_gap_id,
      proposer: {
        /**
         * Test stub only: the kernel calls this when SYNAPSE_TEST_STUB_LLM is set
         * and never otherwise. The split is labelled as stub output, so it cannot
         * pass for a judgement.
         */
        local: ({ round, previous }) => {
          if (!isTestStub()) throw new NoRouteError("The partial split has no rule-based fallback.");
          if (round > 1) return previous;
          return [
            {
              parent_gap_id: gap.id,
              addressed_name: `Test stub: addressed slice of ${gap.name}`,
              addressed_statement: `Test stub: the part of ${gap.id} the mapped tactics close. No model was called.`,
              addressed_tactic_ids: [...countingIds],
              open_name: `Test stub: open leftover of ${gap.name}`,
              open_statement: `Test stub: the part of ${gap.id} no mapped tactic answers. No model was called.`,
              uncovered_dimensions: [],
              confidence: 50,
              rationale: ["Test stub: no model was called."],
            },
          ];
        },
        llm: async ({ hints, round, critiques, previous }) => {
          reviewerHints = hints;
          const critique = critiques.find((item) => item.subject === gap.id);
          let current = previous[0];
          if (!current) {
            current = await propose(round);
          } else if (critique && critique.verdict !== "keep") {
            current = await propose(round, current, critique.note);
          }
          // The kernel's judge cannot call a model, so the model judge rules on the
          // final revision here and the judge below only reports its ruling.
          if (round === PROPOSER_CRITIC_EXCHANGES + 1) {
            judgement = await askOne({
              what: "split judgement",
              system: SPLIT_JUDGE_SYSTEM,
              purpose: "split-judge",
              retryNote: "An earlier answer was incomplete. Return verdict, confidence and note.",
              body: { proposal: promptProposal(current), last_critique: critique?.note },
              parse: parseJudgement,
            });
            ctx.run.note("judge:model", judgement, `model judge: ${judgement.verdict}`);
          }
          return [current];
        },
      },
      critic: async (proposals, round) => {
        if (isTestStub()) {
          return proposals.map((proposal) => ({
            subject: proposal.parent_gap_id,
            verdict: "keep" as const,
            note: "Test stub: no model critic was called.",
            score: 50,
          }));
        }
        return Promise.all(
          proposals.map(async (proposal) => {
            const review = await askOne({
              what: "split review",
              system: SPLIT_CRITIC_SYSTEM,
              purpose: "split-critic",
              retryNote: "An earlier answer was incomplete. Return verdict, confidence and note.",
              body: { exchange: `${round} of ${PROPOSER_CRITIC_EXCHANGES}`, proposal: promptProposal(proposal) },
              parse: parseReview,
            });
            return {
              subject: proposal.parent_gap_id,
              verdict: review.verdict,
              note: review.note,
              score: review.confidence,
              issues: review.issues,
            };
          }),
        );
      },
      judge: ({ candidates }) =>
        candidates.map((proposal) => {
          const ruling: Judgement | null = isTestStub()
            ? { verdict: "accept", confidence: 50, note: "Test stub: no model judge was called." }
            : judgement;
          if (!ruling) {
            throw new Error(`The model judge never ruled on the split for ${gap.name}. Nothing was proposed; ${REMEDY}`);
          }
          return {
            candidate: proposal,
            subject: proposal.parent_gap_id,
            verdict: ruling.verdict,
            score: ruling.confidence,
            note: ruling.note,
          };
        }),
    });

    // Only a split the model judge accepted is shown. A rejected split is never
    // swapped for an earlier draft; the user fills the split in or runs S6 again.
    const accepted = outcome.judged.find((item) => item.verdict === "accept");
    const rejected = outcome.rejected[0];
    const proposal = accepted
      ? { ...accepted.candidate, rationale: [...accepted.candidate.rationale, `Judge: ${accepted.note}`] }
      : null;

    return {
      output: { mode: outcome.mode, proposal, applied: false, edit_id: null },
      summary: proposal
        ? `Proposed a split for ${gap.id}`
        : `No split proposed for ${gap.id}: the model judge rejected it${
            rejected ? ` — "${rejected.note}"` : ""
          }. Fill the split in yourself or run S6 again.`,
      evals: outcome.metrics,
    };
  },
};

/** The user validated a split: apply exactly what they sent. No model is asked. */
async function applySplit(
  gapId: string,
  apply: NonNullable<SplitInput["apply"]>,
  ctx: ModuleContext,
): Promise<{ output: SplitOutput; summary: string }> {
  const state = await loadState();
  const gap = state.gaps.find((row) => row.id === gapId);
  if (!gap) throw new Error(`Unknown gap ${gapId}`);
  await splitPartialGap({
    parent_gap_id: gap.id,
    addressed_name: apply.addressed_name,
    addressed_statement: apply.addressed_statement,
    open_name: apply.open_name,
    open_statement: apply.open_statement,
    tactic_ids: apply.addressed_tactic_ids,
    open_tactic_ids: apply.open_tactic_ids,
    actor_name: ctx.actor.name,
    actor_function: ctx.actor.function,
    note: apply.rationale,
  });
  const edit = await recordEdit({
    workspace_id: ctx.workspace_id,
    stage: "S6",
    entity_type: "gap",
    entity_id: gap.id,
    field: "split",
    action: "split",
    before: gap.statement,
    after: `${apply.addressed_name} | ${apply.open_name}`,
    rationale: apply.rationale,
    actor: ctx.actor,
  });
  return {
    output: {
      mode: isTestStub() ? "deterministic" : "llm",
      proposal: null,
      applied: true,
      edit_id: edit.id,
    },
    summary: `Split ${gap.id} into an addressed slice and an open leftover — "${apply.rationale}"`,
  };
}

partialSplitModule.evals = {
  async cases() {
    // Gold cases are the partially addressed gaps in the workspace. Proposing is
    // read-only, so scoring never applies a split.
    const state = await loadState();
    return state.gaps
      .filter((gap) => !gap.retired && displayedGapStatus(gap) === "validated_partial")
      .slice(0, 4)
      .map((gap) => ({ name: gap.id, input: { gap_id: gap.id } }));
  },
  score({ case: testCase, output }) {
    const proposal = output.proposal;
    return [
      { name: "proposal_returned", value: proposal ? 1 : 0, unit: "ratio", target: 1 },
      {
        name: "leftover_is_new_text",
        value: proposal && proposal.open_name.trim() && proposal.open_name !== proposal.addressed_name ? 1 : 0,
        unit: "ratio",
        target: 1,
        detail: testCase.name,
      },
      {
        name: "addressed_slice_has_a_tactic",
        value: proposal && proposal.addressed_tactic_ids.length > 0 ? 1 : 0,
        unit: "ratio",
        target: 1,
      },
    ];
  },
};

registerModule(partialSplitModule);
