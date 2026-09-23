/**
 * Mechanical completeness-audit noise filters (no LLM).
 *
 * Gold PPTX seed otherwise yields hundreds of open Review flags from slide titles,
 * chapter dividers, SI labels, TOC, abbreviation walls, and split a:t fragments.
 * Skip those so `/accuracy/review` is demo-tractable without mass dismiss.
 */

export const COMPLETENESS_SKIP_REASONS = [
  "heading_only",
  "chapter_label",
  "si_label",
] as const;

export type CompletenessSkipReason = (typeof COMPLETENESS_SKIP_REASONS)[number];

export type SkipRuleBlock = {
  kind: string;
  text: string;
  heading?: string | null;
};

/** Slide-title / section-chrome kinds stored from parse (`title` → heading). */
export const HEADING_BLOCK_KINDS = new Set(["heading", "title"]);

const CHAPTER_CORE =
  "(?:transversal(?:\\s+gaps?)?(?:\\s+across all indications)?|across upper gi(?:\\s*\\(escc,?\\s*gc\\/gej\\))?|upper gi|advanced\\s*\\/\\s*metastatic\\s*(?:escc|gc\\/gej)|across lung|perioperative nsclc|escc|gc\\/gej)";

const CHAPTER_SECTION_PREFIX =
  "(?:evidence gap prioritization|priority gaps and tactics|evidence gaps|tactics|implementation roadmap|high(?:\\s*&\\s*|\\s+and\\s+)?medium priority evidence gaps?|low priority evidence gaps?|esmo list of evidence gaps?)";

/** Whole-block Tisle chapter divider / chapter-section title. */
const CHAPTER_LABEL = new RegExp(
  `^(?:\\d+\\.\\s*)?(?:${CHAPTER_SECTION_PREFIX})?[:\\s-]*${CHAPTER_CORE}(?:\\s*\\(\\d+\\/\\d+\\))?$`,
  "i",
);

const CHAPTER_SECTION_TITLE = new RegExp(
  `^${CHAPTER_SECTION_PREFIX}\\s*:\\s*${CHAPTER_CORE}`,
  "i",
);

const CHAPTER_NAV_CHROME =
  /^(?:iegp chapter flow|navigating the gap prioritization section|mini iegp chapters\b|aligned list of evidence gaps have been organized by|the following framework is used to organize evidence gaps|organized per indication:?)$/i;

