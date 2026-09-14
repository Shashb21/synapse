import { RESIDUAL_THEME_ID, assignThemes } from "@/lib/cluster/cluster";
import type {
  CanonicalInsight,
  CatalogProposal,
  CatalogTheme,
  EngineState,
  Theme,
  ThemeLink,
} from "@/lib/schema";
import { hashId, normalize, statementSimilarity } from "@/lib/text";

const EMERGE_SIM = 0.34;
const EMERGE_MIN = 2;
const SPLIT_MIN_THEME = 4;
const SPLIT_MIN_EXCLUSIVE = 2;
const NONE_KEY = "__none__";

const NAME_STOP = new Set([
  "unknown",
  "known",
  "gap",
  "play",
  "remain",
  "remains",
  "still",
  "also",
  "both",
  "additional",
  "have",
  "been",
  "from",
  "this",
  "that",
  "with",
  "will",
  "does",
  "exists",
  "whether",
  "confirmed",
]);

/** Alias families so CNS / intracranial / brain-mets / n=28 brief as one object. */
const KEYWORD_ALIASES: Record<string, string> = {
  cns: "cns",
  intracranial: "cns",
  brain: "cns",
  "brain-mets": "cns",
  "brain mets": "cns",
  "n=28": "cns",
  discontinuation: "discontinuation",
  persistence: "discontinuation",
};

