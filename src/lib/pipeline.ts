import { assignThemes } from "@/lib/cluster/cluster";
import { proposeCatalogChanges } from "@/lib/cluster/catalog-evolution";
import { hasAgenticLlm } from "@/lib/config";
import { critiqueInsights, scoreMetrics } from "@/lib/eval/critique";
import { judgeCandidate, pickChampion, proposeImprovement } from "@/lib/eval/judge";
import { proposeWithClaude } from "@/lib/extract/claude-proposer";
import { proposeInsights } from "@/lib/extract/proposer";
import { PROMPT_REGISTRY } from "@/lib/extract/prompts";
import { GOLD_INSIGHTS, SEED_DOCUMENTS, THEME_CATALOG } from "@/lib/seed/corpus";
import type {
  CanonicalInsight,
  CatalogTheme,
  EngineState,
  EvalRun,
  ParsedDocument,
} from "@/lib/schema";
import { hashId } from "@/lib/text";

export function seedCatalog(): CatalogTheme[] {
  return THEME_CATALOG.map((theme) => ({
    id: theme.id,
    name: theme.name,
    summary: theme.summary,
    keywords: theme.keywords,
  }));
}

export function extractAndCluster(
  documents: ParsedDocument[],
  promptVersion: string,
  extractedAt?: string,
  catalog: CatalogTheme[] = seedCatalog(),
): {
  insights: CanonicalInsight[];
  themes: EngineState["themes"];
  theme_links: EngineState["theme_links"];
} {
  const raw = proposeInsights(documents, promptVersion, extractedAt);
  return assignThemes(raw, catalog);
}

export async function extractAndClusterLive(
  documents: ParsedDocument[],
  promptVersion: string,
  catalog: CatalogTheme[] = seedCatalog(),
): Promise<{
  insights: CanonicalInsight[];
  themes: EngineState["themes"];
  theme_links: EngineState["theme_links"];
  extractor: "claude" | "local";
}> {
  if (hasAgenticLlm()) {
    try {
      const raw = await proposeWithClaude(documents);
      if (raw.length > 0) {
        return { ...assignThemes(raw, catalog), extractor: "claude" };
      }
    } catch {
      // Fall through to the local champion.
    }
  }
  return {
    ...extractAndCluster(documents, promptVersion, undefined, catalog),
    extractor: "local",
  };
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
  const catalog = seedCatalog();
  const { runs, champion } = runEvalSweep(SEED_DOCUMENTS);
  const { insights, themes, theme_links } = extractAndCluster(
    SEED_DOCUMENTS,
    champion,
    undefined,
    catalog,
  );
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
    catalog,
    catalog_proposals: proposeCatalogChanges(insights, catalog),
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
  const catalog = state.catalog.length > 0 ? state.catalog : seedCatalog();
  const { insights, themes, theme_links } = await extractAndClusterLive(
    documents,
    state.champion_prompt_version,
    catalog,
  );
  const { runs, champion } = runEvalSweep(documents);
  return {
    ...state,
    documents,
    insights,
    themes,
    theme_links,
    eval_runs: runs,
    champion_prompt_version: champion,
    catalog,
    catalog_proposals: proposeCatalogChanges(
      insights,
      catalog,
      state.catalog_proposals,
    ),
  };
}
