/**
 * The spec documents the owner console shows: rendered with diagrams at
 * /admin/sdlc and served raw at /admin/docs/sdlc/<slug>. One list, so the two
 * pages always agree (KAN-63). `retired` marks the v1 insights-engine pages,
 * kept for lineage only (each opens with a "Retired — v1" banner).
 */
export const SPEC_DOCS = [
  { slug: "iegp-model.md", rel: "docs/iegp-model.md", id: "IEGP", title: "IEGP model", retired: false },
  { slug: "problem-and-solution.md", rel: "docs/problem-and-solution.md", id: "PS", title: "Problem & solution", retired: false },
  { slug: "01-requirements.md", rel: "docs/sdlc/01-requirements.md", id: "REQ", title: "Requirements", retired: false },
  { slug: "02-architecture.md", rel: "docs/sdlc/02-architecture.md", id: "ARCH", title: "Architecture", retired: false },
  { slug: "03-design.md", rel: "docs/sdlc/03-design.md", id: "DES", title: "Design", retired: true },
  { slug: "04-tdd.md", rel: "docs/sdlc/04-tdd.md", id: "TDD", title: "TDD", retired: true },
  { slug: "05-process.md", rel: "docs/sdlc/05-process.md", id: "PRC", title: "Process", retired: false },
  { slug: "06-eval-protocol.md", rel: "docs/sdlc/06-eval-protocol.md", id: "EVA", title: "Eval protocol", retired: true },
  { slug: "07-catalog-evolution.md", rel: "docs/sdlc/07-catalog-evolution.md", id: "CAT", title: "Catalog evolution", retired: true },
  { slug: "08-knowledge-graph.md", rel: "docs/sdlc/08-knowledge-graph.md", id: "GRF", title: "Knowledge graph", retired: true },
  { slug: "09-flow-high-level.md", rel: "docs/sdlc/09-flow-high-level.md", id: "FLOW", title: "Flow (process)", retired: false },
  { slug: "10-flow-technical.md", rel: "docs/sdlc/10-flow-technical.md", id: "TECH", title: "Flow (technical)", retired: false },
  { slug: "11-regression.md", rel: "docs/sdlc/11-regression.md", id: "REG", title: "Regression", retired: true },
  { slug: "12-gold-set.md", rel: "docs/sdlc/12-gold-set.md", id: "GOLD", title: "Gold set", retired: true },
  { slug: "13-testing.md", rel: "docs/sdlc/13-testing.md", id: "TEST", title: "Testing", retired: false },
  { slug: "requirements-compliance.md", rel: "docs/sdlc/requirements-compliance.md", id: "CMP", title: "Requirements compliance", retired: false },
] as const;

export type SpecDoc = (typeof SPEC_DOCS)[number];

/** Every slug with a raw route. */
export const SDLC_DOCS = SPEC_DOCS.map((doc) => doc.slug);

/** The spec for a slug; only these files are ever read, so a slug can't reach elsewhere. */
export function specDoc(slug: string | undefined): SpecDoc | undefined {
  return SPEC_DOCS.find((doc) => doc.slug === slug);
}
