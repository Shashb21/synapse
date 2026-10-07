# IEGP data model — locked decisions

This is the system of record for the Digital Integrated Evidence Generation Plan product. Synapse principles still apply: atomic records, joins instead of copies, residuals that do not mash or overwrite, human accept at every gate, evals against gold. Models propose; a person decides.

Demo asset: fictional **Velmara / velmaratinib**, 2L EGFR-mutant NSCLC, US + EU5 as a field (one asset, one indication, one global plan).

## Objects

| Object | Role |
| --- | --- |
| Strategic objective | Decision the organisation must make, with date and importance. |
| Source | Interview, TLR, CDP, HEOR/RWE/medical internal material. |
| Evidence need | Atomic sourced statement. Starts as **candidate**. Never auto-promoted to a gap. |
| Evidence gap | Named decision object. Many needs join onto one gap (`need_gap_links`). Every live gap has at least one constituent need — the source it was identified from. If the same gap is raised in several documents or interviews, each source joins as its own need (primary or supporting). Ingest writes live gaps (not a candidate accept/reject inbox). |
| Tactic | Structured generating or disseminating activity. Extracted tactics land as accepted inventory. Status completed / ongoing / planned / proposed / cancelled. |
| Gap–tactic coverage | Many-to-many. Ten dimensions + overall Full / Partial / Limited / Not relevant. Ingest joins the S4 model's coverage verdicts onto the Evidence Inventory (Gaps) workbench. |
| Gap version | Snapshot of a retired original after split or rewrite. Children find the original from `gap_versions`. |
| Priority | Band on the Open gap's residual, placed on a two-axis matrix and validated by a human. Coverage ≠ priority. |
| Roadmap item | Ongoing + planned + proposed tactics only. Completed stay on the dossier. |

## Gates (human lock)

Actor is the **signed-in person** (name + function from the session). Customers sign in with SSO and need a seat the owner assigned; staff use email and password accounts (`src/modules/auth/`). There is no self sign-up. The API takes the actor from the session, never from the request body, and every edit, lock and audit row records it. Roles (Medical Affairs, contributing function, platform operator, viewer) decide who may validate, prioritize, ideate and save the IEGP as final.

1. Ingest runs the stage chain S0 upload → S1 parse → S2 gap extraction → S3 tactic extraction → S4 mapping; S1–S4 are LLM stages. It writes gaps and tactics already mapped, with engine-computed status (no accept/reject inbox). With the admin's AI sections off, nothing is ingested: gaps and tactics are added by hand
2. Human **validate** of each live Open or Addressed gap on Gaps
3. **Partial** cannot stay: **split** (LEFT Addressed + chosen mapped tactics, RIGHT Open leftover) or **rewrite** original as Open or Addressed. Original is retired into version history.
4. Click override of Open or Addressed with a required reason (Partial is not a dropdown lock)
5. Each of 10 coverage dimensions (Change dimension — records the actor and flags other live gaps mapped to the same tactic)
6. Overall coverage degree (Change overall coverage — same sibling-review flag; values are not copied across gaps)
7. Priority band (**human validates**): with AI on, S8 has a model score each Open gap on the matrix axes and the suggested band is the quadrant it lands in; a person moves it, sets it or validates it. A human band survives every re-run
8. Create or assign a **proposed** tactic on Tactic Ideation (after Prioritize). For gaps validated **High**, S9 proposes candidate tactic designs that a person accepts or rejects with a reason. Gaps does not invent studies.
9. Add Open gap or Addressed gap (Addressed needs an accompanying library tactic **or** a recorded missed real tactic)

There is **no residual paragraph** copied onto the parent gap card, and **no Review / Mappings wizard steps**. After ingest, **Gaps** is the combined mapped + status workbench.

When a parent is **Partially Addressed**, clicking Partial opens a split. With AI on, S6 has a model propose the addressed slice and the open leftover (checked by a model critic and judge); otherwise the person writes it. Nothing applies until the person validates it: the covered slice becomes Addressed with the mapped tactics the user keeps; leftover tactics are optional on the Open child. Constituent `need_gap_links` copy onto both children. The original is rewritten/deleted but kept in gap version history. Alternatively the user rewrites the original as Open or Addressed (Addressed requires ≥1 tactic).

**Add open gap** and **Add addressed gap** are visible on Gaps. Creating a gap is `validated_open` (**Open**). Creating an Addressed gap requires an accompanying tactic (existing library tactic or a recorded missed real study — not `proposed`). Gap cards **Map existing tactic** (assign/mapping APIs) or **Record missed tactic** (completed / ongoing / planned, then auto-map). Do not invent new studies on Gaps — that happens on Tactics after Prioritize. Split uses parent mapped tactics only; no create in the split dialog.

Mapping is S4: a model proposes one row per gap with a coverage verdict (Full / Partial / Limited / Not relevant, plus the ten dimensions), a confidence and a rationale for each tactic it judges relevant; a model critic challenges each row over three exchanges and a model judge accepts or rejects it. Pairs a person rejected or removed are never proposed again, and an existing pair is never rewritten. There is no rule-based fallback: with no model, mapping fails with a clear error and the person maps by hand. Mapping is an inventory join, not tactic ideation, and not embedding clusters.

## Gap status after mapping

Enums stay `validated_open` / `validated_partial` / `validated_addressed`. Human-facing labels:

