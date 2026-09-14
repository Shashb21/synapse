# Knowledge graph — how the base is supposed to grow

The catalog is the **ontology** (named decision objects). The graph is the **associative memory**. Together they are the knowledge base. Insights keep arriving; the base is not a folder of decks.

This is not a new invention. Synapse follows a small set of existing frameworks, then refuses the ones that would mash the record.

## What we took

| Framework | What it gives us | Where it lives |
| --- | --- | --- |
| **Zettelkasten** (Luhmann) | Atomic notes, stable IDs, links instead of copies. A CIR is a zettel. | `insights[]` |
| **Evergreen notes / MOCs** (Matuschak, Obsidian) | Themes are maps of content, not directories. A note can sit in many maps. | `theme_links` |
| **Polyhierarchy / Topic Maps (ISO 13250)** | One occurrence, many topics, typed associations. | primary + secondary links |
| **Ontology evolution** | Append-only classes. New names get new IDs. Parents are not deleted. | `/catalog` emerge & split |
| **Chinese Restaurant / HDP intuition** | A new table (theme) appears when residuals cluster; you do not force guests onto the nearest existing table. | Unassigned → emerge |
| **Formal concept analysis / modularity** | A class splits when its members are two concepts. | split proposals |
| **Spreading activation** (Collins & Loftus) | Retrieve by walking neighbors, not by a search box alone. | `/graph` |
| **Structural holes** (Burt) | Value is at the thin bridges between clusters. | theme bridges |
| **Conceptual blending** (Fauconnier & Turner) | A new implication at the intersection of two frames. | gap-closure revelations |
| **Pirolli–Card sensemaking** | Forage (ingest) → schema (catalog) → insight (brief + revelations). | the whole loop |
| **Hebbian co-occurrence** | Claims that keep firing together strengthen a join (corroboration, multi-theme). | `corroborated_by`, blends |

Obsidian is the closest product metaphor: notes stay atomic; the graph is emergent; a Map of Content is a human-named hub. A neural net is the wrong metaphor for *storage* (weights are opaque) and the right metaphor for *retrieval* (activation spreads across links).

## What we refused

- **Vanilla embedding clusters** as the catalog. Theme IDs would drift every ingest. A VP cannot brief Theme-7-this-week.
- **PARA / file cabinets.** Decks are sources, not the knowledge.
- **Copying the sentence onto every theme.** That is how “insights” turn into slideware.

## Three kinds of growth

1. **More CIR** — ingest another readout. The note store grows. Questions (unknowns) and opportunities are CIR classes, not a separate database.
2. **More catalog** — emerge (residuals become a named theme) or split (a theme was briefing two decisions). Human accepts. Append-only.
3. **More links** — the graph grows even when no theme is renamed: a second function mentions CNS, a claim sits on Access *and* Evidence, two unknowns share Aetna. Those joins are how a “new insight” appears that nobody typed.

## Revelations (REQ-GRF-001 / 002)

Computed, not extracted:

- **Blend** — one CIR, two+ named themes.
- **Bridge** — two CIR share an entity, share no theme, usually two documents.
- **Gap-closure** — unknown × known/opportunity on the same entity. The implication was not in either deck.

See `/graph`. Catalog process remains `/catalog`.