export function clusterBySimilarity(
  insights: CanonicalInsight[],
  threshold: number,
): CanonicalInsight[][] {
  const groups: CanonicalInsight[][] = [];
  for (const insight of insights) {
    let placed = false;
    for (const group of groups) {
      const avg =
        group.reduce(
          (sum, member) =>
            sum + statementSimilarity(insight.statement, member.statement),
          0,
        ) / group.length;
      if (avg >= threshold) {
        group.push(insight);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([insight]);
  }
  return groups;
}

function meanPairwise(group: CanonicalInsight[]): number {
  if (group.length < 2) return 1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      sum += statementSimilarity(group[i]!.statement, group[j]!.statement);
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

function canonicalKeyword(keyword: string): string {
  return KEYWORD_ALIASES[keyword.toLowerCase()] ?? keyword.toLowerCase();
}

function pluralVariants(keyword: string): string[] {
  const kw = keyword.toLowerCase();
  const variants = new Set<string>([kw]);
  if (kw.endsWith("y") && kw.length > 3 && !/[aeiou]y$/i.test(kw)) {
    variants.add(`${kw.slice(0, -1)}ies`);
  }
  if (kw.endsWith("ies") && kw.length > 4) {
    variants.add(`${kw.slice(0, -3)}y`);
  }
  if (!kw.endsWith("s")) {
    variants.add(`${kw}s`);
    variants.add(`${kw}es`);
  } else if (kw.length > 3) {
    variants.add(kw.slice(0, -1));
  }
  return [...variants];
}

export function statementHasKeyword(statement: string, keyword: string): boolean {
  const blob = statement.toLowerCase();
  return pluralVariants(keyword).some((variant) => blob.includes(variant));
}

function hitSet(statement: string, keywords: string[]): Set<string> {
  const hits = new Set<string>();
  for (const keyword of keywords) {
    if (statementHasKeyword(statement, keyword)) {
      hits.add(canonicalKeyword(keyword));
    }
  }
  if (hits.size === 0) hits.add(NONE_KEY);
  return hits;
}

function exclusiveMembers(
  members: { insight: CanonicalInsight; keys: Set<string> }[],
  key: string,
  other: string,
): CanonicalInsight[] {
  return members
    .filter((row) => row.keys.has(key) && !row.keys.has(other))
    .map((row) => row.insight);
}

function pickChildCohort(
  k1: string,
  ex1: CanonicalInsight[],
  k2: string,
  ex2: CanonicalInsight[],
): CanonicalInsight[] {
  if (ex1.length < ex2.length) return ex1;
  if (ex2.length < ex1.length) return ex2;
  if (k1 === NONE_KEY) return ex1;
  if (k2 === NONE_KEY) return ex2;
  return k1 < k2 ? ex1 : ex2;
}

function bestKeywordSplit(
  members: CanonicalInsight[],
  keywords: string[],
): {
  child: CanonicalInsight[];
  k1: string;
  k2: string;
  score: number;
} | null {
  const tagged = members.map((insight) => ({
    insight,
    keys: hitSet(insight.statement, keywords),
  }));
  const keys = [...new Set(tagged.flatMap((row) => [...row.keys]))];
  let best: {
    score: number;
    k1: string;
    k2: string;
    ex1: CanonicalInsight[];
    ex2: CanonicalInsight[];
  } | null = null;

  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const k1 = keys[i]!;
      const k2 = keys[j]!;
      const ex1 = exclusiveMembers(tagged, k1, k2);
      const ex2 = exclusiveMembers(tagged, k2, k1);
      if (ex1.length < SPLIT_MIN_EXCLUSIVE || ex2.length < SPLIT_MIN_EXCLUSIVE) {
        continue;
      }
      const score = ex1.length * ex2.length;
      if (!best || score > best.score) {
        best = { score, k1, k2, ex1, ex2 };
      }
    }
  }

  if (!best) return null;
  return {
    child: pickChildCohort(best.k1, best.ex1, best.k2, best.ex2),
    k1: best.k1,
    k2: best.k2,
    score: best.score,
  };
}

export function keywordsFromInsights(insights: CanonicalInsight[]): string[] {
  const counts = new Map<string, number>();
  for (const insight of insights) {
    for (const token of normalize(insight.statement).split(" ")) {
      const clean = token.replace(/^\.+|\.+$/g, "");
      if (clean.length < 4 || NAME_STOP.has(clean) || /^\d+$/.test(clean)) {
        continue;
      }
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([token]) => token);
}

function titleFromKeywords(keywords: string[], fallback: string): string {
  if (keywords.length === 0) return fallback;
  const words = keywords.slice(0, 3).map((w) => w[0]!.toUpperCase() + w.slice(1));
  return words.join(" ");
}

function sourceCount(insights: CanonicalInsight[]): number {
  return new Set(insights.map((i) => i.source_document_id)).size;
}

function proposalId(kind: CatalogProposal["kind"], insightIds: string[]): string {
  return hashId("PROP", `${kind}:${[...insightIds].sort().join(",")}`);
}

export function proposeCatalogChanges(
  insights: CanonicalInsight[],
  catalog: CatalogTheme[],
  prior: CatalogProposal[] = [],
): CatalogProposal[] {
  const decided = new Map(
    prior
      .filter((p) => p.status !== "proposed")
      .map((p) => [p.id, p] as const),
  );
  const now = new Date().toISOString();
  const next: CatalogProposal[] = [...decided.values()];

  const residual = insights.filter((i) =>
    i.theme_ids.includes(RESIDUAL_THEME_ID),
  );
  for (const group of clusterBySimilarity(residual, EMERGE_SIM)) {
    if (group.length < EMERGE_MIN) continue;
    const cohesion = meanPairwise(group);
    if (cohesion < EMERGE_SIM) continue;
    const insight_ids = group.map((g) => g.id);
    const id = proposalId("emerge", insight_ids);
    if (decided.has(id)) continue;
    const keywords = keywordsFromInsights(group);
    const name = titleFromKeywords(keywords, "New theme");
    next.push({
      id,
      kind: "emerge",
      status: "proposed",
      name,
      summary: `${group.length} unassigned claims share a decision object the catalog does not yet name.`,
      keywords,
      insight_ids,
      rationale: `Unassigned cluster of ${group.length} CIR from ${sourceCount(group)} source(s), cohesion ${cohesion.toFixed(2)}. Promote only if a VP would brief this as its own decision.`,
      sources: sourceCount(group),
      cohesion,
      created_at: now,
    });
  }

  const named = catalog.filter((t) => t.id !== RESIDUAL_THEME_ID);
  const splitCandidates: {
    theme: CatalogTheme;
    child: CanonicalInsight[];
    k1: string;
    k2: string;
    score: number;
  }[] = [];
  for (const theme of named) {
    const members = insights.filter((i) => i.theme_ids.includes(theme.id));
    if (members.length < SPLIT_MIN_THEME) continue;
    const split = bestKeywordSplit(members, theme.keywords);
    if (!split || split.child.length < SPLIT_MIN_EXCLUSIVE) continue;
    splitCandidates.push({ theme, ...split });
  }
  const bestScore = Math.max(0, ...splitCandidates.map((c) => c.score));
  const splits =
    bestScore === 0
      ? []
      : splitCandidates
          .filter((c) => c.score === bestScore)
          .sort(
            (a, b) =>
              b.child.length - a.child.length ||
              a.theme.id.localeCompare(b.theme.id),
          )
          .slice(0, 1);

  for (const split of splits) {
    const insight_ids = split.child.map((g) => g.id);
    const id = proposalId("split", insight_ids);
    if (decided.has(id)) continue;
    const keywords = keywordsFromInsights(split.child);
    const name = titleFromKeywords(keywords, `${split.theme.name} (split)`);
    const cohesion = meanPairwise(split.child);
    next.push({
      id,
      kind: "split",
      status: "proposed",
      name,
      summary: `A cohort inside ${split.theme.name} is a separate decision object.`,
      keywords,
      insight_ids,
      parent_theme_id: split.theme.id,
      rationale: `${split.theme.name} is briefing two decision objects (${split.k1} vs ${split.k2}). Child of ${split.child.length} CIR; parent stays. Catalog is append-only.`,
      sources: sourceCount(split.child),
      cohesion,
      created_at: now,
    });
  }

  return next;
}

function materializeThemes(
  insights: CanonicalInsight[],
  catalog: CatalogTheme[],
  theme_links: ThemeLink[],
): { insights: CanonicalInsight[]; themes: Theme[]; theme_links: ThemeLink[] } {
  const byInsight = new Map<string, ThemeLink[]>();
  for (const link of theme_links) {
    const list = byInsight.get(link.insight_id) ?? [];
    list.push(link);
    byInsight.set(link.insight_id, list);
  }
  const tagged = insights.map((insight) => ({
    ...insight,
    theme_ids: (byInsight.get(insight.id) ?? []).map((l) => l.theme_id),
  }));
  const themes: Theme[] = catalog
    .map((entry) => {
      const members = [
        ...new Set(
          theme_links
            .filter((l) => l.theme_id === entry.id)
            .map((l) => l.insight_id),
        ),
      ];
      const records = members
        .map((id) => tagged.find((i) => i.id === id))
        .filter((i): i is CanonicalInsight => Boolean(i));
      return {
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        keywords: entry.keywords,
        parent_theme_id: entry.parent_theme_id,
        insight_ids: members,
        known_count: records.filter((m) => m.classification === "known").length,
        unknown_count: records.filter((m) => m.classification === "unknown").length,
        opportunity_count: records.filter((m) => m.classification === "opportunity")
          .length,
      };
    })
    .filter((t) => t.id === RESIDUAL_THEME_ID || t.insight_ids.length > 0);
  return { insights: tagged, themes, theme_links };
}

function forceLinkProposal(
  insights: CanonicalInsight[],
  catalog: CatalogTheme[],
  theme_links: ThemeLink[],
  entry: CatalogTheme,
  proposal: CatalogProposal,
): { insights: CanonicalInsight[]; themes: Theme[]; theme_links: ThemeLink[] } {
  let links = [...theme_links];
  for (const insightId of proposal.insight_ids) {
    if (proposal.kind === "emerge") {
      links = links.filter(
        (link) =>
          !(
            link.insight_id === insightId &&
            link.theme_id === RESIDUAL_THEME_ID
          ),
      );
    }
    if (
      proposal.kind === "split" &&
      proposal.parent_theme_id &&
      !links.some(
        (link) =>
          link.insight_id === insightId &&
          link.theme_id === proposal.parent_theme_id,
      )
    ) {
      const parentPrimary = links.some(
        (link) => link.insight_id === insightId && link.role === "primary",
      );
      links.push({
        insight_id: insightId,
        theme_id: proposal.parent_theme_id,
        score: 1,
        role: parentPrimary ? "secondary" : "primary",
        method: "ontology",
      });
    }
    if (links.some((link) => link.insight_id === insightId && link.theme_id === entry.id)) {
      continue;
    }
    const hasPrimary = links.some(
      (link) => link.insight_id === insightId && link.role === "primary",
    );
    links.push({
      insight_id: insightId,
      theme_id: entry.id,
      score: 1,
      role:
        proposal.kind === "emerge" || !hasPrimary ? "primary" : "secondary",
      method: "ontology",
    });
  }
  return materializeThemes(insights, catalog, links);
}

export function acceptProposal(
  state: EngineState,
  proposalId: string,
): EngineState {
  const proposal = state.catalog_proposals.find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== "proposed") return state;
  const catalog = state.catalog.length > 0 ? [...state.catalog] : [];
  const residual = catalog.find((c) => c.id === RESIDUAL_THEME_ID);
  const withoutResidual = catalog.filter((c) => c.id !== RESIDUAL_THEME_ID);
  const entry: CatalogTheme = {
    id: hashId("THEME", `${proposal.kind}:${proposal.name}:${proposal.id}`),
    name: proposal.name,
    summary: proposal.summary,
    keywords: proposal.keywords,
    parent_theme_id: proposal.parent_theme_id,
  };
  const nextCatalog = residual
    ? [...withoutResidual, entry, residual]
    : [...withoutResidual, entry];
  const clustered = assignThemes(state.insights, nextCatalog);
  const linked = forceLinkProposal(
    clustered.insights,
    nextCatalog,
    clustered.theme_links,
    entry,
    proposal,
  );
  const decided: CatalogProposal = {
    ...proposal,
    status: "accepted",
    decided_at: new Date().toISOString(),
  };
  const prior = state.catalog_proposals.map((p) =>
    p.id === proposalId ? decided : p,
  );
  return {
    ...state,
    catalog: nextCatalog,
    insights: linked.insights,
    themes: linked.themes,
    theme_links: linked.theme_links,
    catalog_proposals: proposeCatalogChanges(
      linked.insights,
      nextCatalog,
      prior,
    ),
  };
}

export function rejectProposal(
  state: EngineState,
  proposalId: string,
): EngineState {
  const proposal = state.catalog_proposals.find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== "proposed") return state;
  const prior = state.catalog_proposals.map((p) =>
    p.id === proposalId
      ? { ...p, status: "rejected" as const, decided_at: new Date().toISOString() }
      : p,
  );
  return {
    ...state,
    catalog_proposals: proposeCatalogChanges(
      state.insights,
      state.catalog,
      prior,
    ),
  };
}
