# Task 3: Complete proposals feedback UI and guide

## Implementation

- Added an accessible Production feedback section to exact Complete proposal detail. It lists server-eligible production consumer runs with run links, timestamps, approval IDs and consumed item versions. Contributor controls select a run, optional consumed subset, category and rationale; viewers receive readable history without write controls.
- Sent the strict Task 2 request contract with the displayed assembly fingerprint and selected run's approval review ID. Empty item selection sends `[]`, meaning all items this assembly contributed to that run. History shows actor, time, run, approval, category, rationale, item version, source and evidence.
- Serialized writes through the existing mutation lock. Successful writes refresh the exact assembly before another write is enabled. A failed write or refresh leaves the form and rationale visible, disables another submit, and offers a retry. Detail responses are token-guarded; late feedback responses after workspace or assembly navigation do not update the new view.
- Documented use, historical scope, proof limits, and why feedback does not establish gold accuracy or clinical correctness in `docs/kan-42-production-feedback.md`.

## TDD evidence and verification

- **RED:** `npx vitest run tests/accuracy-assembly-feedback-ui.test.ts --silent` exited 1 with four expected failures out of five tests. The old panel did not show `consumer-1`, the consumed subset selector, contributor form, or history. The pre-existing late workspace response guard passed.
- **GREEN:** `npx vitest run tests/accuracy-assembly-feedback-ui.test.ts --silent` exited 0: 7/7 tests passed. Tests cover history and proof-limit copy, run link, partial and empty subset contracts, category, permissions, successor isolation, duplicate clicks, failed refresh retry, and late workspace/assembly responses.
- `npx vitest run tests/accuracy-assembly-feedback-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent` exited 0: 38/38 passed in the final state.
- `npm run typecheck` exited 0; `npx eslint src/components/accuracy/assembly-feedback.tsx src/components/accuracy/assembly-history.tsx tests/accuracy-assembly-feedback-ui.test.ts` exited 0; `git diff --check` exited 0 before final staging.

## Files and self-review

- `src/components/accuracy/assembly-feedback.tsx`
- `src/components/accuracy/assembly-history.tsx`
- `tests/accuracy-assembly-feedback-ui.test.ts`
- `docs/kan-42-production-feedback.md`
- `.superpowers/sdd/kan42-production-feedback/task-3-report.md`

Self-review found the first refresh flow removed the form after a failed GET, losing the contributor's rationale. The feedback refresh now keeps stale detail visible with mutation controls disabled until retry succeeds. I also added an explicit active-assembly check so a POST resolving after navigation cannot refresh the old proposal into the new view.

No material limitation remains in this UI scope. Eligibility and evidence validity come from the server; the guide states truncated or legacy unprovable consumption records are ineligible for new feedback while an empty legacy history remains readable.
