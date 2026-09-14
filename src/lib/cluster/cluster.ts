import { THEME_CATALOG } from "@/lib/seed/corpus";
import type {
  CanonicalInsight,
  StakeholderFunction,
  Theme,
  ThemeLink,
} from "@/lib/schema";
import { statementSimilarity, tokens } from "@/lib/text";

export const RESIDUAL_THEME_ID = "THEME-RESIDUAL";
const RESIDUAL_ID = RESIDUAL_THEME_ID;
const PRIMARY_FLOOR = 0.45;
const SECONDARY_FLOOR = 0.9;
const SECONDARY_RATIO = 0.48;
const MAX_THEMES = 4;

type CatalogTheme = (typeof THEME_CATALOG)[number];

const PATTERNS: Record<string, RegExp[]> = {
  "THEME-ACCESS": [
    /\bformulary\b/i,
    /\bstep[- ]?edit/i,
    /\bmedicaid\b/i,
    /\bamcp\b/i,
    /\b(aetna|unitedhealthcare|horizon)\b/i,
    /\boutcomes-based contract/i,
    /\bunrestricted access\b/i,
    /\bnon-formulary\b/i,
    /\bpreferred-product\b/i,
  ],
  "THEME-EVIDENCE": [
    /\brwe\b/i,
    /\bcns\b/i,
    /\bintracranial\b/i,
    /\bbrain[- ]?mets?\b/i,
    /\bdiscontinuation\b/i,
    /\bpersistence\b/i,
    /\bn=\d+/i,
    /\bpayer-ready\b/i,
    /\bdossier\b/i,
  ],
  "THEME-COMPETITIVE": [
    /\bnx-441\b/i,
    /\bbispecific\b/i,
    /\bcompetitor\b/i,
    /\bcompeting\b/i,
    /\bcompetitive\b/i,
  ],
  "THEME-SITE-OF-CARE": [
    /\bcommunity\b/i,
    /\bacademic\b/i,
    /\bsite of care\b/i,
    /\bpeer-to-peer\b/i,
    /\bsoutheast\b/i,
  ],
  "THEME-TRIAL": [
    /\benroll/i,
    /\bscreen fail\b/i,
    /\bwashout\b/i,
    /\bsite activation\b/i,
    /\bvel-203\b/i,
    /\bprotocol\b/i,
    /\bfirst-patient-in\b/i,
    /\bbiopsy\b/i,
  ],
  "THEME-HCP": [
    /\bmessage\b/i,
    /\brecall\b/i,
    /\bnps\b/i,
    /\bunbranded\b/i,
    /\bimpressions\b/i,
    /\bemail open\b/i,
    /\bspend\b/i,
  ],
  "THEME-SEQUENCING": [
    /\bsequenc/i,
    /\bt790m\b/i,
    /\bresistance\b/i,
    /\bpost-osi\b/i,
    /\bexon 20\b/i,
    /\bliquid biopsy\b/i,
  ],
  "THEME-POLICY": [
    /\bira\b/i,
    /\bcms\b/i,
    /\bicer\b/i,
    /\bnet price\b/i,
    /\bbudget-impact\b/i,
    /\buptake\b/i,
  ],
};

const STAKEHOLDER_BOOST: Record<
  StakeholderFunction,
  Partial<Record<string, number>>
> = {
  commercial: { "THEME-ACCESS": 0.15, "THEME-SITE-OF-CARE": 0.1 },
  market_access: { "THEME-ACCESS": 0.35, "THEME-POLICY": 0.2, "THEME-EVIDENCE": 0.1 },
  medical_affairs: { "THEME-EVIDENCE": 0.25, "THEME-SEQUENCING": 0.3 },
  clinops: { "THEME-TRIAL": 0.45 },
  marketing: { "THEME-HCP": 0.35, "THEME-SITE-OF-CARE": 0.1 },
  heor: { "THEME-POLICY": 0.35, "THEME-EVIDENCE": 0.2 },
  regulatory: { "THEME-EVIDENCE": 0.2, "THEME-POLICY": 0.15 },
};

export function scoreTheme(
  statement: string,
  stakeholder: StakeholderFunction,
  theme: CatalogTheme,
): number {
  if (theme.id === RESIDUAL_ID) return 0;
  const blob = statement.toLowerCase();
  let score = 0;
  for (const kw of theme.keywords) {
    if (blob.includes(kw.toLowerCase())) score += 1;
  }
  const t = new Set(tokens(statement));
  for (const kw of theme.keywords) {
    for (const part of kw.split(" ")) {
      if (t.has(part.replace(/(ing|ed|es|s)$/i, ""))) score += 0.2;
    }
  }
  for (const re of PATTERNS[theme.id] ?? []) {
    if (re.test(statement)) score += 1.35;
  }
  score += STAKEHOLDER_BOOST[stakeholder][theme.id] ?? 0;
  return score;
}

