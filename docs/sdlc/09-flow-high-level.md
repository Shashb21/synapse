# Application flow — high-level process

This is the **business loop**: how a brand team’s decks become a growing knowledge base. The engineering SDLC (Origin, tests, hill-climb) is [05-process.md](./05-process.md). The module-level version is [10-flow-technical.md](./10-flow-technical.md).

Synapse is not a file cabinet of PPTX. Each readout adds **notes**. Themes are **maps of content**. The graph is **associative memory**. Humans name themes; the engine never auto-promotes.

```mermaid
flowchart TD
  subgraph sources [Functions produce readouts]
    com[Commercial]
    acc[Market access]
    med[Medical affairs]
    ops[ClinOps]
    mkt[Marketing]
  end

  sources --> ingest[Ingest a deck into Synapse]
  ingest --> extract[Extract atomic insights]
  extract --> classify[Classify known / unknown / opportunity]
  classify --> score[Score against the current catalog]

  score -->|clears the floor| join[Link the CIR onto one or more named themes]
  score -->|weak max| residual[Hold once in Unassigned]

  join --> monitor[Theme monitor: situation, known, unknown, opportunity]
  residual --> emergeQ{Do two or more Unassigned claims share a decision?}
  emergeQ -->|no| wait[Wait for the next deck]
  emergeQ -->|yes| emerge[Emerge proposal on Catalog]

  join --> splitQ{Is this named theme briefing two decisions?}
  splitQ -->|no| graph
  splitQ -->|yes| split[Split proposal on Catalog]

  emerge --> human[Human accepts or rejects]
  split --> human
  human -->|accept emerge| grow[Catalog appends a new theme]
  human -->|accept split| child[Catalog appends a child; parent stays]
  human -->|reject| wait
  grow --> join
  child --> join

  join --> graph[Knowledge graph walks joins]
  residual --> graph
  graph --> reveal[Revelations: blend, bridge, new implication]
  reveal --> monitor
  monitor --> next[Next readout arrives]
  next --> ingest
  wait --> ingest
```

## What each box means

| Step | What happens | Who decides |
| --- | --- | --- |
| Ingest | A PPTX / DOCX / XLSX / PDF from one function is parsed into source blocks. | Analyst uploads on `/ingest`. |
| Extract | One claim per CIR. Double-barreled bullets split. Evidence quote + location stay on the row. | Engine. |
| Classify | Supported fact → **known**. Explicit gap → **unknown**. Concrete close-the-gap action → **opportunity**. | Engine. |
| Score | Match the statement to the catalog (keywords, patterns, function prior). | Engine. |
| Join | Membership is a `theme_links` row. The sentence is never copied onto Access and Evidence. | Engine. |
| Unassigned | Weak matches wait. They are not mashed into the nearest theme. | Engine. |
| Emerge | Unassigned cluster (≥2 CIR, shared language) → proposal. | Human names it on `/catalog`. |
| Split | One theme is two decision objects → child proposal. Parent is kept. | Human accepts on `/catalog`. |
| Graph | Blends, entity bridges, gap-closures that no single deck wrote. | Computed; nothing is extracted twice. |
| Monitor | Leadership brief: what we know, what we don’t, what we should do. | Humans read `/`. |

## Three ways the knowledge base grows

```
more decks ──► more CIR (known / unknown / opportunity)
                    │
                    ├── more catalog  (emerge or split, human accept, append-only)
                    └── more links    (joins and revelations, even when no theme is renamed)
```

1. **More CIR** — ingest another function’s readout. Questions and opportunities are insight classes, not a second database.
2. **More catalog** — a new named decision, or a child split from a parent. IDs never recycle. Parents are never deleted.
3. **More links** — Aetna RWE sitting on Access *and* Evidence; CNS in Medical next to a message gap in Marketing. That intersection is the new insight.

## What this loop refuses

- Embeddings naming themes (IDs would drift every week).
- Ingest auto-creating a theme.
- Copying the same sentence onto two theme cards.
- Deleting a parent when a child splits off.

## Where to look in the app

| You want | Route |
| --- | --- |
| Situation by theme | `/` Monitor |
| Every CIR | `/insights` |
| Emerge / split decisions | `/catalog` |
| Connections nobody typed | `/graph` |
| Upload the next deck | `/ingest` |
