import { RESIDUAL_THEME_ID } from "@/lib/cluster/cluster";
import type {
  CanonicalInsight,
  EngineState,
  Theme,
  ThemeLink,
} from "@/lib/schema";
import { hashId, normalize } from "@/lib/text";

const ENTITY =
  /\b(aetna|unitedhealthcare|horizon|medicaid|cms|ira|icer|cns|intracranial|nx-441|nps|pdufa|amcp|t790m|vel-203|japan|southeast|community|rems?|n=28|340b|ild|odac|wac|qaly|boxed)\b/gi;

const ALIAS: Record<string, string> = {
  unitedhealthcare: "united",
  intracranial: "cns",
  rem: "rems",
  "n=28": "cns",
};

const ENTITY_LABEL: Record<string, string> = {
  cns: "CNS",
  community: "community / site of care",
  rems: "REMS",
  "nx-441": "NX-441",
  aetna: "Aetna",
  united: "UnitedHealthcare",
  nps: "NPS",
  amcp: "AMCP",
  ira: "IRA",
  icer: "ICER",
  pdufa: "PDUFA",
  "340b": "340B",
  ild: "ILD",
  odac: "ODAC",
  wac: "WAC",
  qaly: "QALY",
  boxed: "boxed warning",
};

function entityLabel(entity: string): string {
  return ENTITY_LABEL[entity] ?? entity;
}

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

function sortedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function mergeRevelation(
  existing: Revelation | undefined,
  next: Revelation,
): Revelation {
  if (!existing) return next;
  return {
    ...existing,
    insight_ids: sortedIds([...existing.insight_ids, ...next.insight_ids]).slice(
      0,
      4,
    ),
    score: Math.max(existing.score, next.score),
  };
}

function pickDiverse(revelations: Revelation[], limit: number): Revelation[] {
  const ranked = [...revelations].sort(
    (a, b) => b.score - a.score || a.title.localeCompare(b.title),
  );
  const byKind: Record<RevelationKind, Revelation[]> = {
    blend: [],
    bridge: [],
    gap_closure: [],
  };
  for (const row of ranked) byKind[row.kind].push(row);
  const picked: Revelation[] = [];
  const used = new Set<string>();
  const take = (kind: RevelationKind, n: number) => {
    for (const row of byKind[kind]) {
      if (picked.length >= limit) return;
      if (used.has(row.id)) continue;
      if (n <= 0) return;
      picked.push(row);
      used.add(row.id);
      n -= 1;
    }
  };
  take("blend", 4);
  take("bridge", 3);
  take("gap_closure", 4);
  for (const row of ranked) {
    if (picked.length >= limit) break;
    if (used.has(row.id)) continue;
    picked.push(row);
    used.add(row.id);
  }
  return picked.sort(
    (a, b) => b.score - a.score || a.title.localeCompare(b.title),
  );
}

export function buildKnowledgeGraph(state: {
  insights: CanonicalInsight[];
  themes: Theme[];
  theme_links: ThemeLink[];
}): KnowledgeGraph {
  const { insights, themes } = state;
  const blended = new Map<string, Revelation>();

  for (const insight of insights) {
    const theme_ids = sortedIds(namedThemes(insight.theme_ids));
    if (theme_ids.length < 2) continue;
    const names = theme_ids.map((id) => themeName(themes, id));
    const key = `blend:${theme_ids.join("+")}`;
    blended.set(
      key,
      mergeRevelation(blended.get(key), {
        id: hashId("REV", key),
        kind: "blend",
        title: names.join(" × "),
        why: `CIR on ${names.join(" and ")} stay one note. The intersection is the briefing object — copying the sentence onto each theme would hide the join.`,
        insight_ids: [insight.id],
        theme_ids,
        score: theme_ids.length * 3 + 1,
      }),
    );
  }

  const linked = new Map<string, Revelation>();
  for (let i = 0; i < insights.length; i += 1) {
    for (let j = i + 1; j < insights.length; j += 1) {
      const a = insights[i]!;
      const b = insights[j]!;
      const shared = [...entityMentions(a.statement)].filter((e) =>
        entityMentions(b.statement).has(e),
      );
      if (shared.length === 0) continue;
      if (a.knowledge_state.corroborated_by.includes(b.id)) continue;

      const themesA = new Set(namedThemes(a.theme_ids));
      const themesB = new Set(namedThemes(b.theme_ids));
      const theme_ids = sortedIds([...themesA, ...themesB]);
      if (theme_ids.length === 0) continue;
      const themeOverlap = [...themesA].filter((t) => themesB.has(t));
      const entity = shared[0]!;
      const namesA = [...themesA].map((id) => themeName(themes, id));
      const namesB = [...themesB].map((id) => themeName(themes, id));
      const label = entityLabel(entity);

      const classes = new Set([a.classification, b.classification]);
      const gapPair =
        classes.has("unknown") &&
        (classes.has("known") || classes.has("opportunity"));
      const differentFunctions =
        a.stakeholder_function !== b.stakeholder_function;
      const differentDocs = a.source_document_id !== b.source_document_id;
      const noSharedTheme = themeOverlap.length === 0;
      const otherClass =
        a.classification === "unknown" ? b.classification : a.classification;

      if (gapPair && (noSharedTheme || differentFunctions)) {
        const key = `gap:${entity}:${theme_ids.join("+")}`;
        linked.set(
          key,
          mergeRevelation(linked.get(key), {
            id: hashId("REV", key),
            kind: "gap_closure",
            title: `${label} across ${theme_ids
              .map((id) => themeName(themes, id))
              .slice(0, 3)
              .join(" / ")}`,
            why: `An unknown and a ${otherClass} both mention ${label}. No source wrote the combined implication; it only exists once both CIR are in the graph.`,
            entity,
            insight_ids: [a.id, b.id],
            theme_ids,
            score:
              5 +
              (differentDocs ? 2 : 0) +
              (differentFunctions ? 2 : 0) +
              (noSharedTheme ? 2 : 0),
          }),
        );
        continue;
      }

      if (noSharedTheme && differentDocs) {
        const key = `bridge:${entity}:${theme_ids.join("+")}`;
        linked.set(
          key,
          mergeRevelation(linked.get(key), {
            id: hashId("REV", key),
            kind: "bridge",
            title: `${label} links ${namesA[0] ?? "Unassigned"} to ${namesB[0] ?? "Unassigned"}`,
            why: `${label} appears in two claims that do not share a theme. The decks never cross-referenced them; walking the graph did.`,
            entity,
            insight_ids: [a.id, b.id],
            theme_ids,
            score: 3 + shared.length + (differentFunctions ? 1 : 0),
          }),
        );
      }
    }
  }

  const capped = pickDiverse(
    [...blended.values(), ...linked.values()],
    12,
  );

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
