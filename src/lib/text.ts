const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "vs",
  "versus",
  "with",
  "by",
  "at",
  "is",
  "are",
  "was",
  "be",
  "as",
  "that",
  "this",
  "from",
  "into",
  "will",
  "has",
  "have",
  "not",
  "no",
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9.%+\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .map((t) => t.replace(/(ing|ed|es|s)$/i, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokens(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const KEYPHRASE =
  /\b(\d+(\.\d+)?%?|q[1-4]\s*20\d{2}|20\d{2}|aetna|unitedhealthcare|horizon|medicaid|cms|ira|icer|cns|osi(mertinib)?|velmara|velmaratinib|egfrm?|nsclc|nx-441|nps|pdufa|amcp|rems|t790m|texas|florida|new york|japan|southeast|340b|ild|odac|qaly|wac|prea|etasu|boxed|c797s)\b/gi;

export function keyphrases(text: string): Set<string> {
  const found = new Set<string>();
  const n = normalize(text);
  for (const m of n.matchAll(KEYPHRASE)) {
    found.add(m[1]!.toLowerCase());
  }
  for (const t of tokens(text)) {
    if (/\d/.test(t) || t.length >= 8) found.add(t);
  }
  return found;
}

export function statementSimilarity(a: string, b: string): number {
  const ja = jaccard(tokenSet(a), tokenSet(b));
  const ka = keyphrases(a);
  const kb = keyphrases(b);
  const jk = jaccard(ka, kb);
  return 0.55 * ja + 0.45 * jk;
}

export function hashId(prefix: string, value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

const VERBS =
  /\b(is|are|was|were|has|have|had|will|do|does|did|remain|remains|support|supports|erode|erodes|delay|delayed|request|requested|expect|expected|file|contest|impose|flagged|signaled|exist|exists|asked|misses|determine|slipped|over-index|over-indexes|shift|amend|stand|close|want|need|measure|measured|modeled|fielded|quantified|occurred|exceeds|paused|declined|incomplete|outstanding|scheduled|proposed|named|called|account|convene|rebase|matching|put|puts)\b/i;

export function looksLikeClaim(text: string): boolean {
  const t = text.trim();
  if (t.length < 24) return false;
  if (/^(agenda|appendix|thank you|confidential|draft|readout|title)/i.test(t)) {
    return false;
  }
  return VERBS.test(t) || /\d/.test(t) || /unknown|gap|opportunity|risk/i.test(t);
}

export function atomize(text: string): string[] {
  const prepared = text
    .replace(/\s+/g, " ")
    .replace(/\s+and both\s+/gi, ". Both ")
    .replace(/\s+and we\s+/gi, ". We ")
    .trim();

  const parts = prepared
    .split(/(?<=;)\s+|(?<=\.)\s+(?=[A-Z])/)
    .map((p) =>
      p
        .replace(/^[\-–•\d.)\s]+/, "")
        .replace(/[;]+$/g, "")
        .trim(),
    )
    .filter((p) => p.length >= 12);

  return parts.length > 0 ? parts : [prepared];
}

export function stripBullet(text: string): string {
  return text.replace(/^[\-–•●◦\s]+/, "").replace(/^\d+[.)]\s+/, "").trim();
}
