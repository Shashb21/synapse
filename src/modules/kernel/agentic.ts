import type { EvalScore, ModuleContext, StageId } from "./contracts";
import { canPrompt } from "./routing";
import { digestAsPrompt, hillclimbDigest } from "./hillclimb";

/**
 * Locked shape of every agentic stage: propose → critique → revise, three times,
 * and only then the judge. One exchange is one critic response plus the revision
 * the proposer makes in answer to it.
 */
export const PROPOSER_CRITIC_EXCHANGES = 3;

export type Critique = {
  subject: string;
  verdict: "keep" | "revise" | "drop";
  note: string;
  /** 0–100 confidence that this candidate belongs in the output. */
  score: number;
  /**
   * Machine-readable defects the reviser can act on, e.g. `no_quote`,
   * `duplicate`, `too_long`. Free-text notes stay in `note`.
   */
  issues?: string[];
};

export type JudgedCandidate<C> = {
  candidate: C;
  subject: string;
  verdict: "accept" | "reject";
  score: number;
  note: string;
};

export type ProposerArgs<C> = {
  /** Reviewer corrections from earlier runs of this stage. */
  hints: string;
  /** 1 on the first proposal; 2 and 3 are revisions answering the critic. */
  round: number;
  /** Critiques of `previous`. Empty on round 1. */
  critiques: Critique[];
  /** What the proposer said last round. Empty on round 1. */
  previous: C[];
};

export type AgenticCycle<C> = {
  /**
   * Stable identity. A revision keeps a candidate's subject so critiques, the
   * judge and the trace all line up across rounds.
   */
  subjectOf: (candidate: C) => string;
  proposer: {
    /** LLM path. Omitted or skipped when the route cannot prompt. */
    llm?: (args: ProposerArgs<C>) => Promise<C[]>;
    /** Always available, so the loop runs with no provider connected. */
    local: (args: ProposerArgs<C>) => C[] | Promise<C[]>;
  };
  critic: (candidates: C[], round: number) => Promise<Critique[]> | Critique[];
  judge: (args: { candidates: C[]; critiques: Critique[] }) => JudgedCandidate<C>[];
};

export type AgenticRound = {
  round: number;
  /** Where this round's candidate set came from. */
  proposer: "llm" | "local";
  in: number;
  critiqued: number;
  kept: number;
  to_revise: number;
  dropped: number;
  /** Candidate count the proposer handed forward after answering the critic. */
  out: number;
  avg_score: number;
};

