# KAN-113 Evidence Inventory delivery record

Parent: https://synapse21.atlassian.net/browse/KAN-113
Branch: `kan-113-evidence-inventory`; isolated worktree: `/private/tmp/synapse-kan-113`.
Base: `f669ffb`; implementation through `eb402c4`. No merge or publication yet.

## Delivered behavior

- KAN-114: Independent evidence-status and review-work filters, including combined filters, unique attention counts and resettable empty results.
- KAN-115: Ordered next actions, remaining task indicators, keyboard operation, accessible status-save validation and errors that preserve entered values.
- KAN-116: Collapsed rows with evidence-first expanded details, existing full-record navigation and secondary editing controls.
- KAN-117: Compact source suggestions, affected-gap navigation, explicit merge/create/reject choices and consequence explanations.
- KAN-118: Separate inventory readiness and priority progress, preserving previously available downstream work. Persistent strip accurately says “Unconfirmed or partial”.
- KAN-119: Sort by displayed numeric gap number, missing numbers last and deterministic ID tie-breaking.

Scientific definitions, authorization, required reasons, human confirmation, audit behavior and downstream eligibility were retained. See the approved [spec](evidence-inventory-review.md), [plan](kan-113-plan.md) and [glossary](../../GLOSSARY.md).

## Review evidence

Each task received independent specification and code-quality review. The final whole-branch review identified an inaccurate combined counter label and incomplete readiness terminology. One consolidated correction (`eb402c4`) addressed both, added producer-to-strip and tactic-only review regressions and cleaned copied test headers. Scoped re-review approved those corrections with no new breakage.

## Verification

Task-specific unit and Chromium checks passed before each subtask was marked Done. Final correction checks passed: 16 focused tests, followed by seven KAN-114 tests after fixture-prop correction, plus ESLint, TypeScript and whitespace checks.

Combined Chromium verification on the final implementation:

```bash
E2E_PORT=43229 \
E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55413/synapse_kan113_e2e \
node node_modules/@playwright/test/cli.js test \
 e2e/features/kan-114-review-filters.spec.ts \
 e2e/features/kan-115-next-action.spec.ts \
 e2e/features/kan-116-evidence-details.spec.ts \
 e2e/features/kan-117-source-suggestions.spec.ts \
 e2e/features/kan-118-readiness.spec.ts \
 e2e/features/kan-119-gap-number-sort.spec.ts \
 e2e/features/readiness-strip.spec.ts --project=chromium
```

Result: exit 0, eight passed in 25.1 seconds, including authentication setup. Server logged a destination-stream-closed warning; no assertion failed. Color-environment warnings also appeared.

Initial isolated full Vitest run: exit 1; 170/175 files and 1523/1541 tests passed. Failures: 11 unchanged CLI matrix tests exceeded 20 seconds; six older UI assertions expected retired selectors/copy; one AI-off ingestion test expected HTTP409 but received400. Follow-up reconciliation and final result are recorded below when available. Log: `/private/tmp/kan113-full-vitest-isolated.log`.

A single unchanged CLI case passed with `--testTimeout=120000`: one passed,20 skipped; test duration37.22 seconds. This supports a runtime timeout override without changing project configuration. Log: `/private/tmp/kan113-cli-timeout-experiment.log`.

A prior shared-database attempt was invalidated by PostgreSQL shared-memory exhaustion and restart. Final verification uses a disposable postgres16 container on local port55413 with512MB shared memory, and separate unit/browser databases. Development data was not changed by final verification.

## Limitations

Chromium coverage only; no exhaustive accessibility or cross-browser audit. A long-source-title/quote responsive fixture remains a follow-up. KAN-116 removal failure and successful retry were not separately tested. KAN-117 successful browser refresh was not separately retested; backend success, reasons, audit and permissions were covered. Parent KAN-113 stays open until verification is resolved and its Jira comment and Done transition succeed.

## Rulings made

1. Use native Vitest/Playwright despite generic pytest guidance: fits this TypeScript repository. Cost if wrong: test convention rework.
2. Use an isolated temporary worktree from the existing HEAD, preserving original design documents: protects unrelated branch work. Cost if wrong: branch rebasing.
3. Initially use a dedicated E2E database on local5432 and port43229 because default5433 was absent: avoids development data. Cost if wrong: rerun setup.
4. Move final verification to disposable postgres16 on55413 with512MB shared memory following proven64MB exhaustion: avoids repeating the database crash. Cost if wrong: repeated environment setup and tests.
5. Reconcile older selectors/copy while preserving behavioral assertions, without another product fix wave: these tests expect intentionally retired UI. Cost if wrong: restore stronger assertions and reverify.
6. Override CLI test runtime to120seconds for verification after a case took37.22seconds and passed: no production/config change. Cost if wrong: slower detection of a genuine hang.

## Final verification disposition

