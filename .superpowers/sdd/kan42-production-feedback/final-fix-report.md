# KAN-42 final review fix: feedback cache after navigation

## Scope and change

- Addressed the sole Important finding in `final-review.md`. When a feedback POST settles, the submitting assembly's cached detail becomes stale and requires a fresh exact-detail GET even if the user has opened another assembly.
- Successful feedback refreshes automatically only while its assembly remains active. An uncertain rejected response keeps that assembly stale until it is reopened or explicitly refreshed. The targeted invalidation does not advance the shared detail request token, so a pending request for the newly opened assembly can complete.
- Changed only `src/components/accuracy/assembly-history.tsx` and `tests/accuracy-assembly-feedback-ui.test.ts` in product/test scope. Deferred Minor findings were left untouched.

## TDD and verification

- **RED:** `npx vitest run tests/accuracy-assembly-feedback-ui.test.ts --silent` exited 1: 2 new navigation regressions failed because reopening the original assembly made no fifth GET (6 other tests passed).
- **GREEN:** The same command exited 0: 8/8 passed. The tests hold B's detail GET pending while A's POST succeeds or rejects, then reopen A and require a new exact-detail GET. Submission is unavailable until that GET succeeds, after which saved history is visible and submission can be enabled again.
- `npx vitest run tests/accuracy-assembly-feedback-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent` exited 0: 39/39 passed.
- `npm run typecheck` exited 0.
- `npx eslint src/components/accuracy/assembly-history.tsx tests/accuracy-assembly-feedback-ui.test.ts` exited 0.
- `git diff --check` exited 0.
- Full repository test command was started, then stopped with exit 130 so the controller can run the final whole-branch suite after scoped review. It is not claimed as a passing check here.

## Self-review

- Confirmed both success and uncertain failure paths invalidate A before checking active navigation. No POST result for A updates B's displayed history.
- Confirmed the helper changes only A's cached freshness and refresh requirement; it does not cancel B's pending detail request or alter unrelated assemblies.
- No material limitation identified within this bounded finding. The two Minor items in the final review remain documented follow-ups.
