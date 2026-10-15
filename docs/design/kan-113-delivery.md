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
