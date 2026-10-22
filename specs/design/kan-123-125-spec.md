# KAN-123 and KAN-125: planning clarity and selective ingestion cleanup

Status: approved by user on 2026-10-22.

Source issues, fetched on 2026-10-21:
- https://synapse21.atlassian.net/browse/KAN-123
- https://synapse21.atlassian.net/browse/KAN-125

## Intent and boundaries

KAN-123 distinguishes planning activity, scientific coverage assessment, and
available evidence. KAN-125 removes proven ingestion-created relationships when
ingested files are cleared without erasing manual records or human decisions.
Neither changes scientific coverage rules, workshop approval, permissions,
human rationale, audit retention, or operation with AI disabled.

The current checkout is branch `KAN-152`, committed baseline `d0449d3`, with
56 staged files from other work. Implementation must preserve that work.
An isolated worktree from the committed baseline is recommended; the current
staged guide-copy improvements must be considered during later integration.

## KAN-123: presentation of planning and assessment

This is a bounded extension of the existing Tactic Ideation flow.

Use mapped relationship rows from `src/lib/iegp/engine.ts` as the existing source
of lifecycle, recorded coverage, fit, and review information. Extend the read
models in `src/components/tactic-ideation/data.ts` and presentation in
`src/components/tactic-ideation/ideation-board.tsx`; reuse the existing assessment
details instead of creating a second coverage calculation.

Show separate planning and coverage facts:

- Planning: No candidate linked, Candidate linked, or Tactic planned. An
  unaccepted proposal is an option, not a saved relationship. Planned, ongoing,
  and completed are committed lifecycle states; keep each exact lifecycle label
  visible. A cancelled relationship must not appear as planned work.
- Coverage: unassessed or the recorded verdict, with human-confirmation,
  stale/unknown qualifications, and existing remaining-need information.
- Available evidence: show only documented evidence availability; neither a
  saved link nor a planned tactic proves that evidence is available.

Replace the single green link-count completion implication with neutral,
explicitly labelled planning counts. Numerators and denominators use the same
search, domain, and link filters as the displayed population. Label current
eligible gaps separately from retained existing work. Retained rows must expose
planning and assessment facts too: planned work can leave the High/Open list
because the existing status engine moves its gap to Partial or Addressed.

Preserve relationship identity including expansion ID. Retained counts should
use valid mapped rows rather than raw rows with broken endpoint references.

Scientific invariants:

- Planned, ongoing, and completed tactics can contribute to coverage.
- A current, supported human-confirmed Full assessment can make a gap Addressed
  while the tactic is planned. Do not require completed research.
- Proposed generation tactics do not normally count; preserve existing published
  literature exceptions for publication tactics with available evidence.
- Preserve existing accepted-child, human override, requirement support, and
  stale-assessment rules. Do not edit the status engine to change these meanings.

Verification covers accepted proposed/unassessed ideas, planned/unassessed,
partial, unknown and stale assessments, supported planned Full, lifecycle labels,
expansions, filtered counts, retained work, guide copy, and accessible descriptions.
Use the established TypeScript test tools and public action/read-model seams;
the approved KAN-121 specification explicitly uses Vitest and Playwright here.

## KAN-125: explicit relationship ownership

The traced defect is in `clear-ingested-files.ts`: coverage deletion follows
ingestion-created endpoint IDs. S4 can insert a relationship between two manual
endpoints, so neither endpoint proves ownership of that relationship. S4 currently
discards the returned coverage ID. Its committed endpoint pairs do not prove a
row was newly created, because an existing expansion placeholder can be assessed
in place.

Proposed deletion policy for relationships between retained manual endpoints:

1. Record nullable creation-run provenance on a coverage row only when S4 really
   inserts it. Use the same transaction as the insert. Never claim creation of
   an existing relationship merely because S4 updated its assessment.
2. Record durable human retention when a person explicitly reviews, accepts,
   confirms, or saves that exact relationship. Keep this distinct from assessment
   origin, which does not capture all human actions. Merely receiving a sibling
   review warning must not count as human adoption.
3. Clear a relationship between retained endpoints only when successful S4
   creation is proven and no subsequent human adoption applies. Preserve human
   locks and exact relationship decision history conservatively.
4. Preserve pre-existing manual relationships and existing expansion placeholders.
   Preserve uncertain legacy creation provenance and expose a review reason that
   ownership could not be established after sources were cleared. Do not backfill
   ownership from AI origin, endpoint pairs, rationale text, or candidates.
5. Keep the existing rules for relationships whose ingestion-created endpoints
   are removed; this task does not redefine endpoint ownership or resurrect
   deleted endpoints. Retain existing audit and module-run history.

The responsible areas are `schema.ts` / `db.ts`, coverage insertion and human
decision paths in `store.ts`, `relationship-change.ts`, the S4 commit path, and
`clear-ingested-files.ts`. Use the existing migration mechanism with nullable
legacy values; no guessed historical provenance.

Acquire the ingestion lock and then the relationship lock before classification
and deletion, consistent with S4's lock ordering. Human adoption must not race
with cleanup. All provenance, preservation warnings, deletions, and computed
status updates remain in the workspace transaction and roll back together.

Verification must first reproduce the defect in a disposable database schema,
then prove the fix through actual S4 and pipeline paths. Cover manual endpoints
surviving while their unreviewed automated link disappears; Open status and
downstream eligibility restoration; pre-existing human coverage; each later human
decision path; existing expansion updates; repeat clear/reingest; uncertain legacy
warnings; rollback; busy ingestion; human-review concurrency; and workspace
isolation. Assert exact relationship IDs, not only surviving endpoint IDs.

Material tradeoff: conservative preservation can leave an uncertain legacy
mapping affecting status until a person reviews it. This is preferable to deleting
human work, and must be visible to the user.

## Execution and evidence

Requested execution method: superpowers:subagent-driven-development. After design
review, create the implementation plan, its plan-specific ledger and preflight
table, then implement one task at a time with fresh implementers, task reviews
covering requirements and quality, and a final whole-branch review.

Baseline verification on the current checkout:

```text
npx vitest run tests/kan-111-clear-ingested-files.test.ts tests/kan-154-decision-language.test.ts
Test Files  2 passed (2)
Tests       21 passed (21)
Duration    21.90s
```

The first sandboxed attempt could not complete database access and was stopped.
The successful run had approved local database access and used the cleanup
suite's disposable schemas. Passing existing tests does not reproduce or fix
KAN-125: the current S4 concurrency test does not assert automated-link removal.
No product implementation, new regression, commit, publication, or Jira Done
transition has occurred at this design stage.
