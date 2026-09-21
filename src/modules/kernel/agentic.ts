import type { EvalScore, ModuleContext, StageId } from "./contracts";
import { canPrompt } from "./routing";
import { digestAsPrompt, hillclimbDigest } from "./hillclimb";

export type Critique = {
  subject: string;
  verdict: "keep" | "revise" | "drop";
  note: string;
  /** 0–100 confidence that this candidate belongs in the output. */
  score: number;
};

export type JudgedCandidate<C> = {
  candidate: C;
  subject: string;
  verdict: "accept" | "reject";
  score: number;
  note: string;
};

export type AgenticCycle<C> = {
  /** Stable identity used to join proposals with critiques. */
  subjectOf: (candidate: C) => string;
  proposer: {
    /** LLM path. Omitted or skipped when the route cannot prompt. */
    llm?: (args: { hints: string }) => Promise<C[]>;
    /** Always available. Keeps the stage end-to-end with no provider connected. */
    local: () => Promise<C[]> | C[];
  };
  critic: (candidates: C[]) => Promise<Critique[]> | Critique[];
  judge: (args: { candidates: C[]; critiques: Critique[] }) => JudgedCandidate<C>[];
};

export type AgenticOutcome<C> = {
  mode: "llm" | "deterministic";
  proposed: C[];
  critiques: Critique[];
  judged: JudgedCandidate<C>[];
  accepted: C[];
  rejected: JudgedCandidate<C>[];
  metrics: EvalScore[];
};

/**
 * The proposer → critic → judge loop every agentic stage shares. The loop is
 * stage-agnostic: stages supply the three roles, the kernel supplies routing,
 * observability, and the hillclimb hints that precede the proposal.
 */
export async function runAgenticCycle<C>(
  ctx: ModuleContext,
  stage: StageId,
  cycle: AgenticCycle<C>,
): Promise<AgenticOutcome<C>> {
  const digest = await hillclimbDigest(stage);
  const hints = digestAsPrompt(digest);
  ctx.run.note("hillclimb:hints", { open: digest.open, corrections: digest.corrections });

  let mode: "llm" | "deterministic" = "deterministic";
  let proposed: C[] = [];
  if (cycle.proposer.llm && canPrompt(ctx.route)) {
    try {
      proposed = await ctx.run.step("proposer:llm", () => cycle.proposer.llm!({ hints }));
      mode = "llm";
    } catch (error) {
      ctx.run.note("proposer:llm_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (proposed.length === 0) {
    proposed = await ctx.run.step("proposer:local", () => cycle.proposer.local());
    mode = proposed.length > 0 && mode === "llm" ? "llm" : "deterministic";
  }

  const critiques = await ctx.run.step("critic", () => cycle.critic(proposed));
  const judged = await ctx.run.step("judge", () => cycle.judge({ candidates: proposed, critiques }));
  const accepted = judged.filter((item) => item.verdict === "accept").map((item) => item.candidate);
  const rejected = judged.filter((item) => item.verdict === "reject");

  const acceptRate = judged.length === 0 ? 0 : accepted.length / judged.length;
  const avgScore =
    judged.length === 0 ? 0 : judged.reduce((sum, item) => sum + item.score, 0) / judged.length / 100;
  const metrics: EvalScore[] = [
    { name: "proposed", value: proposed.length, unit: "count" },
    { name: "accept_rate", value: Number(acceptRate.toFixed(3)), unit: "ratio", target: 0.3 },
    { name: "judge_confidence", value: Number(avgScore.toFixed(3)), unit: "ratio", target: 0.5 },
  ];

  return { mode, proposed, critiques, judged, accepted, rejected, metrics };
}

/** Critic default: keep everything, scored by a stage-supplied scorer. */
export function scoreCritic<C>(
  subjectOf: (candidate: C) => string,
  score: (candidate: C) => { score: number; note: string },
) {
  return (candidates: C[]): Critique[] =>
    candidates.map((candidate) => {
      const { score: value, note } = score(candidate);
      return {
        subject: subjectOf(candidate),
        verdict: value >= 60 ? "keep" : value >= 35 ? "revise" : "drop",
        note,
        score: value,
      };
    });
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