Legacy verification reconciliation changed only three test files. It retains refresh counts, filter persistence, URL synchronization and confirmed-state behavior; it also repairs a source-code assertion that previously sliced between removed function names. Focused command:

```bash
DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55413/synapse_kan113_test \
node node_modules/vitest/vitest.mjs run \
 tests/kan-18-frontend-render.test.ts \
 tests/kan-68-page-refresh.test.ts \
 tests/iegp-create-buttons.test.ts
```

Result: exit0, three files /26 tests passed. ESLint on these three files and TypeScript exited0. Final string-only source-slice correction was followed by successful focused tests, ESLint and whitespace check.

The AI-off test reproduces independently (exit1, one failed,10 skipped): `node node_modules/vitest/vitest.mjs run tests/ai-off-features.test.ts -t 'answers ingest with 409 ai_off and opens no run'`, using the isolated unit database above. Its unchanged path rejects the unknown demo ID `any` with400 before checking the AI switch. A diff against `f669ffb` is empty for the test, route, ingestion pipeline, demo-pack lookup, AI-switch and authentication guard. This establishes an unchanged execution path; a separate base-checkout runtime run was not performed. Typed-ingestion assertions after the first failing assertion were not reached.

No further full-suite run is claimed: an independently reproduced failure remains and only one of the11 timed-out benchmark cases has been rerun with the longer limit. The earlier full result remains the full-suite result. Product UI checks are passing, but parent KAN-113 remains In Progress. No Done transition, next-ticket handoff, merge or push is appropriate while required verification remains unresolved. All scratch evidence remains preserved while this work is open.

Independent read-only review of the three-file verification reconciliation approved specification compliance and code quality, with no findings. It confirmed the URL/refresh/confirmation guarantees remain covered and the collapsed-row source assertion is stronger. No additional tests were run by the reviewer.

## Resumed verification repair

The owner authorized resolving the remaining verification blockers and requested a live preview before merge. The AI-off fixture now uses the existing `heor-interview` demo, retaining409 `ai_off` assertions for valid demo and typed ingestion. A separate unknown-demo test asserts400 `invalid_request` and no new run. Production validation order is unchanged. The entire AI-off test file passed:12 tests, exit0; ESLint, TypeScript and whitespace checks exited0. Independent scoped review approved specification compliance and code quality with no findings.

Additional ruling: use a valid demo fixture for the AI-off check and separately test invalid input, rather than changing production validation order. Reason: the reproduced failure came from an unknown fixture ID. Cost if wrong: revisit the API contract and test expectations.

The earlier open-verification disposition above is historical; a final full run with `--testTimeout=120000` is in progress. The result below, when present, supersedes it.

## Final successful verification

```bash
DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55413/synapse_kan113_test \
node node_modules/vitest/vitest.mjs run --testTimeout=120000
```

Result: exit0;175/175 test files and1542/1542 tests passed in889.96seconds. All21 CLI benchmark tests passed (415.348seconds for that file). The test-timeout override is limited to the command; project configuration is unchanged. Log: `/private/tmp/kan113-final-full-vitest.log`.

Together with the eight combined Chromium checks on the unchanged product implementation, this resolves the required verification blockers. The final incremental changes are test fixtures and documentation only. Lint/type/whitespace checks passed for those edits, and independent review approved them. The owner requested a live branch preview before merge; no merge or push is authorized by that request.

## Review preview hydration follow-up (2026-10-16)

The reported extra `style={caret-color: transparent}` attribute matches Playwright's default screenshot preparation, which temporarily mutates input styles to hide the cursor. The temporary preview launcher captured a screenshot immediately after finding the server-rendered inventory, allowing screenshot preparation to overlap React hydration. The application search input has no inline caret style. The launcher now uses `caret: "initial"`, preventing this external mutation; no application warning suppression or rendering changes were added.

Verification: `node /private/tmp/kan113-check-hydration.mjs` exited0 after three fresh reloads, interactive search checks and screenshots with caret mutation disabled; no console or page errors and no inline caret style. The existing KAN-114 browser check now guards hydration console errors and uses the same safe screenshot option.

The owner approved the UI and requested a PR into main. Current main was merged into this branch; the sole conflict was an explanatory comment beside the same valid AI-off demo fixture, retained alongside this branch's separate invalid-input test. The preview login mismatch was caused by the isolated database having no password accounts; access was restored through its existing development-only demo session. No normal account credentials were changed.

Post-main integration verification: 15 Chromium checks passed in28.4seconds, covering KAN-114 through KAN-119, readiness strip, source creation and parsing (including authentication setup). `tests/ai-off-features.test.ts`:12 passed, exit0. Scoped ESLint, `tsc --noEmit` and `git diff --check`:exit0. The earlier full1542-test run remains the full-suite evidence; the subsequent changes are test/documentation and main's test updates only.
