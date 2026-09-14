import { assignThemes } from "@/lib/cluster/cluster";
import { hasAnthropicKey } from "@/lib/config";
import { critiqueInsights, scoreMetrics } from "@/lib/eval/critique";
import { judgeCandidate, pickChampion, proposeImprovement } from "@/lib/eval/judge";
import { proposeWithClaude } from "@/lib/extract/claude-proposer";
import { proposeInsights } from "@/lib/extract/proposer";
import { PROMPT_REGISTRY } from "@/lib/extract/prompts";
import { GOLD_INSIGHTS, SEED_DOCUMENTS } from "@/lib/seed/corpus";
import type {
  CanonicalInsight,
  EngineState,
  EvalRun,
  ParsedDocument,
} from "@/lib/schema";
import { hashId } from "@/lib/text";

export function extractAndCluster(
  documents: ParsedDocument[],
  promptVersion: string,
  extractedAt?: string,
): {
  insights: CanonicalInsight[];
  themes: EngineState["themes"];
  theme_links: EngineState["theme_links"];
} {
  const raw = proposeInsights(documents, promptVersion, extractedAt);
  return assignThemes(raw);
}

export async function extractAndClusterLive(
  documents: ParsedDocument[],
  promptVersion: string,
): Promise<{
  insights: CanonicalInsight[];
  themes: EngineState["themes"];
  theme_links: EngineState["theme_links"];
  extractor: "claude" | "local";
}> {
  if (hasAnthropicKey()) {
    try {
      const raw = await proposeWithClaude(documents);
      if (raw.length > 0) {
        return { ...assignThemes(raw), extractor: "claude" };
      }
    } catch {
      // Fall through to the local champion.
    }
  }
  return { ...extractAndCluster(documents, promptVersion), extractor: "local" };
}

export function runEvalSweep(documents: ParsedDocument[]): {
  runs: EvalRun[];
  champion: string;
} {
  const runs: EvalRun[] = [];
  let championVersion = PROMPT_REGISTRY[0]!.version;
  let championMetrics: EvalRun["metrics"] | null = null;

  for (const prompt of PROMPT_REGISTRY) {
    const { insights } = extractAndCluster(documents, prompt.version);
    const { metrics } = scoreMetrics(insights, GOLD_INSIGHTS, documents);
    const critique = critiqueInsights(insights, GOLD_INSIGHTS, documents);
    const judge = judgeCandidate({
      candidateVersion: prompt.version,
      championVersion,
      candidate: metrics,
      champion: championMetrics,
    });
    if (championMetrics === null) {
      championVersion = prompt.version;
      championMetrics = metrics;
    } else if (
      judge.decision === "promote" ||
      (metrics.composite > championMetrics.composite &&
        metrics.wrong_rate <= championMetrics.wrong_rate + 0.05)
    ) {
      championVersion = prompt.version;
      championMetrics = metrics;
    }
    const proposal = proposeImprovement({
      currentVersion: prompt.version,
      metrics,
    });
    runs.push({
      id: hashId("EVAL", `${prompt.version}:${metrics.composite}`),
      ran_at: new Date().toISOString(),
      prompt_version: prompt.version,
      strategy: prompt.strategy,
      metrics,
      critique,
      judge: {
        ...judge,
        champion_version: championVersion,
      },
      proposal,
    });
  }

  const champion = pickChampion(
    runs.map((r) => ({ version: r.prompt_version, metrics: r.metrics })),
  );
  return {
    runs: runs.map((r, idx, arr) => {
      const isLast = idx === arr.length - 1;
      const isChampion = r.prompt_version === champion;
      return {
        ...r,
        judge: {
          ...r.judge,
          champion_version: champion,
          decision: isChampion && isLast ? "promote" : r.judge.decision,
        },
      };
    }),
    champion,
  };
}

export function buildSeedState(): EngineState {
  const { runs, champion } = runEvalSweep(SEED_DOCUMENTS);
  const { insights, themes, theme_links } = extractAndCluster(SEED_DOCUMENTS, champion);
  return {
    asset: {
      name: "Velmara",
      molecule: "velmaratinib",
      indication: "2L EGFRm NSCLC after osimertinib",
      as_of: "2026-09-14",
    },
    champion_prompt_version: champion,
    documents: SEED_DOCUMENTS,
    insights,
    theme_links,
    themes,
    eval_runs: runs,
    gold: GOLD_INSIGHTS,
  };
}

export async function ingestParsedDocument(
  state: EngineState,
  document: ParsedDocument,
): Promise<EngineState> {
  const documents = [
    ...state.documents.filter((d) => d.id !== document.id),
    document,
  ];
  const { insights, themes, theme_links } = await extractAndClusterLive(
    documents,
    state.champion_prompt_version,
  );
  return { ...state, documents, insights, themes, theme_links };
}
