# Requirements — Velmara Insights Engine

Status: accepted for v1. IDs are stable; tests and design cite them.

## Product intent

Cross-functional biopharma teams (commercial, market access, medical affairs, clin ops, marketing) produce PowerPoint, Word, and Excel readouts. An analyst extracts discrete insights, clusters them into themes without duplicating the same finding, and briefs leadership on **what we know**, **what we don’t**, and **opportunities to close gaps**. This product automates that loop and hill-climbs the extractor with a critique / judge / proposer eval system.

## Ingest

| ID | Requirement | Priority |
| --- | --- | --- |
| REQ-ING-001 | Ingest native PPTX decks into ordered source blocks (slide + heading + text). | Must |
| REQ-ING-002 | Ingest native DOCX memos into page/section blocks. | Must |
| REQ-ING-003 | Ingest native XLSX trackers into sheet/cell blocks. | Must |
| REQ-ING-004 | Prefer LlamaParse OCR when `LLAMA_CLOUD_API_KEY` is set; fall back to local parsers without failing the job. | Must |
| REQ-ING-005 | Persist parsed documents with stakeholder function, parser used, and full text. | Must |

## Extraction (CIR)

| ID | Requirement | Priority |
| --- | --- | --- |
| REQ-EXT-001 | Extract **atomic** insights (one claim per record; split double-barreled bullets). | Must |
| REQ-EXT-002 | Every insight carries a verbatim evidence quote and source location. | Must |
| REQ-EXT-003 | Tag stakeholder function from document metadata. | Must |
| REQ-EXT-004 | Store insights as flat Canonical Insight Records (CIR JSON). Nested trees are not the system of record. | Must |
| REQ-EXT-005 | Version the extractor prompt/strategy so evals can hill-climb. | Must |

## Themes (linkage, not copies)

| ID | Requirement | Priority |
| --- | --- | --- |
| REQ-CLU-001 | Assign insights to a versioned theme catalog (decision objects, not unsupervised blobs). | Must |
| REQ-CLU-002 | An insight may belong to many themes via a 1-to-many join (`theme_links`). | Must |
| REQ-CLU-003 | Do **not** duplicate CIR rows when an insight hangs off multiple themes. Themes store insight IDs only. | Must |
| REQ-CLU-004 | Do not force unrelated claims into a neighbouring theme (precision over recall on links). | Must |
| REQ-CLU-005 | Residual / unmatched claims go to an Unassigned theme and may propose a new catalog entry; they are not silently dropped or semantically mashed. | Must |
| REQ-CLU-006 | Cross-document sameness is a separate link (`knowledge_state.corroborated_by`), not a theme. | Should |

## Knowledge briefing

| ID | Requirement | Priority |
| --- | --- | --- |
| REQ-KNO-001 | Classify supported facts as **known**. | Must |
| REQ-KNO-002 | Classify explicit gaps / unmeasured quantities as **unknown**. Multi-source unknowns remain unknowns (high-priority gaps). | Must |
| REQ-KNO-003 | Classify concrete gap-closing actions as **opportunity**. | Must |
| REQ-KNO-004 | Dashboard presents three panes: known / unknown / opportunities, plus theme coverage. | Must |

## Evals and hill-climb

| ID | Requirement | Priority |
| --- | --- | --- |
| REQ-EVA-001 | Maintain a gold insight set keyed to source documents. | Must |
| REQ-EVA-002 | Critique detects **partial** insights. | Must |
| REQ-EVA-003 | Critique detects **wrong** (ungrounded / inverted) insights. | Must |
| REQ-EVA-004 | Critique detects **missed** gold insights. | Must |
| REQ-EVA-005 | Critique detects grounded **new** insights absent from gold. | Must |
| REQ-EVA-006 | Critique model produces structured findings. | Must |
| REQ-EVA-007 | Judge model scores metrics and decides promote / hold / regress. | Must |
| REQ-EVA-008 | Proposer (improver) recommends the next prompt/strategy patch. | Must |
| REQ-EVA-009 | Hill-climb promotes a champion extractor when composite improves. | Must |
| REQ-EVA-010 | Safety gate: wrong-rate must not rise more than 0.05 vs champion; recall on must-find gold must not drop. | Must |

## Regression and process

| ID | Requirement | Priority |
| --- | --- | --- |
| REQ-REG-001 | Unit tests name the requirement ID they lock. | Must |
| REQ-REG-002 | End-to-end regression covers briefing, theme linkage, and eval lab. | Must |
| REQ-REG-003 | CI runs unit + e2e on Origin. | Should |
| REQ-OPS-001 | Cloud Agent may run eval sweeps and propose prompt patches as PRs. | Should |
| REQ-OPS-002 | Grokbot / Bugbot reviews PRs for eval regressions and missing REQ mapping. | Should |
| REQ-OPS-003 | SDLC docs (this set) are the system of record for architecture and TDD. | Must |

## Assumptions I proceeded with

These are the questions I would have asked; v1 answers are in brackets.

1. LLM vendor? **[Optional OpenAI / xAI / Anthropic; local extractor is the default so the product runs without keys.]**
2. LlamaCloud already contracted? **[Optional; local PPTX/DOCX/XLSX parsers are first-class.]**
3. May documents leave the VPC? **[Local parse never uploads. LlamaParse only if a key is present.]**
4. Multi-asset workspaces? **[Single demo asset: Velmara. Catalog is per-asset ready.]**
5. Human accept workflow? **[CIR `status` exists; v1 auto-accepts extracted rows.]**
6. Veeva / SharePoint connectors? **[Upload-only in v1.]**
7. Languages? **[English.]**
8. Gold currently in a spreadsheet? **[JSON gold set in-repo; JSONL-ready CIR.]**
