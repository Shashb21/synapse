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
| Residual evidence need | Child of a gap. Original gap is preserved. |
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
6. Residual statement (engine drafts from uncovered dimensions; human edits and locks)
7. Priority band (**human only** — the engine does not suggest or assign a band)
8. Create or assign a tactic (human-authored proposals; extracted tactics are inventory, not ideation)
8b. Suggested mapping accept / reject (a scored mapping engine drafts the join; accept is the same coverage write as Assign; reject suppresses the pair)
8c. Create a gap (human-authored; starts as validated open with a residual draft)
9. Roadmap row

Addressed may be locked only if coverage supports Full, **or** the actor supplies an override note. The engine never writes Addressed.

Suggested mappings are drafted by a deterministic scored engine (statement/question similarity, domain–type affinity, shared population/comparator/outcome cues, and a penalty when the tactic is dissemination-only). The engine never writes coverage; a human accept or reject is the gate. Mapping is inventory join, not tactic ideation — not an LLM and not embedding-clusters.

## Priority (human lock)

Priority is a human lock of High / Medium / Low (Critical folds into High on the plan). The engine does not assign a band. Effort and cost live on the tactic, not on the need. Priority ≠ roadmap inclusion.

## Refresh (living plan)

Tactic status change or new ingest marks related coverage **stale** and unlocks residuals for re-lock. Nothing auto-closes.

## Evals

Gold: candidate needs from seed sources, and gap–tactic overall coverage. Safety: zero unlocked Addressed rows; `engineMaySetStatus("validated_addressed")` is false.

## Surfaces

The home screen (`/`) is a **wizard once, then the living plan**. First visit is a stepper: upload → review gaps and tactics → prioritize. After **Enter the plan**, you only live on `/`. New ingest drops candidate gaps and tactics into the **inbox** on that same page. The loop is:

1. Upload or ingest a demo source. The engine extracts **candidate gaps** and **candidate tactics**, and drafts **residual evidence needs**.
2. Review both. Humans **accept, reject, or modify** gaps and tactics. Only accepted tactics can be assigned later. After a gap and a tactic are accepted, **suggested mappings** appear for accept or reject. **Create gap** lives here and next to the tactic library — not a new nav item.
3. Accepted open/partial gaps are prompted for **priority**. The engine does not assign a band. Human-created gaps land here too.
4. After a human lock, tactics can be **created or assigned** onto High / Medium / Low.
5. **Addressed** gaps stay on the plan with the tactics that closed them.
6. Later sources never restart the wizard. They land in the inbox.

Critical locked bands sit in High. Excluded gaps stay off the board. Candidate needs remain sourced atoms and still join onto gaps; they are not auto-promoted.

## v1 non-goals

- AI tactic ideation (extraction of existing studies from sources is inventory, not ideation)
- Auth / RBAC
- Multi-asset, multi-indication, country overlay plans
- Named annual snapshots (audit log is history)
- Embedding clusters as the catalog
