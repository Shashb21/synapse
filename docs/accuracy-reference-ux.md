# Reference deck analysis — BeOne IEGP → digital Synapse

**Sources (in repo):** see [`reference/manifest.json`](../reference/manifest.json).

| Pack | File | Slides | Gap ID style | Tactic ID style |
| --- | --- | --- | --- | --- |
| `beone-bgb-58067-prmt5i` | BGB-58067 PRMT5i IEP Report v1.0 | 57 | `NSCLC_{AD\|CE\|GA\|HI}_{nn}` (43 IDs) | Numbered tactics 1–36 + CDP/pivotal |
| `beone-tislelizumab-iegp` | Tislelizumab IEGP VShare 3.0 | 59+ | Narrative “Need for …” by chapter | `G:{n}` + RN- trial post-hocs |

**Decision:** Coverage and extraction use **schema-locked OAuth LLMs only** — **no TypeSafe Jev**.

One **Synapse workspace = one IEGP** (one pack per workspace for eval; do not mix gold across the two BeOne decks).

---

## Final plan semantics (from BeOne deck behavior)

Reference IEGPs distinguish three tactic sources:

| Source | Where it comes from | In Synapse |
| --- | --- | --- |
| **Inventory** | CDP, pivotal/post-hoc, publication/HEOR trackers, planned RWE/IIT already in materials | `inventory_extract` → validated tactics with provenance quotes |
| **Coverage-only** | Existing tactic addresses gap (no new work) | Pairwise coverage joins; gap may become Addressed without ideation |
| **Ideated** | **Created** for the plan — typically **not** verbatim in reference uploads | `ideate` → `origin: ideated`, `status: proposed` until human validates |

**Only high-priority evidence gaps** receive **newly ideated and assigned** tactics in the **save-final** IEGP. Medium/low open gaps may remain without net-new tactics.

Eval gold: do **not** require ideated tactic wording in source PPTX recall tests; score ideation against high-priority gap assignments separately. Code: `src/accuracy/domain/iegp-semantics.ts`.

---

## What the decks do well (keep semantically)

1. **Executive → context → gaps → tactics → roadmap** — clear mental model; map to app nav, not slide order.
2. **Stable gap IDs (BGB)** — ideal for ledger keys and eval `must_find`.
3. **Tactic rows with lead function, gaps addressed, timing grid** — maps to claim store + Gantt projection.
4. **Status language (Tisle)** — At-Close / Near-Close / open needs → maps to Open / Partial / Addressed after coverage rules.
5. **Implementation roadmap slides** — source material for **interactive Gantt** (H1/H2 years, dependencies disclaimer).

---

## Slide patterns that break in a digital tool

| Deck pattern | Problem | Digital replacement |
| --- | --- | --- |
| **Multi-chapter PDF-in-PPT** (Tisle: Transversal → ESCC → …) | Users lose context scrolling 59 slides | **Chapter tabs** + filtered ledger; one workspace still one IEGP |
| **Wide tables** (Gap ID \| Evidence Gap \| Rationale \| Tactics) | Unreadable on laptop; feels like Excel | **Gap card** + expand for rationale; tactics as linked chips |
| **Duplicate roadmap** (roadmap summary + per-tactic timing rows) | Drift between copies | **Single Gantt projection** from validated tactics only |
| **Priority matrix as static 2×2** (Quick wins vs long term) | Not configurable | **Configurable axes** matrix (locked product decision) with draggable cards |
| **Markup / disclaimer slides** | Noise for extraction | Parse as `doc_role=meta`; exclude from gap extract or down-rank |
| **Abbreviation walls** | LLM drops acronyms | Parse store keeps abbrev slide as glossary block; inject into extract prompts |

---

## Recommended product surfaces (from these two decks)

### 1. Final truth: interactive Gantt

Both decks end in **year/quarter bars** tied to tactics and milestones (2026–2033 BGB; H2 2025–2029+ Tisle).

- Bars **must** bind to `tactic_id` (or milestone entity derived from CDP/pivotal only).
- Show **gap IDs** on click, not on every bar label (density).
- Import roadmap **only** after human validation — deck is reference, not auto-truth.

### 2. Gap ledger

- **BGB:** Card title = `NSCLC_CE_01` + short statement; SI theme as tag (Differentiation, Biomarkers, …).
- **Tisle:** Card title = first line of need; chapter + indication scope as tags; optional `G:n` link only on tactic side.

### 3. Tactic library

- **BGB:** Tactic number + lead (Medical / HEOR) + addressed gap list.
- **Tisle:** `G:{n}` + type (RWE, IIT, post-hoc, ITC) + markets.

### 4. Coverage / status

- Deck “Addressed / Planned / Gated” columns → **computed** Open/Partial/Addressed from joins, not copied from slide color.
- Partial gaps → **split workflow** (deck rarely shows residual explicitly; product must).

### 5. Completeness audit

- BGB: every `NSCLC_*` in slide table must appear in extract inventory.
- Tisle: every high-priority row in chapter prioritization slides + every `G:{n}` in tactic tables.

---

## Parsing notes (LlamaParse for these PPTXs)

- Heavy **tables and timeline graphics** — use LlamaParse agentic tier; preserve table rows as separate blocks.
- **Slide masters / icons** — expect empty blocks; completeness audit should use text + table blocks only.
- Two decks share **BeOne** branding but **must not** share eval gold (different assets, ID schemes).

---

## Gold eval strategy (per source)

| Pack | Recall target | Precision target |
| --- | --- | --- |
| BGB | 43 gap IDs + 36 tactic numbers | No Tisle `G:` IDs |
| Tisle | Chapter-scoped gap statements + 21 `G:` tactics | No BGB `NSCLC_*` IDs |

Scaffold JSON under each pack’s `gold/` — populate statements from parse blocks next.

---

## UX copy / IA tweaks specific to BeOne

- Label **IEP vs IEGP** consistently in UI (BGB says IEP, Tisle says IEGP) — workspace metadata `plan_label`.
- Surface **SI / strategic imperatives** as filter dimensions on BGB gaps.
- Surface **indication chapter** (ESCC, GC/GEJ, Lung) on Tisle gaps.
- **Medical Affairs** primary: lead function badges on tactics match deck “Lead: Medical / HEOR”.

---

## Related

- Build plan: [`accuracy-first-build.md`](./accuracy-first-build.md)
- UX spec (Project store): accuracy-v2-ux-spec.md
- Architecture: Project store `accuracy-first-architecture.md`
- Workshop v1: `/accuracy/workshop` (facilitator-tag boards + rationale-gated actions)

*Analysis generated after reference upload — Sep 23, 2026.*