export function linkInsightToThemes(insight: CanonicalInsight): ThemeLink[] {
  const ranked = THEME_CATALOG.map((theme) => ({
    theme_id: theme.id,
    score: scoreTheme(insight.statement, insight.stakeholder_function, theme),
  }))
    .filter((row) => row.theme_id !== RESIDUAL_ID)
    .sort((a, b) => b.score - a.score);

  const primary = ranked[0];
  if (!primary || primary.score < PRIMARY_FLOOR) {
    return [
      {
        insight_id: insight.id,
        theme_id: RESIDUAL_ID,
        score: primary?.score ?? 0,
        role: "primary",
        method: "residual",
      },
    ];
  }

  const links: ThemeLink[] = [
    {
      insight_id: insight.id,
      theme_id: primary.theme_id,
      score: primary.score,
      role: "primary",
      method: "ontology",
    },
  ];

  for (const row of ranked.slice(1)) {
    if (links.length >= MAX_THEMES) break;
    if (
      row.score >= SECONDARY_FLOOR &&
      row.score >= primary.score * SECONDARY_RATIO
    ) {
      links.push({
        insight_id: insight.id,
        theme_id: row.theme_id,
        score: row.score,
        role: "secondary",
        method: "ontology",
      });
    }
  }

  return links;
}

export function assignThemes(insights: CanonicalInsight[]): {
  insights: CanonicalInsight[];
  themes: Theme[];
  theme_links: ThemeLink[];
} {
  const corroborated = linkCrossDocument(insights);
  const theme_links = corroborated.flatMap((insight) =>
    linkInsightToThemes(insight),
  );

  const byInsight = new Map<string, ThemeLink[]>();
  for (const link of theme_links) {
    const list = byInsight.get(link.insight_id) ?? [];
    list.push(link);
    byInsight.set(link.insight_id, list);
  }

  const tagged = corroborated.map((insight) => ({
    ...insight,
    theme_ids: (byInsight.get(insight.id) ?? []).map((l) => l.theme_id),
  }));

  const themes: Theme[] = THEME_CATALOG.map((catalog) => {
    const members = unique(
      theme_links
        .filter((l) => l.theme_id === catalog.id)
        .map((l) => l.insight_id),
    );
    const records = members
      .map((id) => tagged.find((i) => i.id === id))
      .filter((i): i is CanonicalInsight => Boolean(i));
    return {
      id: catalog.id,
      name: catalog.name,
      summary: catalog.summary,
      keywords: catalog.keywords,
      insight_ids: members,
      known_count: records.filter((m) => m.classification === "known").length,
      unknown_count: records.filter((m) => m.classification === "unknown").length,
      opportunity_count: records.filter((m) => m.classification === "opportunity")
        .length,
    };
  }).filter((t) => t.id === RESIDUAL_ID || t.insight_ids.length > 0);

  return { insights: tagged, themes, theme_links };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function linkCrossDocument(
  insights: CanonicalInsight[],
): CanonicalInsight[] {
  const next = insights.map((i) => ({
    ...i,
    knowledge_state: {
      corroborated_by: [] as string[],
      contradicted_by: [] as string[],
      evidence_strength: "single_source" as const,
    },
  }));

  for (let a = 0; a < next.length; a += 1) {
    for (let b = a + 1; b < next.length; b += 1) {
      const ia = next[a]!;
      const ib = next[b]!;
      if (ia.source_document_id === ib.source_document_id) continue;
      const sim = statementSimilarity(ia.statement, ib.statement);
      if (sim >= 0.52) {
        ia.knowledge_state.corroborated_by.push(ib.id);
        ib.knowledge_state.corroborated_by.push(ia.id);
      }
    }
  }

  return next.map((insight) => {
    const n = new Set([
      insight.source_document_id,
      ...insight.knowledge_state.corroborated_by.map(
        (id) => insights.find((x) => x.id === id)?.source_document_id,
      ),
    ]).size;
    const evidence_strength =
      n >= 3 ? "triangulated" : n === 2 ? "multi_source" : "single_source";
    return {
      ...insight,
      knowledge_state: {
        ...insight.knowledge_state,
        evidence_strength,
      },
      confidence:
        evidence_strength === "triangulated"
          ? Math.min(0.98, insight.confidence + 0.08)
          : evidence_strength === "multi_source"
            ? Math.min(0.95, insight.confidence + 0.04)
            : insight.confidence,
    };
  });
}
