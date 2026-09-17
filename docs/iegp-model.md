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
| Tactic | Structured generating or disseminating activity. Status completed / ongoing / planned / proposed / cancelled. |
| Gap–tactic coverage | Many-to-many. Ten dimensions + overall Full / Partial / Limited / Not relevant. |
| Residual evidence need | Child of a gap. Original gap is preserved. |
| Priority | Locked band on the residual. Coverage ≠ priority. |
| Roadmap item | Ongoing + planned + proposed tactics only. Completed stay on the dossier. |

## Gates (human lock)

Actor is a typed **name + function**. No login. `user_id` is not required in v1.

1. Candidate need accept / reject (optional gap join on accept)
2. Extracted gap accept / reject / **modify**
3. Gap status (Candidate / Open / Partial / Addressed / Excluded)
4. Each of 10 coverage dimensions
5. Overall coverage degree
6. Residual statement (engine drafts from uncovered dimensions; human edits and locks)
7. Priority band (**human only** — the engine does not suggest or assign a band)
8. Create or assign a tactic (human-authored proposals; extracted tactics are inventory, not ideation)
9. Roadmap row

Addressed may be locked only if coverage supports Full, **or** the actor supplies an override note. The engine never writes Addressed.

## Priority (human lock)

Priority is a human lock of High / Medium / Low (Critical folds into High on the plan). The engine does not assign a band. Effort and cost live on the tactic, not on the need. Priority ≠ roadmap inclusion.

## Refresh (living plan)

Tactic status change or new ingest marks related coverage **stale** and unlocks residuals for re-lock. Nothing auto-closes.

## Evals

Gold: candidate needs from seed sources, and gap–tactic overall coverage. Safety: zero unlocked Addressed rows; `engineMaySetStatus("validated_addressed")` is false.

## Surfaces

The home screen (`/`) **is** the IEGP process:

1. Upload sources. The engine extracts **candidate gaps** and **tactics**, and drafts **residual evidence needs**.
2. The plan lists open (candidate) gaps with their residuals. Humans **accept, reject, or modify**.
3. Accepted open/partial gaps are prompted for **priority**. The engine does not assign a band.
4. After a human lock, tactics can be **created or assigned** onto High / Medium / Low.
5. **Addressed** gaps stay on the plan with the tactics that closed them.

Critical locked bands sit in High. Excluded gaps stay off the board. Candidate needs remain sourced atoms and still join onto gaps; they are not auto-promoted.

## v1 non-goals

- AI tactic ideation (extraction of existing studies from sources is inventory, not ideation)
- Auth / RBAC
- Multi-asset, multi-indication, country overlay plans
- Named annual snapshots (audit log is history)
- Embedding clusters as the catalog
