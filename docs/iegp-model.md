# IEGP data model — locked decisions

This is the system of record for the Digital Integrated Evidence Generation Plan product. Synapse principles still apply: atomic records, joins instead of copies, residuals that do not mash or overwrite, human accept at every gate, evals against gold.

Demo asset: fictional **Velmara / velmaratinib**, 2L EGFR-mutant NSCLC, US + EU5 as a field (one asset, one indication, one global plan).

## Objects

| Object | Role |
| --- | --- |
| Strategic objective | Decision the organisation must make, with date and importance. |
| Source | Interview, TLR, CDP, HEOR/RWE/medical internal material. |
| Evidence need | Atomic sourced statement. Starts as **candidate**. Never auto-promoted to a gap. |
| Evidence gap | Named decision object. Many needs join onto one gap (`need_gap_links`). Ingest writes live gaps (not a candidate accept/reject inbox). |
| Tactic | Structured generating or disseminating activity. Extracted tactics land as accepted inventory. Status completed / ongoing / planned / proposed / cancelled. |
| Gap–tactic coverage | Many-to-many. Ten dimensions + overall Full / Partial / Limited / Not relevant. Ingest auto-joins scored mappings onto the Gaps workbench. |
| Gap version | Snapshot of a retired original after split or rewrite. Children find the original from `gap_versions`. |
| Priority | Locked band on the Open gap's residual. Coverage ≠ priority. |
| Roadmap item | Ongoing + planned + proposed tactics only. Completed stay on the dossier. |

## Gates (human lock)

Actor is a typed **name + function**. No login. `user_id` is not required in v1.

1. Ingest extracts gaps and tactics already mapped, with engine-computed status (no accept/reject inbox)
2. Human **validate** of each live Open or Addressed gap on Gaps
3. **Partial** cannot stay: **split** (LEFT Addressed + chosen mapped tactics, RIGHT Open leftover) or **rewrite** original as Open or Addressed. Original is retired into version history.
4. Click override of Open or Addressed with a required reason (Partial is not a dropdown lock)
5. Each of 10 coverage dimensions (Change dimension — records the actor and flags other live gaps mapped to the same tactic)
6. Overall coverage degree (Change overall coverage — same sibling-review flag; values are not copied across gaps)
7. Priority band (**human only** — the engine does not suggest or assign a band)
8. Create or assign a **proposed** tactic on the Tactics stage (after Prioritize). Gaps does not invent studies.
9. Add Open gap or Addressed gap (Addressed needs an accompanying library tactic **or** a recorded missed real tactic)

There is **no residual paragraph** copied onto the parent gap card, and **no Review / Mappings wizard steps**. After ingest, **Gaps** is the combined mapped + status workbench.

The engine drafts a leftover statement when pressure-testing says a parent is **Partially Addressed**. Clicking Partial suggests a split: the covered slice becomes Addressed with the mapped tactics the user keeps; leftover tactics are optional on the Open child. Constituent `need_gap_links` copy onto both children. The original is rewritten/deleted but kept in gap version history. Alternatively the user rewrites the original as Open or Addressed (Addressed requires ≥1 tactic).

**Add open gap** and **Add addressed gap** are visible on Gaps. Creating a gap is `validated_open` (**Open**). Creating an Addressed gap requires an accompanying tactic (existing library tactic or a recorded missed real study — not `proposed`). Gap cards **Map existing tactic** (assign/mapping APIs) or **Record missed tactic** (completed / ongoing / planned, then auto-map). Do not invent new studies on Gaps — that happens on Tactics after Prioritize. Split uses parent mapped tactics only; no create in the split dialog.

Ingest applies a deterministic scored mapping engine (statement/question similarity, domain–type affinity, shared population/comparator/outcome cues, and a penalty when the tactic is dissemination-only). Mapping is inventory join, not tactic ideation — not an LLM and not embedding-clusters.

## Gap status after mapping

Enums stay `validated_open` / `validated_partial` / `validated_addressed`. Human-facing labels:

| Label | Enum | Definition |
| --- | --- | --- |
| **Open** | `validated_open` | Complete white space: no completed, ongoing, or **planned** tactics AND no published literature addressing this gap. Proposed tactics do **not** count as addressing. |
| **Partially Addressed** | `validated_partial` | Some evidence, through completed or ongoing or planned tactics and/or published literature, that supports but does not fully close this gap. The remainder is a **residual evidence need**. This status **cannot stay**: split into Addressed (with chosen tactics) and Open leftover, or rewrite the original. |
| **Addressed** | `validated_addressed` | Evidence from published literature and/or completed, ongoing, or planned tactics is sufficient to fully close this gap. |

On **Gaps**, the engine computes Open / Partially Addressed / Addressed from joined tactics + publications. Click Open or Addressed to override; a non-empty reason is required. Cancel does not save. Click Partial to split or rewrite — Partial is not a lasting lock.

Override of Open/Addressed wins until cleared or marked stale on ingest/coverage refresh. Stale overrides show disagreement with the new computed status; they are not silent-clobbered. Unlocked / limited-only assignment must not pretend a gap is Addressed (that is Partially Addressed until coverage is locked Full).

Changing a dimension or overall on gap A for tactic T flags other **live** gaps mapped to T as **needs review**. Sibling yes/partial/no/overall values are not copied. Sibling status is not auto-flipped; the user opens the flagged gap, confirms or edits, the flag clears, then status recomputes. If that review leaves the sibling Partial, it sorts to the top of Gaps (Partial cannot stay). Tactic status change and ingest keep today’s broader **stale** behaviour.

**Counting rules:** completed + ongoing + planned tactics count. **Proposed** does not. Publications are tactics; they count as published literature when status is **completed**, or when the type is a publication tactic (`publication`, `congress_abstract`, `evidence_dissemination`) with `evidence_available` set.

## Priority (human lock)

Priority is a human lock of High / Medium / Low (Critical folds into High on the plan). The engine does not assign a band. Effort and cost live on the tactic, not on the need. Priority ≠ roadmap inclusion.

## Refresh (living plan)

Tactic status change or new ingest marks related coverage **outdated** (review the dimensions; they are not automatically trusted until a human reviews them) and unlocks residuals so a human can reassess. Nothing auto-closes. Distinct from **needs review**, which flags a sibling gap after a dimension change on the same tactic.

## Evals

Gold: candidate needs from seed sources, and gap–tactic overall coverage. The engine **computes** Open / Partially Addressed / Addressed; humans validate before Prioritize.

## Surfaces

`/` is a left sidebar: **Upload**, **Gaps**, **Prioritize**, **Tactics**. First visit is Upload. Gaps unlocks after ingest. Prioritize unlocks when every live gap is validated and none remain Partially Addressed. Tactics unlocks after Prioritize.

1. **Ingest** extracts gaps and tactics, applies scored mappings, computes status. No accept/reject inbox.
2. **Gaps** shows every live gap as a card (title, statement, mapped tactics with a dimensions dropdown, **View constituent needs**). Humans validate Open and Addressed. **Map existing tactic** or **Record missed tactic** (catch-up, never `proposed`). Partial must **split** (Addressed + chosen mapped tactics on the left, Open leftover on the right) or **rewrite** the original as Open or Addressed (original retired into version history).
3. **Prioritize** High / Medium / Low on Open gaps.
4. **Tactics** ideate proposed tactics for Open gaps after Prioritize.

| Place | What |
| --- | --- |
| Upload | Demo pack + ingest. |
| Gaps | Mapped inventory, engine status, validate, split/rewrite, map existing or record missed, add Open or Addressed (Addressed needs a tactic). |
| Prioritize | Priority bands for Open gaps. Addressed bucket. |
| Tactics | Ideate/assign proposed tactics for Open gaps. |

Eval and Spec stay as secondary sidebar items.

Gap titles are evidence-topic noun phrases (not “We need…”).

## Parked — Plan vision (not in this pass)

The Plan surface should grow into a visual of gaps and tactics with **gates** (dependencies: tactic B blocked until tactic A completes) and a **timeline as a Gantt chart**. Sidebar IA is shaped so Plan can absorb that later. No Gantt and no dependency graph in the current UI.

## v1 non-goals

- AI tactic ideation (extraction of existing studies from sources is inventory, not ideation)
- Auth / RBAC
- Multi-asset, multi-indication, country overlay plans
- Named annual snapshots (audit log is history)
- Embedding clusters as the catalog
