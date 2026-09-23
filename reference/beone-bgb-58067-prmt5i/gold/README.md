# Gold — BGB-58067 IEP (this source only)

Eval gold for **`BeOne_BGB-58067 PRMT5i IEP Report_v1.0 Final_vMarkup.pptx`** only. Do not merge with `beone-tislelizumab-iegp`.

- **`gaps.json`**: `must_find_gap_ids` lists all **43** `NSCLC_*_*` IDs detected in the deck. Populate `gaps[]` with `{ id, statement, priority, slide_cue }` from prioritized gap slides (≈19–28).
- **`tactics.json`**: Numbered tactics **1–36** from tactic detail slides (≈30–45). Populate `tactics[]` with `{ number, title, lead_function, gap_ids[] }`.

Coverage gold (pairwise overall) will live in `coverage.json` once gap/tactic rows are filled.
