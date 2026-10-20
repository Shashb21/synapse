# Evidence Inventory implementation — KAN-113

Spec: docs/design/evidence-inventory-review.md

## Global Constraints
Preserve current visual identity, scientific definitions, permissions, required reasons, human confirmation, audit behavior and downstream eligibility. No new viewer, bulk approval, automatic confirmation or unrelated refactor. Work only in /private/tmp/synapse-kan-113. Each task must use test-first behavior checks and record exact verification commands/results. Read relevant installed Next.js docs before changing Next code. Native Vitest and Playwright tests apply to this TypeScript project.

## Task 1: KAN-114 — Separate evidence status from review work and add Needs attention filtering

## Parent

[KAN-113](https://synapse21.atlassian.net/browse/KAN-113)

## What to build

Distinguish Evidence status (Open, Partially Addressed, Addressed) from Review state (outstanding human assessment). Keep All gaps as the default and allow Needs attention to combine with evidence-status filters.

Preserve the current visual identity, scientific definitions, permissions, required reasons, human confirmation, audit behavior and downstream eligibility rules. Include relevant accessible loading/error/empty states. Use focused repository Vitest/Playwright checks as appropriate and record exact commands/results; no unrelated redesign or refactor.

## Acceptance criteria

- [ ] Needs attention includes unconfirmed assessments, partial gaps, new-source review flags and tactic mappings requiring review, including confirmed gaps with later review flags.
- [ ] Count each gap once even with multiple tasks; show pending source suggestions separately and make active-filter counts clear.
- [ ] Verify each review condition, combined filters, multiple flags on one gap, and empty results with a clear reset path.

## Blocked by

None (can start immediately).

## Task 2: KAN-115 — Show the next action for each gap and preserve remaining review tasks

## Parent

[KAN-113](https://synapse21.atlassian.net/browse/KAN-113)

## What to build

Add a Next action column that takes users directly to their primary outstanding task, while exposing additional tasks in expanded details.

Preserve the current visual identity, scientific definitions, permissions, required reasons, human confirmation, audit behavior and downstream eligibility rules. Include relevant accessible loading/error/empty states. Use focused repository Vitest/Playwright checks as appropriate and record exact commands/results; no unrelated redesign or refactor.

## Acceptance criteria

- [ ] Use primary-action order: resolve partial gap, review tactic mappings, review new source, confirm status.
- [ ] Indicate additional tasks on the row; completing one task must not clear unrelated flags. A gap leaves Needs attention only when no included tasks remain.
- [ ] Required-reason and failed status-save errors are announced accessibly and associated with the relevant field; preserve entered values on failure.
- [ ] Verify a gap with several tasks, sequential completion, action order, keyboard operation, validation errors and failed saves.

## Blocked by

[KAN-114](https://synapse21.atlassian.net/browse/KAN-114) — establishes the outstanding review tasks used by Next action.

## Task 3: KAN-116 — Put supporting evidence first in expanded gap details

## Parent

[KAN-113](https://synapse21.atlassian.net/browse/KAN-113)

## What to build

Keep rows collapsed initially. Order expanded content as gap statement; sources and supporting statements; mapped tactics and coverage; additional review actions; collapsed Edit gap details. Link the compact evidence view to the existing full gap/evidence record.

Preserve the current visual identity, scientific definitions, permissions, required reasons, human confirmation, audit behavior and downstream eligibility rules. Include relevant accessible loading/error/empty states. Use focused repository Vitest/Playwright checks as appropriate and record exact commands/results; no unrelated redesign or refactor.

## Acceptance criteria

- [ ] Replace the workbench label 'constituent needs' with 'Sources and supporting statements'.
- [ ] Provide a clearly labelled full-record link without introducing a document viewer.
- [ ] Settings-save errors are announced accessibly and associated with relevant fields where applicable; failed saves preserve entered values.
- [ ] Verify content order, full-record navigation, keyboard operation and visible focus, narrow-screen layout, and failed settings saves.

## Blocked by

None (can start immediately).

## Task 4: KAN-117 — Make source suggestions compact and explain their consequences

## Parent

[KAN-113](https://synapse21.atlassian.net/browse/KAN-113)

## What to build

Replace the always-expanded suggestions panel with a compact summary and explicit inline expansion, keeping the gap inventory prominent and suggestions discoverable from affected gaps.

Preserve the current visual identity, scientific definitions, permissions, required reasons, human confirmation, audit behavior and downstream eligibility rules. Include relevant accessible loading/error/empty states. Use focused repository Vitest/Playwright checks as appropriate and record exact commands/results; no unrelated redesign or refactor.

## Acceptance criteria

- [ ] Use choices Merge into existing gap, Create separate gap, and Reject suggestion.
- [ ] Before confirmation explain that merging may return priority to draft and flag tactic mappings for review.
- [ ] Keep manual additions secondary to the inventory and retain existing suggestion confirmation and audit behavior.
- [ ] Verify all three choices, affected-gap navigation, expansion/collapse, keyboard controls, narrow-screen layout and loading, empty and error states.

## Blocked by

None (can start immediately).

## Task 5: KAN-118 — Clarify inventory readiness and priority progress

## Parent

[KAN-113](https://synapse21.atlassian.net/browse/KAN-113)

## What to build

Show inventory review readiness separately from Open-gap priority progress so users understand outstanding review work and available later stages.

Preserve the current visual identity, scientific definitions, permissions, required reasons, human confirmation, audit behavior and downstream eligibility rules. Include relevant accessible loading/error/empty states. Use focused repository Vitest/Playwright checks as appropriate and record exact commands/results; no unrelated redesign or refactor.

## Acceptance criteria

- [ ] Label what each count measures; do not describe human review as evidence closure.
- [ ] New unresolved evidence updates readiness messaging while previously available later stages remain available for eligible work under existing rules.
- [ ] Verify an already-unlocked plan receiving new unresolved evidence, accurate messages and counts, and continued eligible downstream access.

## Blocked by

None (can start immediately).

## Task 6: KAN-119 — Fix sorting by the displayed gap number

## Parent

[KAN-113](https://synapse21.atlassian.net/browse/KAN-113)

## What to build

Make ascending and descending ID sorting follow the gap numbers users see instead of internal identifiers.

Preserve the current visual identity, scientific definitions, permissions, required reasons, human confirmation, audit behavior and downstream eligibility rules. Include relevant accessible loading/error/empty states. Use focused repository Vitest/Playwright checks as appropriate and record exact commands/results; no unrelated redesign or refactor.

## Acceptance criteria

- [ ] Sort by displayed gap number in both directions.
- [ ] Document and implement a deterministic policy for missing numbers and ties.
- [ ] Verify records with internal identifiers deliberately conflicting with displayed numbers, both directions, missing numbers and ties.

## Blocked by

None (can start immediately).
