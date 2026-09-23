/**
 * Ledger chapter / SI filters.
 *
 * BeOne BGB IEP: gap IDs `NSCLC_{SI}_{nn}` — SI themes as tags
 * (Biomarkers, Differentiation, Generating awareness, Health impact).
 * BeOne Tislelizumab IEGP: indication **chapter** (Transversal, Upper GI,
 * ESCC, GC/GEJ, Lung, perioperative NSCLC).
 */

export const UNASSIGNED_FILTER = "unassigned";

export type LedgerFilterQuery = {
  chapter?: string | null;
  si?: string | null;
};

export type LedgerFilterFacet = {
  slug: string;
  label: string;
  count: number;
};

export type LedgerFilterFacets = {
  chapters: LedgerFilterFacet[];
  siThemes: LedgerFilterFacet[];
};

export type LedgerFilterableMeta = {
  chapter?: unknown;
  si_theme?: unknown;
  si?: unknown;
  external_id?: unknown;
  gap_ids?: unknown;
  [key: string]: unknown;
};

export type LedgerFilterableClaim = {
  id?: string;
  claim_type?: string;
  statement?: string;
  metadata?: LedgerFilterableMeta | Record<string, unknown> | null | unknown;
};

type SiTheme = {
  code: "AD" | "CE" | "GA" | "HI";
  slug: string;
  label: string;
};

/** BGB NSCLC_{theme}_{nn} middle token → SI tag (UX spec: Differentiation, Biomarkers, …). */
export const BGB_SI_THEMES: Record<SiTheme["code"], SiTheme> = {
  AD: { code: "AD", slug: "biomarkers", label: "Biomarkers" },
  CE: { code: "CE", slug: "differentiation", label: "Differentiation" },
  GA: { code: "GA", slug: "generating-awareness", label: "Generating awareness" },
  HI: { code: "HI", slug: "health-impact", label: "Health impact" },
};

const SI_BY_SLUG: Record<string, SiTheme> = Object.fromEntries(
  Object.values(BGB_SI_THEMES).flatMap((theme) => [
    [theme.slug, theme],
    [theme.code.toLowerCase(), theme],
    [theme.label.toLowerCase(), theme],
  ]),
);

const CHAPTER_CATALOG: Array<{ slug: string; label: string; aliases: string[] }> = [
  { slug: "transversal", label: "Transversal", aliases: ["transversal"] },
  {
    slug: "across_upper_gi",
    label: "Upper GI",
    aliases: ["across_upper_gi", "upper_gi", "upper gi", "upper-gi"],
  },
  {
    slug: "advanced_metastatic_escc",
    label: "ESCC",
    aliases: ["advanced_metastatic_escc", "escc"],
  },
  {
    slug: "advanced_metastatic_gc_gej",
    label: "GC/GEJ",
    aliases: ["advanced_metastatic_gc_gej", "gc_gej", "gc/gej", "gc-gej", "gcgej"],
  },
  {
    slug: "across_lung",
    label: "Lung",
    aliases: ["across_lung", "lung"],
  },
  {
    slug: "perioperative_nsclc",
    label: "Perioperative NSCLC",
    aliases: ["perioperative_nsclc", "perioperative"],
  },
];

const CHAPTER_ALIAS_TO_SLUG = new Map<string, string>();
const CHAPTER_LABEL_BY_SLUG = new Map<string, string>();
for (const row of CHAPTER_CATALOG) {
  CHAPTER_LABEL_BY_SLUG.set(row.slug, row.label);
  for (const alias of row.aliases) {
    CHAPTER_ALIAS_TO_SLUG.set(normalizeKey(alias), row.slug);
  }
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function asMeta(claim: LedgerFilterableClaim): LedgerFilterableMeta {
  const meta = claim.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  return meta as LedgerFilterableMeta;
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Parse `NSCLC_CE_01` / `NSCLC_HI_14` → SI code. */
export function siCodeFromGapId(externalId: string | null | undefined): SiTheme["code"] | null {
  if (!externalId) return null;
  const match = externalId.trim().match(/^[A-Za-z0-9]+_([A-Za-z]{2})_\d+$/);
  if (!match) return null;
  const code = match[1]!.toUpperCase();
  if (code === "AD" || code === "CE" || code === "GA" || code === "HI") return code;
  return null;
}

export function siThemeFromCode(code: string | null | undefined): SiTheme | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (upper === "AD" || upper === "CE" || upper === "GA" || upper === "HI") {
    return BGB_SI_THEMES[upper];
  }
  return SI_BY_SLUG[normalizeKey(code).replace(/_/g, "-")] ?? SI_BY_SLUG[normalizeKey(code)] ?? null;
}

export function siThemeFromSlugOrLabel(value: string | null | undefined): SiTheme | null {
  if (!value) return null;
  const key = normalizeKey(value);
  const dashed = key.replace(/_/g, "-");
  return SI_BY_SLUG[key] ?? SI_BY_SLUG[dashed] ?? siThemeFromCode(value);
}

export function siThemeFromGapId(externalId: string | null | undefined): SiTheme | null {
  const code = siCodeFromGapId(externalId);
  return code ? BGB_SI_THEMES[code] : null;
}

export function normalizeChapterSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = normalizeKey(value);
  if (!key) return null;
  return CHAPTER_ALIAS_TO_SLUG.get(key) ?? key;
}

export function chapterLabel(slug: string | null | undefined): string {
  if (!slug) return "Unassigned";
  if (slug === UNASSIGNED_FILTER) return "Unassigned";
  const normalized = normalizeChapterSlug(slug) ?? slug;
  return CHAPTER_LABEL_BY_SLUG.get(normalized) ?? humanizeSlug(normalized);
}

