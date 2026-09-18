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
3. Gap status (Candidate / Open / Partial / Addressed / Excluded)
4. Each of 10 coverage dimensions
5. Overall coverage degree
6. Residual leftover (engine drafts from pressure-test or locked partial/limited; human accepts it **as a new gap**, rejects, or modifies in Review)
7. Priority band (**human only** — the engine does not suggest or assign a band)
8. Create or assign a tactic (Create tactic adds to the library as accepted; extracted tactics are inventory, not ideation)
8b. Suggested mapping accept / reject (a scored mapping engine drafts the join; accept is the same coverage write as Assign; reject suppresses the pair)
8c. Create a gap (human-authored; starts as validated open)
9. Roadmap row

There is **no residual paragraph** copied onto the parent gap card. After ingest, Review is **one validation step**: extracted gaps, extracted tactics, and residual evidence needs. The engine drafts a residual when pressure-testing (deterministic mapping/coverage vs extracted tactics) says the parent is already **partial**. Human accepts that leftover **as a new gap**, rejects it, or modifies the statement. Assigning a tactic is not enough if coverage is still the unlocked placeholder `limited`. Full coverage and `not_relevant` do not enqueue a leftover. Reject persists so that parent is not suggested again.

**Create gap** and **Create tactic** are visible on Review and Library. Creating a tactic adds it to the library as accepted. Creating a gap is `validated_open`.

Suggested mappings are drafted by a deterministic scored engine (statement/question similarity, domain–type affinity, shared population/comparator/outcome cues, and a penalty when the tactic is dissemination-only). The engine never writes coverage; a human accept or reject is the gate. Mapping is inventory join, not tactic ideation — not an LLM and not embedding-clusters.

Addressed may be locked only if coverage supports Full, **or** the actor supplies an override note. The engine never writes Addressed.

## Priority (human lock)

Priority is a human lock of High / Medium / Low (Critical folds into High on the plan). The engine does not assign a band. Effort and cost live on the tactic, not on the need. Priority ≠ roadmap inclusion.

## Refresh (living plan)

Tactic status change or new ingest marks related coverage **stale** and unlocks residuals for re-lock. Nothing auto-closes.

## Evals

Gold: candidate needs from seed sources, and gap–tactic overall coverage. Safety: zero unlocked Addressed rows; `engineMaySetStatus("validated_addressed")` is false.

## Surfaces

`/` is a Cursor-like **left sidebar** of places: **Upload**, **Review**, **Mappings**, **Library**, **Plan**. Desktop rail + mobile drawer. The main pane shows one place. First visit starts on Upload; Review / Mappings / Library unlock after at least one source; Plan unlocks after a source plus at least one accept (or after **Enter the plan**). After wizard complete, `/` opens on Plan. New ingest stays on Upload and drops candidates into Review.

Two-step loop is compressed into Review:

1. **Ingest → extract gaps and tactics**.
2. **Review is one validation step**: accept / reject / modify extracted gaps, extracted tactics, and residual evidence needs. Engine drafts a residual when pressure-testing says the parent is already **partial**. Accept residual creates a child gap (`parent_gap_id`); parent stays. Reject persists. **Create gap** and **Create tactic** are visible on Review and Library.

| Place | What |
| --- | --- |
| Upload | Demo pack + ingest. Later sources never restart a stepper. |
| Review | Candidate gaps, tactics, and residual evidence needs; accept / reject / modify; **Create gap** and **Create tactic**. Residual is its own row (leftover question), not a copy of the parent sentence. |
| Mappings | Suggested mappings (scored engine) plus assign from the library onto accepted gaps. |
| Library | Accepted and created tactics. **Create gap** and **Create tactic** live here too. |
| Plan | Prioritize, then High / Medium / Low and Addressed. |

Eval and Spec stay as secondary sidebar items. Sidebar shows counts for inbox candidates (gaps, tactics, residuals) and mapping suggestions.

Gap cards show the gap **once** as a sentence. They do not echo the statement as Residual / needs / body.

## Parked — Plan vision (not in this pass)

The Plan surface should grow into a visual of gaps and tactics with **gates** (dependencies: tactic B blocked until tactic A completes) and a **timeline as a Gantt chart**. Sidebar IA is shaped so Plan can absorb that later. No Gantt and no dependency graph in the current UI.

## v1 non-goals

- AI tactic ideation (extraction of existing studies from sources is inventory, not ideation)
- Auth / RBAC
- Multi-asset, multi-indication, country overlay plans
- Named annual snapshots (audit log is history)
- Embedding clusters as the catalog
