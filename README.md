# Velmara Insights Engine

Real-time cross-functional insights for biopharma brand teams. Ingest PowerPoint, Word, and Excel readouts, extract atomic Canonical Insight Records, **link** them to themes (one insight, many themes, no copies), and brief **what we know / don’t know / opportunities to close gaps**. A critique → judge → proposer loop hill-climbs the extractor against a gold set.

This repo is the v1 slice: a working briefing on a fictional asset (**Velmara / velmaratinib**, 2L EGFRm NSCLC) plus the SDLC pack under `docs/sdlc/`.

## Why linkage instead of semantic clustering

Unsupervised embeddings mash “access” and “evidence” into an unstable blob and either **duplicate** the card or **force a single theme**. Brand themes are decision objects. v1 uses a versioned catalog and a `theme_links` join table: the CIR is stored once; Access and Evidence both point at it. Embeddings, when added later, score near-duplicates across decks — they do not name themes. Full argument: [`docs/sdlc/02-architecture.md`](docs/sdlc/02-architecture.md).

## Run locally

```bash
npm install
npm test
npm run dev
```

App: [http://127.0.0.1:43217](http://127.0.0.1:43217)

| Route | What |
| --- | --- |
| `/` | Known / unknown / opportunity briefing |
| `/ingest` | Upload PPTX/DOCX/XLSX/PDF via LlamaCloud + Claude |
| `/evals` | Hill-climb lab |
| `/sdlc` | Requirements, architecture, TDD |

PoC keys (documents may leave the VPC). Copy `.env.example` → `.env.local`:

```
LLAMA_CLOUD_API_KEY=llx-...
LLAMA_PARSE_TIER=agentic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5
```

- **LlamaCloud** reads charts/graphs/graphics that native PPTX XML cannot see.
- **Claude Sonnet** extracts atomic CIR insights on ingest. Eval hill-climb stays on the local v1.0–v1.3 ladder so scores do not wobble.
- Without keys the seed briefing still runs on local parsers/extractors.

## Tests

```bash
npm test          # unit tests named with REQ IDs
npm run test:e2e  # Playwright regression
```

## Data model (flat CIR)

Insights are flat JSON objects plus `theme_links[]` (`insight_id`, `theme_id`, `score`, `role`). Themes hold IDs only. See [`docs/sdlc/03-design.md`](docs/sdlc/03-design.md).
