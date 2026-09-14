import { nextPromptVersion } from "@/lib/extract/proposer";
import { PROMPT_REGISTRY } from "@/lib/extract/prompts";
import type { EvalMetrics, JudgeVerdict } from "@/lib/schema";

const WRONG_DELTA_MAX = 0.05;
const COMPOSITE_DELTA_MIN = 0.01;

export function judgeCandidate(args: {
  candidateVersion: string;
  championVersion: string;
  candidate: EvalMetrics;
  champion: EvalMetrics | null;
}): JudgeVerdict {
  const { candidateVersion, championVersion, candidate, champion } = args;
  if (!champion || candidateVersion === championVersion) {
    return {
      decision: "hold",
      champion_version: championVersion,
      candidate_version: candidateVersion,
      rationale:
        champion === null
          ? "First scored version becomes the provisional champion after the full sweep."
          : "Candidate is the current champion; no promotion needed.",
      safety_gate_passed: true,
    };
  }

  const wrongDelta = candidate.wrong_rate - champion.wrong_rate;
  const compositeDelta = candidate.composite - champion.composite;
  const recallDrop = champion.recall - candidate.recall;
  const safety_gate_passed =
    wrongDelta <= WRONG_DELTA_MAX && recallDrop <= 0.02;

  if (!safety_gate_passed) {
    return {
      decision: "regress",
      champion_version: championVersion,
      candidate_version: candidateVersion,
      rationale: `Safety gate failed (Δwrong=${wrongDelta.toFixed(3)}, Δrecall=${(-recallDrop).toFixed(3)}). Wrong insights are more expensive than misses.`,
      safety_gate_passed,
    };
  }

  if (compositeDelta >= COMPOSITE_DELTA_MIN) {
    return {
      decision: "promote",
      champion_version: championVersion,
      candidate_version: candidateVersion,
      rationale: `Composite improved ${champion.composite.toFixed(3)} → ${candidate.composite.toFixed(3)} without breaching the wrong-rate gate.`,
      safety_gate_passed,
    };
  }

  return {
    decision: "hold",
    champion_version: championVersion,
    candidate_version: candidateVersion,
    rationale: `Composite delta ${compositeDelta.toFixed(3)} is below the 0.01 hill-climb threshold.`,
    safety_gate_passed,
  };
}

export function proposeImprovement(args: {
  currentVersion: string;
  metrics: EvalMetrics;
}): {
  recommended_prompt_version: string;
  rationale: string[];
  prompt_patch: string;
} {
  const { currentVersion, metrics } = args;
  const rationale: string[] = [];
  const patches: string[] = [];

  if (metrics.wrong_rate > 0.08) {
    rationale.push(
      "Wrong-rate is elevated — require evidence quotes and drop ungrounded entities.",
    );
    patches.push(
      "HARD RULE: If a number, account, or geography is not in the evidence_quote, delete the insight.",
    );
  }
  if (metrics.partial_rate > 0.12) {
    rationale.push(
      "Partial-rate is elevated — split double-barreled claims (and both / semicolons / heading+bullet).",
    );
    patches.push(
      "ATOMICITY: Split on ';', 'and both', and independent clauses longer than 40 characters.",
    );
  }
  if (metrics.missed_rate > 0.18) {
    rationale.push(
      "Missed-rate is elevated — scan prose, tables, and Open questions / Unknowns / Gaps sections.",
    );
    patches.push(
      "COVERAGE: Extract paragraphs and table cells. Headings matching Unknowns/Gaps default to classification=unknown.",
    );
  }
  if (metrics.new_rate > 0.1) {
    rationale.push(
      "Grounded new insights exist — send them to gold review rather than suppressing the extractor.",
    );
    patches.push(
      "GOLD REVIEW: Queue `new` findings for human accept into the eval set (REQ-EVA-005).",
    );
  }
  if (rationale.length === 0) {
    rationale.push(
      "No failure-mode threshold breached. Hold the champion and collect more gold.",
    );
  }

  const recommended =
    metrics.composite < 0.78
      ? nextPromptVersion(currentVersion)
      : currentVersion;

  const currentPrompt =
    PROMPT_REGISTRY.find((p) => p.version === currentVersion)?.system_prompt ??
    "";

  return {
    recommended_prompt_version: recommended,
    rationale,
    prompt_patch: [currentPrompt, "", "## Proposed patch", ...patches].join(
      "\n",
    ),
  };
}

export function pickChampion(
  scored: { version: string; metrics: EvalMetrics }[],
): string {
  const ranked = [...scored].sort((a, b) => {
    if (b.metrics.composite !== a.metrics.composite) {
      return b.metrics.composite - a.metrics.composite;
    }
    return a.metrics.wrong_rate - b.metrics.wrong_rate;
  });
  return ranked[0]?.version ?? "v1.3-cross-functional";
}
