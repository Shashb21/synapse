# Catalog evolution — emerge and split

The theme catalog is an **append-only knowledge base**. CIR rows accumulate on ingest. Theme *names* grow only when a human accepts a proposal. The engine never deletes a theme and never invents a label.

## Scoring

Each CIR is scored against the current catalog (keywords, patterns, stakeholder prior). A strong max becomes a named-theme join on `theme_links`. A weak max lands in Unassigned (`THEME-RESIDUAL`). Statements are stored once.

## Emerge (REQ-CLU-007)

1. Extract CIR as usual.
2. Score against the current catalog. Weak max → Unassigned.
3. Cluster Unassigned by statement similarity (lexical, threshold ~0.34 — not k-means, not embeddings).
4. If a cluster has ≥ 2 CIR and cohesion ≥ 0.34, propose a new catalog entry (keywords + suggested name).
5. **Accept** appends the theme, re-runs `assignThemes`, and force-links those CIR onto the new theme (residual primary is replaced). CIR rows are not copied.
6. **Reject** keeps them in Unassigned; the same fingerprint will not be proposed again.

A VP must be able to brief the new name as its own decision. “Miscellaneous launch trivia” is not a theme.

## Split (REQ-CLU-008)

A named theme splits when it is **briefing two decision objects**.

1. For each named theme with ≥ 4 CIR, match members against **parent catalog keywords** (light plurals: `formulary` / `formularies`).
2. Canonicalize aliases so families group: `cns` / `intracranial` / `brain` / `brain-mets` / `n=28`; `discontinuation` / `persistence`.
3. Each member’s hit-set is those aliased keywords, or `{__none__}` if none match.
4. Find the keyword pair `(k1, k2)` maximizing `|exclusive(k1)| × |exclusive(k2)|`, where exclusive(k) = members hitting k and not the other. Both exclusive sets must be ≥ 2.
5. Propose a **child** from the **smaller** exclusive set. If several named themes qualify, only the strongest pair is queued so splits do not fire on every theme.
6. Accepting appends the child (`parent_theme_id` set), re-links, and force-adds a join for those CIR while **keeping the parent**. The parent is never deleted. Statements are not copied.

Example: Evidence gaps may later yield a CNS RWE theme if intracranial package and 6-month discontinuation stop briefing as one situation.

## What does not happen

- Embeddings do not name themes.
- Ingest does not auto-promote.
- A split does not retire the parent.
- CIR rows are never copied onto a theme.
- Gold and evals stay on CIR ids, not theme names.

See `/catalog` in the app.