export type AgenticOutcome<C> = {
  mode: "llm" | "deterministic";
  /** The first proposal, before any critique. */
  proposed: C[];
  /** One entry per proposer↔critic exchange, in order. */
  rounds: AgenticRound[];
  /** Critiques from the last exchange, the ones the judge saw. */
  critiques: Critique[];
  /**
   * Candidates the proposer withdrew during the dialogue, with the last critique
   * against them. They never reach the judge, so without this they would vanish
   * from the record.
   */
  withdrawn: { subject: string; note: string; score: number; issues?: string[] }[];
  judged: JudgedCandidate<C>[];
  accepted: C[];
  rejected: JudgedCandidate<C>[];
  metrics: EvalScore[];
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The loop every agentic stage shares. Stages supply the three roles; the kernel
 * supplies routing, the hillclimb hints that precede the first proposal, the
 * fixed number of exchanges, and a trace with every round in it.
 */
export async function runAgenticCycle<C>(
  ctx: ModuleContext,
  stage: StageId,
  cycle: AgenticCycle<C>,
): Promise<AgenticOutcome<C>> {
  const digest = await hillclimbDigest(stage);
  const hints = digestAsPrompt(digest);
  ctx.run.note("hillclimb:hints", { open: digest.open, corrections: digest.corrections });

  const propose = async (args: ProposerArgs<C>): Promise<{ candidates: C[]; via: "llm" | "local" }> => {
    if (cycle.proposer.llm && canPrompt(ctx.route)) {
      try {
        const candidates = await cycle.proposer.llm(args);
        if (candidates.length > 0) return { candidates, via: "llm" };
      } catch (error) {
        ctx.run.note(`round${args.round}:proposer_llm_failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { candidates: await cycle.proposer.local(args), via: "local" };
  };

  const first = await ctx.run.step(
    "round1:proposer",
    () => propose({ hints, round: 1, critiques: [], previous: [] }),
    "initial proposal",
  );
  const proposed = first.candidates;
  let candidates = first.candidates;
  let usedLlm = first.via === "llm";
  let critiques: Critique[] = [];
  const rounds: AgenticRound[] = [];
  const firstRoundScores: number[] = [];
  const lastCritiqueBySubject = new Map<string, Critique>();

  for (let round = 1; round <= PROPOSER_CRITIC_EXCHANGES; round += 1) {
    const incoming = candidates.length;
    critiques = await ctx.run.step(
      `round${round}:critic`,
      () => cycle.critic(candidates, round),
      `${incoming} candidate(s) under review`,
    );
    const scores = critiques.map((critique) => critique.score);
    if (round === 1) firstRoundScores.push(...scores);
    for (const critique of critiques) lastCritiqueBySubject.set(critique.subject, critique);

    // The proposer answers this critique. On the last exchange its answer is what
    // the judge sees, scored by the critique that produced it.
    const revision = await ctx.run.step(
      `round${round}:proposer-revise`,
      () => propose({ hints, round: round + 1, critiques, previous: candidates }),
      `answering ${critiques.filter((critique) => critique.verdict !== "keep").length} objection(s)`,
    );
    candidates = revision.candidates;
    if (revision.via === "llm") usedLlm = true;

    rounds.push({
      round,
      proposer: revision.via,
      in: incoming,
      critiqued: critiques.length,
      kept: critiques.filter((critique) => critique.verdict === "keep").length,
      to_revise: critiques.filter((critique) => critique.verdict === "revise").length,
      dropped: critiques.filter((critique) => critique.verdict === "drop").length,
      out: candidates.length,
      avg_score: Math.round(average(scores)),
    });
  }

  const surviving = new Set(candidates.map((candidate) => cycle.subjectOf(candidate)));
  const judgeCritiques = critiques.filter((critique) => surviving.has(critique.subject));
  const withdrawn = [...lastCritiqueBySubject.values()]
    .filter((critique) => !surviving.has(critique.subject))
    .map((critique) => ({
      subject: critique.subject,
      note: critique.note,
      score: critique.score,
      issues: critique.issues,
    }));
  if (withdrawn.length > 0) {
    ctx.run.note("withdrawn-in-dialogue", withdrawn, `${withdrawn.length} candidate(s) never reached the judge`);
  }
  const judged = await ctx.run.step(
    "judge",
    () => cycle.judge({ candidates, critiques: judgeCritiques }),
    `${candidates.length} candidate(s) after ${PROPOSER_CRITIC_EXCHANGES} exchange(s)`,
  );
  const accepted = judged.filter((item) => item.verdict === "accept").map((item) => item.candidate);
  const rejected = judged.filter((item) => item.verdict === "reject");

  const acceptRate = judged.length === 0 ? 0 : accepted.length / judged.length;
  const judgeConfidence = average(judged.map((item) => item.score)) / 100;
  const firstAvg = average(firstRoundScores);
  const lastAvg = rounds.at(-1)?.avg_score ?? 0;

  const metrics: EvalScore[] = [
    { name: "proposed", value: proposed.length, unit: "count" },
    { name: "exchanges", value: rounds.length, unit: "count", target: PROPOSER_CRITIC_EXCHANGES },
    {
      name: "dialogue_retention",
      value:
        proposed.length === 0 ? 0 : Number((candidates.length / proposed.length).toFixed(3)),
      unit: "ratio",
      detail: `${proposed.length} proposed, ${candidates.length} survived the dialogue`,
    },
    {
      name: "critic_score_gain",
      value: Number(((lastAvg - firstAvg) / 100).toFixed(3)),
      unit: "ratio",
      detail: `round 1 ${Math.round(firstAvg)} → round ${rounds.length} ${lastAvg}`,
    },
    { name: "withdrawn_in_dialogue", value: withdrawn.length, unit: "count" },
    { name: "accept_rate", value: Number(acceptRate.toFixed(3)), unit: "ratio", target: 0.3 },
    { name: "judge_confidence", value: Number(judgeConfidence.toFixed(3)), unit: "ratio", target: 0.5 },
  ];

  ctx.run.note("exchanges", rounds, `${rounds.length} proposer↔critic exchange(s) before the judge`);

  return {
    mode: usedLlm ? "llm" : "deterministic",
    proposed,
    rounds,
    critiques,
    withdrawn,
    judged,
    accepted,
    rejected,
    metrics,
  };
}

/** Critic default: scores every candidate with a stage-supplied scorer. */
export function scoreCritic<C>(
  subjectOf: (candidate: C) => string,
  score: (candidate: C, round: number) => { score: number; note: string; issues?: string[] },
) {
  return (candidates: C[], round: number): Critique[] =>
    candidates.map((candidate) => {
      const { score: value, note, issues } = score(candidate, round);
      return {
        subject: subjectOf(candidate),
        verdict: value >= 60 ? "keep" : value >= 35 ? "revise" : "drop",
        note,
        score: value,
        issues,
      };
    });
}

/**
 * Reviser default: the proposer concedes every drop and keeps the rest. Stages
 * that can actually repair a candidate pass their own reviser instead.
 */
export function concedeDrops<C>(subjectOf: (candidate: C) => string) {
  return ({ previous, critiques }: { previous: C[]; critiques: Critique[] }): C[] =>
    previous.filter(
      (candidate) =>
        critiques.find((critique) => critique.subject === subjectOf(candidate))?.verdict !== "drop",
    );
}

/** Judge default: accept anything the critic did not drop and that clears the floor. */
export function thresholdJudge<C>(subjectOf: (candidate: C) => string, floor = 40) {
  return ({ candidates, critiques }: { candidates: C[]; critiques: Critique[] }): JudgedCandidate<C>[] =>
    candidates.map((candidate) => {
      const subject = subjectOf(candidate);
      const critique = critiques.find((item) => item.subject === subject);
      const score = critique?.score ?? 50;
      const accept = critique?.verdict !== "drop" && score >= floor;
      return {
        candidate,
        subject,
        verdict: accept ? "accept" : "reject",
        score,
        note: critique?.note ?? "No critique recorded; judged on default confidence.",
      };
    });
}

/** True when a critique flagged this defect. */
export function hasIssue(critique: Critique | undefined, issue: string): boolean {
  return Boolean(critique?.issues?.includes(issue));
}