const SI_WHOLE =
  /^(?:medical\s+)?strategic imperatives?$|^si\s*\d+\s*[:.)-].+$|^overview of prioritized evidence gaps\s*\(?\s*si\s*\d+/i;

const SI_THEME_ONLY =
  /^(?:drive )?differentiation$|^biomarkers?$|^combinations?(?:\s+and\s+sequencing)?$|^sequencing$/i;

const SI_LEGEND =
  /^strategic imperative\(s\) related to evidence gap$|^strategic rationale for evidence gap\b|^medical objectives related to evidence gap$/i;

const SI_NUMBERED_STRATEGY =
  /^(?:\d+\.\s+[A-Z][^0-9.]{2,80}\s+){2,}\d+\./;

const SI_PAREN = /\(\s*si\s*\d+\s*:/i;

const TOC = /table of contents/i;

const BOILERPLATE =
  /^(?:confidential|thank you|discussion|appendix|disclaimer|copyright|proprietary)\b/i;

const ABBREV_WALL = /(?:\b[A-Z]{2,12}:\s*[^;]{2,80};\s*){2,}/;

const SOURCE_LINE = /^(?:abbreviations?|source|notes?)\s*:/i;

const DECK_FOOTER =
  /^(?:planned\s*\/?\s*addressed tactics|prioritized evidence gaps|overview of prioritized evidence gaps|list of planned\/addressed tactics|gated gaps|tactical synergies|consolidated tactic|executive summary|iegp introduction|key evidence gap themes|approach to evidence gap prioritization|relative investment required to execute tactic|\d{4} iit areas of interest)$/i;

const DECK_PROCESS =
  /^(?:this iegp\b|the tislelizumab iegp\b|gap originated at esmo\b|esmo gaps that are\b|ongoing\/planned evidence generation activities\b)|(?:post-hoc analyses\s+)?interventional studies\s*\/\s*iits\b/i;

/** Keep real gap/tactic body even when it mentions a chapter or SI in passing. */
const MATERIAL_CLAIM =
  /\b(?:need for|unmet evidence|NSCLC_[A-Z]{2}_\d{2}|G:\d+)\b/i;

const NUMBERING_EXPLAINER =
  /numbering systems? that (?:corresponds?|catalogs?) all[\s\S]{0,60}evidence generation activities/i;

const ESMO_AT_CLOSE_NOTE =
  /gaps identified at esmo[\s\S]{0,80}(?:at-?\s*or\s*near-close|do not require)/i;

export function collapseAuditText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizedEquals(a: string, b: string): boolean {
  return collapseAuditText(a).toLowerCase() === collapseAuditText(b).toLowerCase();
}

function isAbbreviationWall(text: string): boolean {
  if (ABBREV_WALL.test(text)) return true;
  if (SOURCE_LINE.test(text) && text.length > 40) return true;
  if (/^(?:[A-Z]{2,12}:\s*[^;]{2,50};?\s*){2,}$/.test(text)) return true;
  return false;
}

function isTitleLikeChrome(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (MATERIAL_CLAIM.test(text)) return false;
  if (/\b(trial|study|need|tactic|registry|rwe|iit|phase|chart review)\b/i.test(text)) {
    return false;
  }
  const withoutEtc = text.replace(/\betc\./gi, "etc");
  if (/[.?!]/.test(withoutEtc)) return false;
  if (words.length <= 8 && /^[A-Z0-9]/.test(text)) return true;
  if (words.length <= 14 && /^[A-Z]/.test(text)) return true;
  return false;
}

const FRAGMENT_START = new Set([
  ",",
  ";",
  ":",
  ".",
  ")",
  "-",
  "(",
  "[",
  "/",
  "*",
  "&",
  "“",
  "”",
  '"',
  "'",
  "‘",
  "’",
]);

function isParseFragment(text: string): boolean {
  if (MATERIAL_CLAIM.test(text)) return false;
  if (/^\([^)]*\)\s*$/.test(text)) return true;
  if (/^\((?:short|medium|long)[-\s]term\b/i.test(text)) return true;
  const first = text[0] ?? "";
  if (FRAGMENT_START.has(first)) return true;
  if (/^[a-z]/.test(text)) return true;
  return false;
}

export function isHeadingOnlyNoise(block: SkipRuleBlock): boolean {
  if (HEADING_BLOCK_KINDS.has(block.kind)) return true;
  const text = collapseAuditText(block.text);
  const heading = collapseAuditText(block.heading ?? "");
  if (!text) return true;
  if (TOC.test(heading) || TOC.test(text)) return true;
  if (BOILERPLATE.test(text) || /disclaimer/i.test(heading)) return true;
  if (isAbbreviationWall(text)) return true;
  if (DECK_FOOTER.test(text) || DECK_PROCESS.test(text)) return true;
  if (NUMBERING_EXPLAINER.test(text) || ESMO_AT_CLOSE_NOTE.test(text)) return true;
  if (heading && normalizedEquals(text, heading)) return true;
  if (isParseFragment(text)) return true;
  if (isTitleLikeChrome(text)) return true;
  return false;
}

export function isChapterLabelNoise(block: SkipRuleBlock): boolean {
  const text = collapseAuditText(block.text);
  if (!text) return false;
  if (CHAPTER_LABEL.test(text)) return true;
  if (CHAPTER_SECTION_TITLE.test(text)) return true;
  if (CHAPTER_NAV_CHROME.test(text)) return true;
  return false;
}

export function isSiLabelNoise(block: SkipRuleBlock): boolean {
  const text = collapseAuditText(block.text);
  if (!text) return false;
  if (SI_WHOLE.test(text)) return true;
  if (SI_THEME_ONLY.test(text)) return true;
  if (SI_LEGEND.test(text)) return true;
  if (SI_NUMBERED_STRATEGY.test(text)) return true;
  if (SI_PAREN.test(text) && text.length < 120 && !MATERIAL_CLAIM.test(text)) return true;
  return false;
}

/**
 * Why this block should not become an open miss flag, or null to audit it.
 * Slide titles and TOC rows win over chapter/SI when both match.
 */
export function completenessSkipReason(block: SkipRuleBlock): CompletenessSkipReason | null {
  if (HEADING_BLOCK_KINDS.has(block.kind)) return "heading_only";
  const text = collapseAuditText(block.text);
  const heading = collapseAuditText(block.heading ?? "");
  if (TOC.test(heading) || TOC.test(text)) return "heading_only";
  if (isChapterLabelNoise(block)) return "chapter_label";
  if (isSiLabelNoise(block)) return "si_label";
  if (isHeadingOnlyNoise(block)) return "heading_only";
  return null;
}

export function emptySkipCounts(): Record<CompletenessSkipReason, number> {
  return {
    heading_only: 0,
    chapter_label: 0,
    si_label: 0,
  };
}
