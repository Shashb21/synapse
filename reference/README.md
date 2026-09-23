# IEGP reference materials

Upload **source PPTXs/PDFs/DOCX** and **gold gap/tactic expectations** here for Synapse accuracy-first development.

## Layout (required for eval gold)

Keep **each reference source in its own folder** so gaps and tactics are never mixed across files:

```text
reference/
  README.md
  <asset-slug>/
    sources/
      stakeholder-interviews.pptx
      medical-plan.pdf
      ...
    gold/
      gaps.json          # gaps grounded in THIS source only
      tactics.json       # tactics grounded in THIS source only
      README.md          # how rows map to parse block cues
```

One **Synapse workspace** = one IEGP. Gold packs are keyed by `source_file_id` inside a workspace, not merged across unrelated reference folders until ingest merge rules run.

## Parsing policy (accuracy stack)

| Format | Parser |
| --- | --- |
| PDF, PPTX | LlamaParse (when `LLAMA_CLOUD_API_KEY` is set) |
| DOCX, TXT, XLSX, etc. | Local / structured parsers; optional LLM assist for messy DOCX only inside the parse module |

## Digital UX note

Reference decks are slide-first. The product **final truth view** is an **interactive Gantt** plus card-based gap/tactic/coverage surfaces — not a slide clone. When reference files land here, run the reference analysis doc under `docs/accuracy-reference-ux.md` (generated after first upload).
