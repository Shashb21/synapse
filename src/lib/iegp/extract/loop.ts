import {
  criticPayloadSchema,
  extractGapSchema,
  GAP_EXTRACT_CAP,
  GAP_EXTRACT_ROUNDS,
  judgePayloadSchema,
  proposerPayloadSchema,
  type CriticPayload,
  type ExtractGap,
  type ExtractNeed,
  type ExtractRoundTrace,
  type GapExtractResult,
  type JudgePayload,
  type NormalizedSource,
  type ProposerPayload,
} from "./contracts";
import { completeExtractJson } from "./client";
import { packNormalizedSource } from "./normalize";
import {
  CRITIC_SYSTEM_PROMPT,
  GAP_PROMPT_REGISTRY,
  gapPromptByVersion,
  JUDGE_SYSTEM_PROMPT,
  type GapPromptVersion,
} from "./prompts";

export type HumanFewShot = {
  kind: "wording" | "not_a_gap" | "missed" | "is_a_gap";
  before?: string;
  after?: string;
  note?: string;
};

function parseProposer(raw: unknown): ProposerPayload {
  const parsed = proposerPayloadSchema.parse(raw);
  return {
    ...parsed,
    gaps: parsed.gaps.slice(0, GAP_EXTRACT_CAP).map((g) => extractGapSchema.parse(g)),
  };
}

function formatFewShots(shots: HumanFewShot[]): string {
  if (shots.length === 0) return "";
  const lines = shots.slice(0, 12).map((s) => {
    if (s.kind === "wording") {
      return `- Human rewrote wording. Before: ${s.before ?? "—"} After: ${s.after ?? "—"}`;
    }
    if (s.kind === "not_a_gap") {
      return `- Human said this is NOT a gap: ${s.before ?? s.after ?? "—"} ${s.note ?? ""}`;
    }
    if (s.kind === "missed") {
      return `- Human added a missed gap: ${s.after ?? "—"}`;
    }
    return `- Human confirmed this IS a gap: ${s.after ?? s.before ?? "—"}`;
  });
  return `\n\nHuman feedback the extractor must internalise:\n${lines.join("\n")}`;
}

async function timedJson(args: {
  system: string;
  user: string;
  maxTokens?: number;
  purpose?: "proposer" | "critic" | "judge";
}): Promise<{ json: unknown; ms: number }> {
  const started = Date.now();
  const json = await completeExtractJson(args);
  return { json, ms: Date.now() - started };
}

function previousBundle(rounds: ExtractRoundTrace[]): string {
  if (rounds.length === 0) return "No previous round.";
  const last = rounds[rounds.length - 1]!;
  return `Previous proposer JSON:\n${JSON.stringify({ gaps: last.proposer.gaps, needs: last.proposer.needs }, null, 2)}\n\nPrevious critic findings:\n${JSON.stringify(last.critic, null, 2)}`;
}

export async function runGapExtractionLoop(args: {
  source: NormalizedSource;
  prompt?: GapPromptVersion;
  promptVersion?: string;
  fewShots?: HumanFewShot[];
  includeGold?: boolean;
  goldForSource?: { id: string; name: string; statement: string; is_gap: boolean }[];
}): Promise<GapExtractResult> {
  const prompt =
    args.prompt ??
    (args.promptVersion
      ? gapPromptByVersion(args.promptVersion)
      : GAP_PROMPT_REGISTRY[GAP_PROMPT_REGISTRY.length - 1]!);
  const packed = packNormalizedSource(args.source);
  const few = formatFewShots(args.fewShots ?? []);
  const goldBlock =
    args.includeGold && args.goldForSource && args.goldForSource.length > 0
      ? `\n\nGold for this source (eval only — do not copy blindly):\n${JSON.stringify(args.goldForSource, null, 2)}`
      : "";

  const rounds: ExtractRoundTrace[] = [];
  for (let round = 1; round <= GAP_EXTRACT_ROUNDS; round += 1) {
    const proposerUser = `${packed}${few}

Round ${round} of ${GAP_EXTRACT_ROUNDS}. Revise using the critic if a previous round exists.

${previousBundle(rounds)}`;
    const proposed = await timedJson({
      system: prompt.system_prompt,
      user: proposerUser,
      purpose: "proposer",
    });
    const proposer = parseProposer(proposed.json);

    const criticUser = `${packed}${goldBlock}

Proposer output to critique:
${JSON.stringify({ gaps: proposer.gaps, needs: proposer.needs }, null, 2)}`;
    const critiqued = await timedJson({
      system: CRITIC_SYSTEM_PROMPT,
      user: criticUser,
      purpose: "critic",
    });
    const critic: CriticPayload = criticPayloadSchema.parse(critiqued.json);
    rounds.push({
      round,
      proposer,
      critic,
      proposer_ms: proposed.ms,
      critic_ms: critiqued.ms,
    });
  }

  const last = rounds[rounds.length - 1]!;
  const allFindings = rounds.flatMap((r) =>
    r.critic.findings.map((f) => ({ round: r.round, ...f })),
  );
  const judged = await timedJson({
    system: JUDGE_SYSTEM_PROMPT,
    user: `${packed}${few}

Latest proposer JSON:
${JSON.stringify({ gaps: last.proposer.gaps, needs: last.proposer.needs }, null, 2)}

Critic findings from all ${GAP_EXTRACT_ROUNDS} rounds:
${JSON.stringify(allFindings, null, 2)}`,
    purpose: "judge",
  });
  const judge: JudgePayload = judgePayloadSchema.parse(judged.json);
  const gaps: ExtractGap[] = (judge.gaps.length ? judge.gaps : last.proposer.gaps).slice(
    0,
    GAP_EXTRACT_CAP,
  );
  const needs: ExtractNeed[] = judge.needs.length ? judge.needs : last.proposer.needs;

  return {
    prompt_version: prompt.version,
    rounds,
    judge,
    judge_ms: judged.ms,
    gaps,
    needs,
  };
}
