import { RESIDUAL_THEME_ID } from "@/lib/cluster/cluster";
import type {
  CanonicalInsight,
  EngineState,
  Theme,
  ThemeLink,
} from "@/lib/schema";
import { hashId, normalize } from "@/lib/text";

const ENTITY =
  /\b(aetna|unitedhealthcare|horizon|medicaid|cms|ira|icer|cns|intracranial|nx-441|nps|pdufa|amcp|t790m|vel-203|japan|southeast|community|rems?|n=28)\b/gi;

const ALIAS: Record<string, string> = {
  unitedhealthcare: "united",
  intracranial: "cns",
  rem: "rems",
  "n=28": "cns",
};

export type RevelationKind = "blend" | "bridge" | "gap_closure";

export type Revelation = {
  id: string;
  kind: RevelationKind;
  title: string;
  why: string;
  entity?: string;
  insight_ids: string[];
  theme_ids: string[];
  score: number;
};

export type ThemeBridge = {
  from: string;
  to: string;
  shared: number;
};

export type KnowledgeGraph = {
  revelations: Revelation[];
  theme_bridges: ThemeBridge[];
  corroboration_pairs: number;
  multi_theme_insights: number;
};

export function entityMentions(statement: string): Set<string> {
  const found = new Set<string>();
  const blob = normalize(statement);
  for (const match of blob.matchAll(ENTITY)) {
    const raw = match[1]!.toLowerCase();
    found.add(ALIAS[raw] ?? raw);
  }
  return found;
}

function namedThemes(ids: string[]): string[] {
  return ids.filter((id) => id !== RESIDUAL_THEME_ID);
}

function themeName(themes: Theme[], id: string): string {
  return themes.find((t) => t.id === id)?.name ?? id;
}

function insightById(
  insights: CanonicalInsight[],
  id: string,
): CanonicalInsight | undefined {
  return insights.find((i) => i.id === id);
}

export function buildKnowledgeGraph(state: {
  insights: CanonicalInsight[];
  themes: Theme[];
  theme_links: ThemeLink[];
}): KnowledgeGraph {
  const { insights, themes } = state;
  const revelations: Revelation[] = [];

  for (const insight of insights) {
    const theme_ids = namedThemes(insight.theme_ids);
    if (theme_ids.length < 2) continue;
    const names = theme_ids.map((id) => themeName(themes, id));
    revelations.push({
      id: hashId("REV", `blend:${insight.id}`),
      kind: "blend",
      title: `${names.join(" × ")}`,
      why: `One CIR sits on ${names.join(" and ")}. That intersection is the briefing object — the documents never copied the sentence; the join did.`,
      insight_ids: [insight.id],
      theme_ids,
      score: theme_ids.length * 3,
    });
  }

  const seenPair = new Set<string>();
  for (let i = 0; i < insights.length; i += 1) {
    for (let j = i + 1; j < insights.length; j += 1) {
      const a = insights[i]!;
      const b = insights[j]!;
      const entitiesA = entityMentions(a.statement);
      const entitiesB = entityMentions(b.statement);
      const shared = [...entitiesA].filter((e) => entitiesB.has(e));
      if (shared.length === 0) continue;

      const themesA = new Set(namedThemes(a.theme_ids));
      const themesB = new Set(namedThemes(b.theme_ids));
      const themeOverlap = [...themesA].filter((t) => themesB.has(t));
      const pairKey = `${a.id}:${b.id}:${shared.sort().join(",")}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);

      const alreadySameClaim = a.knowledge_state.corroborated_by.includes(b.id);
      if (alreadySameClaim) continue;

      const entity = shared[0]!;
      const theme_ids = [...new Set([...themesA, ...themesB])];
      const namesA = [...themesA].map((id) => themeName(themes, id));
      const namesB = [...themesB].map((id) => themeName(themes, id));

      const classes = new Set([a.classification, b.classification]);
      const gapPair =
        classes.has("unknown") &&
        (classes.has("known") || classes.has("opportunity"));
      const differentFunctions =
        a.stakeholder_function !== b.stakeholder_function;
      const differentDocs = a.source_document_id !== b.source_document_id;
      const noSharedTheme = themeOverlap.length === 0;

      if (gapPair && (noSharedTheme || differentFunctions)) {
        revelations.push({
          id: hashId("REV", `gap:${a.id}:${b.id}:${entity}`),
          kind: "gap_closure",
          title: `${entity.toUpperCase()} across ${[...new Set([...namesA, ...namesB])].slice(0, 3).join(" / ")}`,
          why: `An unknown and a ${b.classification === "unknown" ? a.classification : b.classification} both mention ${entity}. No source wrote the combined implication; it only exists once both CIR are in the graph.`,
          entity,
          insight_ids: [a.id, b.id],
          theme_ids,
          score:
            5 +
            (differentDocs ? 2 : 0) +
            (differentFunctions ? 2 : 0) +
            (noSharedTheme ? 2 : 0),
        });
        continue;
      }

      if (noSharedTheme && differentDocs) {
        revelations.push({
          id: hashId("REV", `bridge:${a.id}:${b.id}:${entity}`),
          kind: "bridge",
          title: `${entity} links ${namesA[0] ?? "Unassigned"} to ${namesB[0] ?? "Unassigned"}`,
          why: `${entity} appears in two claims that do not share a theme. The decks never cross-referenced them; walking the graph did.`,
          entity,
          insight_ids: [a.id, b.id],
          theme_ids,
          score: 3 + shared.length + (differentFunctions ? 1 : 0),
        });
      }
    }
  }

  revelations.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const capped = revelations.slice(0, 14);

  const named = themes.filter(
    (t) => t.id !== RESIDUAL_THEME_ID && t.insight_ids.length > 0,
  );
  const theme_bridges: ThemeBridge[] = [];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      const from = named[i]!;
      const to = named[j]!;
      const shared = from.insight_ids.filter((id) => to.insight_ids.includes(id))
        .length;
      if (shared === 0) continue;
      theme_bridges.push({ from: from.id, to: to.id, shared });
    }
  }

  const corroboration_pairs = insights.reduce((n, insight) => {
    return n + insight.knowledge_state.corroborated_by.filter((id) => id > insight.id)
      .length;
  }, 0);

  return {
    revelations: capped,
    theme_bridges,
    corroboration_pairs,
    multi_theme_insights: insights.filter(
      (i) => namedThemes(i.theme_ids).length > 1,
    ).length,
  };
}

export function revelationInsights(
  revelation: Revelation,
  insights: CanonicalInsight[],
): CanonicalInsight[] {
  return revelation.insight_ids
    .map((id) => insightById(insights, id))
    .filter((i): i is CanonicalInsight => Boolean(i));
}

export function graphFromState(state: EngineState): KnowledgeGraph {
  return buildKnowledgeGraph(state);
}
