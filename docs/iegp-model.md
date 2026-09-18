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
| Residual evidence need | Drafted only after a mapped tactic’s overall coverage is human-locked **partial** or **limited**. Priority is locked on this residual. Full / `not_relevant` / no tactics = no residual. |
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
6. ResidualNeed (engine drafts leftover evidence after locked partial/limited coverage; human locks priority on Plan)
7. Priority band (**human only** — the engine does not suggest or assign a band)
8. Create tactic (**Library only**; adds to the library as accepted) or assign from the library
8b. Suggested mapping accept / reject (a scored mapping engine drafts the join; accept is the same coverage write as Assign; reject suppresses the pair)
8c. Create a gap (human-authored on Review; starts as validated open)
8d. Leftover-as-new-gap accept / reject on **Mappings** (same coverage gate as ResidualNeed; accept creates a child with `parent_gap_id`; parent → validated_partial; reject persists)
9. Roadmap row

There is **no residual** on ingest, gap accept, or create-gap. Assigning a tactic is not enough if coverage is still unknown (unlocked overall, including the placeholder `limited` written at assign). A ResidualNeed is drafted only when mapped coverage is human-locked **partial** or **limited**. Full coverage and `not_relevant` do not draft. Open accepted gaps with no residual wait on Mappings for tactics/coverage — they are not fake leftovers on Prioritize. The same coverage gate can also **suggest leftover as a new gap** on Mappings; that child does not replace ResidualNeed on Plan.

**Create gap** lives on Review. **Create tactic** lives on Library only. Creating a tactic adds it to the library as accepted. Creating a gap is `validated_open`. At gap validation, only **Assign tactic** from the library.

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

Two-step loop:

1. **Ingest → extract gaps and tactics → human validates** those extracted objects (accept / reject / modify). **Create gap** is on Review. **Create tactic** is on Library.
2. **Backend pressure-test** (deterministic mapping + coverage engine, not an LLM). ResidualNeed is drafted only after overall coverage is locked **partial** or **limited**. Leftover may also be suggested as a new gap on Mappings.

| Place | What |
| --- | --- |
| Upload | Demo pack + ingest. Later sources never restart a stepper. |
| Review | Candidate gaps and tactics; accept / reject / modify; **Create gap**; **Assign tactic** from the library. One sentence per gap. No residual. No Create tactic. |
| Mappings | Suggested mappings (scored engine) plus leftover-as-new-gap after locked partial/limited coverage, plus assign from the library onto accepted gaps. |
| Library | Accepted and created tactics. **Create tactic** lives here. |
| Plan | Prioritize ResidualNeeds, then High / Medium / Low and Addressed. |

Eval and Spec stay as secondary sidebar items. Sidebar shows counts for inbox candidates and mapping + leftover suggestions.

Gap cards show the gap **once** as a sentence. They do not echo the statement as Residual / needs / body.

## Parked — Plan vision (not in this pass)

The Plan surface should grow into a visual of gaps and tactics with **gates** (dependencies: tactic B blocked until tactic A completes) and a **timeline as a Gantt chart**. Sidebar IA is shaped so Plan can absorb that later. No Gantt and no dependency graph in the current UI.

## v1 non-goals

- AI tactic ideation (extraction of existing studies from sources is inventory, not ideation)
- Auth / RBAC
- Multi-asset, multi-indication, country overlay plans
- Named annual snapshots (audit log is history)
- Embedding clusters as the catalog