export function siThemeLabel(slug: string | null | undefined): string {
  if (!slug) return "Unassigned";
  if (slug === UNASSIGNED_FILTER) return "Unassigned";
  const theme = siThemeFromSlugOrLabel(slug);
  if (theme) return theme.label;
  return humanizeSlug(slug);
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

export function claimChapterSlug(claim: LedgerFilterableClaim): string | null {
  return normalizeChapterSlug(stringField(asMeta(claim).chapter));
}

function siFromExplicit(meta: LedgerFilterableMeta): SiTheme | null {
  return (
    siThemeFromSlugOrLabel(stringField(meta.si_theme)) ??
    siThemeFromSlugOrLabel(stringField(meta.si)) ??
    siThemeFromGapId(stringField(meta.external_id))
  );
}

function gapIds(meta: LedgerFilterableMeta): string[] {
  if (!Array.isArray(meta.gap_ids)) return [];
  return meta.gap_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

/** SI slugs on a claim: explicit theme, NSCLC_* id, or linked tactic gap_ids. */
export function claimSiSlugs(claim: LedgerFilterableClaim): string[] {
  const meta = asMeta(claim);
  const slugs = new Set<string>();
  const explicit = siFromExplicit(meta);
  if (explicit) slugs.add(explicit.slug);
  for (const id of gapIds(meta)) {
    const theme = siThemeFromGapId(id);
    if (theme) slugs.add(theme.slug);
  }
  return [...slugs];
}

export function claimMatchesLedgerFilters(
  claim: LedgerFilterableClaim,
  filters: LedgerFilterQuery,
): boolean {
  const chapter = filters.chapter?.trim() || null;
  const si = filters.si?.trim() || null;
  if (chapter) {
    const claimChapter = claimChapterSlug(claim);
    if (chapter === UNASSIGNED_FILTER) {
      if (claimChapter) return false;
    } else if (claimChapter !== normalizeChapterSlug(chapter)) {
      return false;
    }
  }
  if (si) {
    const slugs = claimSiSlugs(claim);
    if (si === UNASSIGNED_FILTER) {
      if (slugs.length > 0) return false;
    } else {
      const wanted = siThemeFromSlugOrLabel(si)?.slug ?? normalizeKey(si).replace(/_/g, "-");
      if (!slugs.includes(wanted)) return false;
    }
  }
  return true;
}

export function filterLedgerClaims<T extends LedgerFilterableClaim>(
  claims: T[],
  filters: LedgerFilterQuery,
): T[] {
  if (!filters.chapter && !filters.si) return claims;
  return claims.filter((claim) => claimMatchesLedgerFilters(claim, filters));
}

function bumpFacet(
  map: Map<string, LedgerFilterFacet>,
  slug: string,
  label: string,
): void {
  const existing = map.get(slug);
  if (existing) existing.count += 1;
  else map.set(slug, { slug, label, count: 1 });
}

/** Facets from the unfiltered workspace inventory (hide empty dimensions). */
export function ledgerFilterFacets(claims: LedgerFilterableClaim[]): LedgerFilterFacets {
  const chapters = new Map<string, LedgerFilterFacet>();
  const siThemes = new Map<string, LedgerFilterFacet>();
  let unassignedChapter = 0;
  let unassignedSi = 0;

  for (const claim of claims) {
    const chapter = claimChapterSlug(claim);
    if (chapter) bumpFacet(chapters, chapter, chapterLabel(chapter));
    else unassignedChapter += 1;

    const slugs = claimSiSlugs(claim);
    if (slugs.length === 0) unassignedSi += 1;
    for (const slug of slugs) {
      bumpFacet(siThemes, slug, siThemeLabel(slug));
    }
  }

  if (unassignedChapter > 0 && chapters.size > 0) {
    chapters.set(UNASSIGNED_FILTER, {
      slug: UNASSIGNED_FILTER,
      label: "Unassigned",
      count: unassignedChapter,
    });
  }
  if (unassignedSi > 0 && siThemes.size > 0) {
    siThemes.set(UNASSIGNED_FILTER, {
      slug: UNASSIGNED_FILTER,
      label: "Unassigned",
      count: unassignedSi,
    });
  }

  return {
    chapters: [...chapters.values()],
    siThemes: [...siThemes.values()],
  };
}

export function ledgerHref(workspaceId: string, filters: LedgerFilterQuery = {}): string {
  const params = new URLSearchParams();
  params.set("workspace_id", workspaceId);
  if (filters.chapter) params.set("chapter", filters.chapter);
  if (filters.si) params.set("si", filters.si);
  return `/accuracy/ledger?${params.toString()}`;
}

export function parseLedgerFilters(search: {
  chapter?: string | string[] | undefined;
  si?: string | string[] | undefined;
}): LedgerFilterQuery {
  const chapterRaw = Array.isArray(search.chapter) ? search.chapter[0] : search.chapter;
  const siRaw = Array.isArray(search.si) ? search.si[0] : search.si;
  const chapter = chapterRaw?.trim() || null;
  const si = siRaw?.trim() || null;
  return {
    chapter: chapter ? (chapter === UNASSIGNED_FILTER ? UNASSIGNED_FILTER : normalizeChapterSlug(chapter) ?? chapter) : null,
    si: si
      ? si === UNASSIGNED_FILTER
        ? UNASSIGNED_FILTER
        : (siThemeFromSlugOrLabel(si)?.slug ?? si)
      : null,
  };
}
