# IEGP reference materials

BeOne reference decks live in **`reference/manifest.json`**. Each pack is **one source file** — eval gold must not mix gaps/tactics across packs.

## Layout

```text
reference/
  manifest.json
  beone-bgb-58067-prmt5i/
    sources/   … PRMT5i IEP Report.pptx
    gold/      gaps.json, tactics.json (must_find scaffolds)
  beone-tislelizumab-iegp/
    sources/   … Tislelizumab IEGP VShare 3.0.pptx
    gold/      gaps.json, tactics.json
```

One **Synapse workspace** = one IEGP (one pack when using reference gold).

## Analysis

See [`docs/accuracy-reference-ux.md`](../docs/accuracy-reference-ux.md) for deck → digital UX recommendations and eval rules.

## Parsing (accuracy stack)

| Format | Parser |
| --- | --- |
| PDF, PPTX | LlamaParse (`LLAMA_CLOUD_API_KEY` required; Sources upload is gated without it) |
| DOCX, TXT, XLSX | Local structured parse |

Coverage decisions: **schema-locked OAuth LLMs** — **not** TypeSafe Jev.
