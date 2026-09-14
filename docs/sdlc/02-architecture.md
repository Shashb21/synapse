# Architecture

## Why not nested JSON, and why not “just embed everything”

The analyst’s object is an **atomic insight**, not a document tree. Clustering, eval matching, and the briefing all iterate insights. A **flat Canonical Insight Record (CIR)** plus two join collections is the store:

```
documents[]          1 —n  insights[]          1 —n  theme_links[]  n— 1  themes[]
                         1 —n  knowledge_state.corroborated_by (peer insights)
```

- **CIR JSON** (one object per insight) is the system of record. Export as JSON array or JSONL for evals.
- **theme_links** is the 1-to-many (insight → themes) join. Themes never copy `statement`.
- Nested “document → slides → bullets → insights” JSON looks tidy and is hostile to clustering, gold matching, and multi-theme membership.

LlamaCloud Parse v2 (agentic + specialized chart parsing) is the primary ingest path for PPTX/PDF graphics. Local OOXML is the fallback. Both emit the same `ParsedDocument` / `ParsedBlock` shape, including `chart` blocks (REQ-ING-004). Live extraction uses Claude Sonnet (`v1.4-claude`) when `ANTHROPIC_API_KEY` is set; the eval ladder stays on local v1.0–v1.3 so hill-climb scores remain deterministic.

## Why not vanilla semantic clustering

Embedding + k-means / HDBSCAN is a poor primary theming strategy for this workflow:

1. **Themes are decision objects**, not latent blobs. “IRA net price” and “Horizon outcomes contract” are semantically far and both belong under Access / Policy.
2. **One claim, two decisions** is the common case. “Aetna delayed formulary pending 6-month discontinuation RWE” is Access **and** Evidence. Unsupervised clustering forces a single assignment or duplicates the row.
3. **Cluster IDs drift** every ingest. A brand VP cannot brief against Theme-7-this-week.
4. Embeddings **are** the right tool for a different job: **near-duplicate detection** across decks (REQ-CLU-006), which we keep on `knowledge_state.corroborated_by`.

## What we use instead: catalog + scored multi-label links

```
                    ┌─────────────┐
   Parsed blocks ─▶│  Proposer    │─▶ CIR (once)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ Ontology     │  keywords + patterns + stakeholder prior
                    │ scorer       │
                    └──────┬──────┘
                           │ scores ≥ threshold
                    ┌──────▼──────┐
                    │ theme_links  │  primary + 0..n secondary
                    └──────┬──────┘
                           │
              weak max ─▶ THEME-RESIDUAL (propose new catalog entry)
```

Optional embeddings (when an API key exists in a later slice) are a **score booster against catalog centroids**, never the clusterer. Residuals may be grouped to *propose* a new named theme ([07-catalog-evolution.md](./07-catalog-evolution.md)); they are not auto-merged into an unstable blob.

The catalog is the ontology. The **knowledge graph** ([08-knowledge-graph.md](./08-knowledge-graph.md)) is associative memory: blends (one CIR, many themes), corroboration, entity bridges, and gap-closures. That is the Zettelkasten / Obsidian layer — not a neural net of opaque weights.

## Runtime

- Next.js App Router, Node runtime for ingest (zip/xml, mammoth, xlsx).
- File store `data/runtime/engine-state.json` locally; in-memory fallback on read-only hosts (Vercel).
- Seed corpus: five Velmara readouts (commercial, access, medical, clin ops, marketing) plus gold CIRs. Off-catalog claims (e.g. REMS) residual and may **emerge**; a named theme that is briefing two decisions may **split**. Humans accept on `/catalog` ([07-catalog-evolution.md](./07-catalog-evolution.md)).

## Three-model eval loop

```
prompt versions ─▶ proposer extract ─▶ critique (partial/wrong/missed/new)
                                      ─▶ judge (composite + safety gate)
                                      ─▶ improver patch / next version
                                      ─▶ promote champion (REQ-EVA-009/010)
```

Local strategies (`bullet-only` → `claim-split` → `gap-scan` → `full`) implement the same version ladder the LLM prompts describe, so the hill-climb is real without credentials.

## Origin / Cloud Agent / Grokbot

See [05-process.md](./05-process.md). CI is the regression spine; Cloud Agent runs evals; Grokbot reviews REQ coverage on the PR.

Application flow diagrams: [09-flow-high-level.md](./09-flow-high-level.md) (process), [10-flow-technical.md](./10-flow-technical.md) (modules and APIs).
