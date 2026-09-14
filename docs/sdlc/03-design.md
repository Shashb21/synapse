# Design

## CIR (flat)

```
{
  "id": "INS-…",
  "statement": "Aetna and UnitedHealthcare have requested 6-month discontinuation RWE.",
  "evidence_quote": "…verbatim…",
  "source_document_id": "DOC-COM-001",
  "source_location": { "kind": "slide", "ref": "Slide 4" },
  "stakeholder_function": "commercial",
  "theme_ids": ["THEME-EVIDENCE", "THEME-ACCESS"],
  "classification": "known",
  "knowledge_state": { "corroborated_by": [], "contradicted_by": [], "evidence_strength": "single_source" },
  "confidence": 0.84,
  "extractor_prompt_version": "v1.3-cross-functional",
  "status": "accepted"
}
```

`theme_ids` on the CIR is a denormalized FK list for export. **Source of truth for membership is `theme_links`.**

## theme_links (1-to-many, no copies)

```
{ "insight_id": "INS-…", "theme_id": "THEME-ACCESS", "score": 4.2, "role": "primary", "method": "ontology" }
{ "insight_id": "INS-…", "theme_id": "THEME-EVIDENCE", "score": 2.7, "role": "secondary", "method": "ontology" }
```

Rules (REQ-CLU-002/003):

- One CIR row. Briefing panes key by `insight.id`.
- Theme pages query `insight.theme_ids.includes(themeId)` and render the same object.
- Secondary links require score ≥ 0.9 and ≥ 48% of the primary score, cap 4 themes.
- Unmatched → `THEME-RESIDUAL` (REQ-CLU-005).

## Extractor ladder

| Version | Strategy | Intent |
| --- | --- | --- |
| v1.0-baseline | bullet-only | Lossy starting rung; misses prose/tables; keeps compound bullets (partials). |
| v1.1-atomic | claim-split | Split `and both` / sentences. |
| v1.2-gap-sensitive | gap-scan | Prose + cells; Open questions → unknown. |
| v1.3-cross-functional | full | Heading carry, dedup, grounding. Intended champion. |

## Classification

Unknown beats known when the statement contains gap language (`unquantified`, `not measured`, `whether`). Opportunity beats unknown when the statement is an action (`stand up`, `protocol amendment`, `shift 40%`).

## UI

- `/` theme monitor. Unassigned is always last — residual CIR rows wait there.
- `/insights` every CIR in one list, filterable by theme (including Unassigned) and class.
- `/catalog` emerge / split proposals; accept grows the catalog (REQ-CLU-007/008).
- `/graph` associative memory: theme network plus blend / bridge / gap-closure revelations (REQ-GRF-001/002).
- `/themes/[id]` members via join; shows role/score.
- `/ingest` Office upload + Velmara sample pack.
- `/evals` view-only tape of the automatic hill-climb (critique, judge, proposer). No Run button.
- `/sdlc` view-only spec tape of these docs, including the high-level and technical flow diagrams.

## Security / data

Demo corpus is fictional (Velmara / velmaratinib). No auth in v1 (internal tool). Do not commit secrets; `.env.example` lists optional keys.