| Label | Enum | Definition |
| --- | --- | --- |
| **Open** | `validated_open` | Complete white space: no completed, ongoing, or **planned** tactics AND no published literature addressing this gap. Proposed tactics do **not** count as addressing. |
| **Partially Addressed** | `validated_partial` | Some evidence, through completed or ongoing or planned tactics and/or published literature, that supports but does not fully close this gap. The remainder is a **residual evidence need**. This status **cannot stay**: split into Addressed (with chosen tactics) and Open leftover, or rewrite the original. |
| **Addressed** | `validated_addressed` | Evidence from published literature and/or completed, ongoing, or planned tactics is sufficient to fully close this gap. |

On **Gaps**, the engine computes Open / Partially Addressed / Addressed from joined tactics + publications. Click Open or Addressed to override; a non-empty reason is required. Cancel does not save. Click Partial to split or rewrite — Partial is not a lasting lock.

Override of Open/Addressed wins until cleared or marked stale on ingest/coverage refresh. Stale overrides show disagreement with the new computed status; they are not silent-clobbered. Unlocked / limited-only assignment must not pretend a gap is Addressed (that is Partially Addressed until coverage is locked Full).

Changing a dimension or overall on gap A for tactic T flags other **live** gaps mapped to T as **needs review**. Sibling yes/partial/no/overall values are not copied. Sibling status is not auto-flipped; the user opens the flagged gap, confirms or edits, the flag clears, then status recomputes. If that review leaves the sibling Partial, it sorts to the top of Gaps (Partial cannot stay).

**Counting rules:** completed + ongoing + planned tactics count. **Proposed** does not. Publications are tactics; they count as published literature when status is **completed**, or when the type is a publication tactic (`publication`, `congress_abstract`, `evidence_dissemination`) with `evidence_available` set.

## Priority (human validated)

Priority is placed on the **Prioritization Matrix**: two configurable axes, and the band is the quadrant (High / Medium / Low / Defer). With AI on, S8 has a model score each Open gap on every axis (a model critic challenges each score); it never picks the band itself, the quadrant does. The band stays a suggestion until a person validates it, and a person can drag a gap, set a band or score an axis by hand at any time; human values survive re-runs. Effort and cost live on the tactic, not on the need. Priority ≠ roadmap inclusion.

## Refresh (living plan)

Tactic status change or new ingest unlocks residuals so a human can reassess. Nothing auto-closes. Coverage rows are not marked outdated. **Needs review** still flags a sibling gap after a dimension change on the same tactic.

## Evals

Gold: the curated Velmara pack (`src/modules/eval-gold/velmara-curated.ts`) for the stage evals, and the reference packs under `reference/*/gold` scored by recall (`src/accuracy/eval/pack-recall.ts`) in the accuracy lab. The engine **computes** Open / Partially Addressed / Addressed; humans validate before Prioritize. See [`sdlc/13-testing.md`](sdlc/13-testing.md).

## Surfaces

`/` is a left sidebar: **Plan context**, **Upload** (AI on only), **Evidence Inventory** (Gaps), **Prioritization Matrix**, **Tactic Ideation**, **Gantt Timeline**. With AI on, the first visit is Upload; with AI off the plan starts on Evidence Inventory, where gaps and tactics are added by hand. Evidence Inventory unlocks after ingest (or a gap added by hand). The matrix unlocks when every live gap is validated and none remain Partially Addressed. Tactic Ideation unlocks when every Open gap's priority is validated.

1. **Ingest** runs S0–S4: extracts gaps and tactics, maps them, computes status. No accept/reject inbox.
2. **Evidence Inventory** shows every live gap as a card (id, title, status, mapped tactics). **View constituent needs** lists every source the gap was identified from — including when several documents or interviews raised the same gap. Humans confirm Open and Addressed. **Map existing tactic** or **Record missed tactic** (catch-up, never `proposed`). Partial must **split** or **rewrite**. Coverage dimensions live on the gap detail page, not the card. Excluded gaps, rejected needs, rejected tactics and rejected mappings can be restored.
3. **Prioritization Matrix** places Open gaps on two axes; a person validates each band.
4. **Tactic Ideation** for gaps validated High: S9 proposals to accept or reject, library tactics, or a custom tactic. Medium and Low gaps get tactics from the library or by hand.
5. **Gantt Timeline** (S10) lays out the plan as dated activities with dependencies; save as final and export as an image.

| Place | What |
| --- | --- |
| Plan context | Asset, objectives, decisions, landscape and people (setup wizard). |
| Upload | Demo pack + ingest (AI on only). |
| Evidence Inventory | Mapped inventory, engine status, validate, split/rewrite, map existing or record missed, add Open or Addressed (Addressed needs a tactic). |
| Prioritization Matrix | Configurable axes, quadrant bands, human validation. |
| Tactic Ideation | Ideate/assign proposed tactics for High-priority Open gaps. |
| Gantt Timeline | Dated activities, dependencies, save as final, PNG export. |

Needs, Residuals and Roadmap stay as secondary sidebar items. Evals, specs and routing live in the owner console (`/admin`), never in the customer app.

Gap titles are evidence-topic noun phrases (not “We need…”).

## Timeline (S10)

The Plan vision of gates and a Gantt is built: `/timeline` lays out the IEGP as dated activities grouped by gap. Dates a person set and durations a tactic's design carries are kept; with AI on, a model infers the dependencies between activities (tactic B waits on tactic A) and estimates any start, duration or readout lag nobody supplied. A person can date, add, remove, re-lane and re-sequence any activity by hand, and those values survive every rebuild. Only a validated band puts an activity in a High, Medium or Low lane; activities of Open gaps with no validated band wait in a "Not yet prioritized" lane. Medical Affairs saves the IEGP as final.

## v1 non-goals

- Multi-asset, multi-indication, country overlay plans
- Named annual snapshots (audit log is history)
- Embedding clusters as the catalog
