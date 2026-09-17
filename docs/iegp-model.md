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
2. Gap status (Candidate / Open / Partial / Addressed / Excluded)
3. Each of 10 coverage dimensions
4. Overall coverage degree
5. Residual statement (engine drafts from uncovered dimensions; human edits and locks)
6. Priority band (engine suggests a score; human locks Critical / High / Medium / Low)
7. Proposed tactic (human-authored)
8. Roadmap row

Addressed may be locked only if coverage supports Full, **or** the actor supplies an override note. The engine never writes Addressed.

## Priority formula (suggested, not auto-applied)

`score ≈ 100 × importance × time-urgency × residual-severity × stakeholder-weight`

Effort and cost live on the tactic, not on the need. Priority ≠ roadmap inclusion.

## Refresh (living plan)

Tactic status change or new ingest marks related coverage **stale** and unlocks residuals for re-lock. Nothing auto-closes.

## Evals

Gold: candidate needs from seed sources, and gap–tactic overall coverage. Safety: zero unlocked Addressed rows; `engineMaySetStatus("validated_addressed")` is false.

## Surfaces

The home screen (`/`) **is** the IEGP: three boxes — High, Medium, Low — of prioritized gaps with the tactics mapped to each. Critical locked bands sit in High. Excluded and fully addressed gaps stay off this board.

- AI tactic ideation
- Auth / RBAC
- Multi-asset, multi-indication, country overlay plans
- Named annual snapshots (audit log is history)
- Embedding clusters as the catalog
