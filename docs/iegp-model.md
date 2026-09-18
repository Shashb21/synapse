# IEGP data model — locked decisions

This is the system of record for the Digital Integrated Evidence Generation Plan product. Synapse principles still apply: atomic records, joins instead of copies, residuals that do not mash or overwrite, human accept at every gate, evals against gold.

Demo asset: fictional **Velmara / velmaratinib**, 2L EGFR-mutant NSCLC, US + EU5 as a field (one asset, one indication, one global plan).

## Objects

| Object | Role |
| --- | --- |
| Strategic objective | Decision the organisation must make, with date and importance. |
| Source | Interview, TLR, CDP, HEOR/RWE/medical internal material. |
| Evidence need | Atomic sourced statement. Starts as **candidate**. Never auto-promoted to a gap. |
| Evidence gap | Named decision object. Many needs join onto one gap (`need_gap_links`). |
| Tactic | Structured generating or disseminating activity. Extracted tactics start as **candidate** and use the same accept / reject / modify gate as gaps. Status completed / ongoing / planned / proposed / cancelled. |
| Gap–tactic coverage | Many-to-many. Ten dimensions + overall Full / Partial / Limited / Not relevant. Suggested mappings rank accepted gaps against accepted tactics; a human accept writes this join. Reject persists so that pair is not suggested again. |
| Residual evidence need | Engine drafts leftover after a pressure-test (inferred partial, or human-locked partial/limited). Shown in Review. Accept creates a child gap (`parent_gap_id`). Parent is preserved. |
| Priority | Locked band on the residual. Coverage ≠ priority. |
| Roadmap item | Ongoing + planned + proposed tactics only. Completed stay on the dossier. |

## Gates (human lock)

Actor is a typed **name + function**. No login. `user_id` is not required in v1.

1. Candidate need accept / reject (optional gap join on accept)
2. Extracted gap accept / reject / **modify**
2b. Extracted tactic accept / reject / **modify** (same gate; assignment only after accept)
3. Gap status (Candidate / **Open** / **Partially Addressed** / **Addressed** / Excluded)
4. Each of 10 coverage dimensions
5. Overall coverage degree
6. Residual leftover (engine drafts from pressure-test or locked partial/limited; human accepts it **as a new gap**, rejects, or modifies in Review)
7. Priority band (**human only** — the engine does not suggest or assign a band)
8. Create or assign a tactic (Create tactic adds to the library as accepted; extracted tactics are inventory, not ideation)
8b. Suggested mapping accept / reject (a scored mapping engine drafts the join; accept is the same coverage write as Assign; reject suppresses the pair)
8c. Create a gap (human-authored; starts as validated open)
9. Roadmap row

There is **no residual paragraph** copied onto the parent gap card. After ingest, Review is **one validation step** with inner tabs:

- **Gaps** — candidate/extracted gaps (accept / reject / modify), residual evidence needs (leftover gaps), **Create gap**. Counts on the tab label.
- **Tactics** — candidate/extracted tactics (accept / reject / modify), **Create tactic**. Counts on the tab label.

The engine drafts a residual when pressure-testing (deterministic mapping/coverage vs extracted tactics) says the parent is already **partial**, or when a human classifies a mapped gap as **Partially Addressed**. Human accepts that leftover **as a new Open gap** (topic-style name, not “We still need…”), rejects it, or modifies the statement. The covered parent is then human-locked **Addressed**. Assigning a tactic is not enough if coverage is still the unlocked placeholder `limited`. Full coverage and `not_relevant` do not enqueue a leftover. Reject persists so that parent is not suggested again.

**Create gap** and **Create tactic** are visible on Review (on their inner tabs) and Library. Creating a tactic adds it to the library as accepted. Creating a gap is `validated_open` (**Open**).

Suggested mappings are drafted by a deterministic scored engine (statement/question similarity, domain–type affinity, shared population/comparator/outcome cues, and a penalty when the tactic is dissemination-only). The engine never writes coverage; a human accept or reject is the gate. Mapping is inventory join, not tactic ideation — not an LLM and not embedding-clusters.

## Gap status after validation / mapping

Enums stay `validated_open` / `validated_partial` / `validated_addressed`. Human-facing labels:

| Label | Enum | Definition |
| --- | --- | --- |
| **Open** | `validated_open` | Complete white space: no completed, ongoing, or **planned** tactics AND no published literature addressing this gap. Proposed tactics do **not** count as addressing. |
| **Partially Addressed** | `validated_partial` | Some evidence, through completed or ongoing or planned tactics and/or published literature, that supports but does not fully close this gap. The remainder is a **residual evidence need**. This can be added as a **new gap**, and the addressed part becomes an **Addressed** gap — **the gap splits**. |
| **Addressed** | `validated_addressed` | Evidence from published literature and/or completed, ongoing, or planned tactics is sufficient to fully close this gap. |

On **Mappings**, the engine computes Open / Partially Addressed / Addressed from joined tactics + publications. Click a gap to override; a non-empty reason is required. Cancel does not save. Partially Addressed presents the residual draft and split action. Addressed has no residual.

Override wins until cleared or marked stale on ingest/coverage refresh. Stale overrides show disagreement with the new computed status; they are not silent-clobbered. Unlocked / limited-only assignment must not pretend a gap is Addressed (that is Partially Addressed until coverage is locked Full).

**Counting rules:** completed + ongoing + planned tactics count. **Proposed** does not. Publications are tactics; they count as published literature when status is **completed**, or when the type is a publication tactic (`publication`, `congress_abstract`, `evidence_dissemination`) with `evidence_available` set.

## Priority (human lock)

Priority is a human lock of High / Medium / Low (Critical folds into High on the plan). The engine does not assign a band. Effort and cost live on the tactic, not on the need. Priority ≠ roadmap inclusion.

## Refresh (living plan)

Tactic status change or new ingest marks related coverage **stale** and unlocks residuals for re-lock. Nothing auto-closes.

## Evals

Gold: candidate needs from seed sources, and gap–tactic overall coverage. The engine **computes** Open / Partially Addressed / Addressed; humans validate before Prioritize.

## Surfaces

`/` is a left sidebar: **Upload**, **Gaps**, **Prioritize**, **Tactics**. First visit is Upload. Gaps unlocks after ingest. Prioritize unlocks when every live gap is validated and none remain Partially Addressed. Tactics unlocks after Prioritize.

1. **Ingest** extracts gaps and tactics, applies scored mappings, computes status. No accept/reject inbox.
2. **Gaps** shows every live gap with mapped tactics and computed status. Humans validate Open and Addressed. Partial must **split** (Addressed + tactic on the left, Open leftover on the right) or **rewrite** the original as Open or Addressed (original retired into version history).
3. **Prioritize** High / Medium / Low on Open gaps.
4. **Tactics** create and assign tactics for Open gaps.

| Place | What |
| --- | --- |
| Upload | Demo pack + ingest. |
| Gaps | Mapped inventory, engine status, validate, split/rewrite, add Open or Addressed (Addressed needs a tactic). |
| Prioritize | Priority bands for Open gaps. Addressed bucket. |
| Tactics | Create/assign tactics for Open gaps. |

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
