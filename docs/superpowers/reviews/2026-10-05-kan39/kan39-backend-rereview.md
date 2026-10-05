# KAN-39 Task 1 scoped F1 re-review

## Verdicts

- **F1: ADDRESSED.**
- **Specification compliance: PASS for the F1 correction.** Review-current checks, live inventory, and publication revalidation now agree when a new extraction takes ownership of a human-added opposite kind.
- **Code quality: PASS for the fix diff.** No new actionable correctness or maintainability findings were established in the changed code.

## Why F1 is addressed

`src/accuracy/store/assembly-review-store.ts:502`–`505` now identifies a revision through its immutable revision ancestry and applies `assemblyCurrentForDeclaredProductionRuns` before the assembly is returned for live projection. This is the same current-production predicate used by the review path, including the counterpart ownership rule at lines 285–287. The check runs under the existing workspace transaction/lock in `approvedLiveInventory`.

For the original sequence—tactic-only baseline, approved human gap addition, then a separately published and approved need-only owner—the human revision fails this predicate before projection can filter its gap out. `assemblyForHead` now raises `approval_required`. The symmetric gap-only baseline/human tactic/new inventory-only owner follows the same rule. A cumulative edit on such a revision also cannot authorize partial projection because the guard applies to the whole revision assembly, rather than only to the added item.

`listDownstreamClaims` uses the guarded inventory path. `revalidateApprovedLiveBindings` also uses it and translates the established approval refusal to `conflict`; a downstream module started after the ownership change is refused before consumption/run creation. Existing binding comparison continues to protect work that began before the change.

The removed counterpart check was unreachable after the old opposite-kind projection filter. Moving enforcement before projection fixes its ordering defect. The `revisionState.revision` condition preserves the established generated-assembly per-kind projection behavior and does not change unmanaged legacy inventory resolution. Removal-only revisions are also covered because revision ancestry is checked even when the resulting assembly contains no human versions.

## Regression evidence assessed

The new parameterized integration cases in `tests/accuracy-assembly-revision.test.ts` cover both ownership directions and use distinct canonical identities for the independent replacement. They first prove the approved human item is live, then prove stale review state, refusal of both live readers, publication-binding conflict, and rejection of a newly started downstream module without saved runs or `computed_status` effects. These observable assertions cover the original F1 trigger and its downstream consequence.

The accompanying SQL-order correction keeps whole-record equality in the immutable-run preservation test while removing reliance on unspecified row order. The enum literal typing is confined to test fixture content. Neither change weakens the tested behavior or changes production behavior.

Accepted the supplied fix evidence in `/private/tmp/kan39-backend-report.md`:

- Both new regression directions failed before the production fix, including live reads and downstream durable effects.
- `npx vitest run tests/accuracy-assembly-revision.test.ts tests/accuracy-assembly-approval-integration.test.ts tests/accuracy-assembly-review-store.test.ts --silent` passed: **73 tests** (14 revision, 49 KAN-38 approval integration, 10 review store).
- `npm run typecheck`, changed-file ESLint, and `git diff --check` passed after the final fixture/query corrections.

## Scope and limitations

Read the supplied fix diff, correction evidence, and relevant current predicate/guard/test-fixture lines. This re-review was limited to F1 and potential new breakage in that diff. No tests were rerun, no source files were edited, no subagents were spawned, and no Git/Jira writes occurred. This review writes only this requested report.

This acceptance does not claim integrated full-suite, frontend/browser, real-provider, crash-recovery, or query-scale verification. Those remain the controller's existing integration work and reported limits.
