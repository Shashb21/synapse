# KAN-213 retirement verification

Scope: final retirement release evidence and documentation. Repository inventory date: 2026-11-03. Parent baseline: `8708bbc9`; application code identity `8708bbc9307c83bf04c5326266c849d0ebde12c6` with documentation-only working-tree changes; final published identity remains pending. [Retention/rollback runbook](../operations/accuracy-retirement.md); [historical KAN-212 evidence](kan-212-retirement.md).

**Local verification status:** application and benchmark typechecks passed; targeted browser coverage passed after correcting one disposable-database fixture setup. The isolated benchmark and full suite passed. Owned verification container is stopped and its volume retained; container removal after PR acceptance and publication/CI remain tracked separately by the parent. No release-readiness claim is made. Earlier KAN-212 results are historical and are not reused as proof for this head. Private backups/access and rollback/restore rehearsal remain unverified.

## Required evidence matrix

Record the exact command, exit code, date, tested SHA/working-tree identity, counts/skips and limitations for each row. Use only the owned disposable database and scripted providers; no shared database or paid calls.

| Required check | Command / scope | Result for KAN-213 |
| --- | --- | --- |
| Next.js route types | `npx next typegen` | Passed, exit 0, 2026-11-03; parent-confirmed process result; final logs below |
| Application TypeScript | `npx tsc --noEmit` | Passed, exit 0, 2026-11-03; parent-confirmed process result; final logs below |
| Historical benchmark TypeScript | `npm run typecheck:kan100` | Passed, exit 0, 2026-11-03; parent-confirmed process result; final logs below |
| Historical benchmark tests | `npm run test:kan100` | Passed, exit 0; 8 files / 183 tests passed, 426.27s; thread-pool command below |
| Full suite | `DATABASE_URL=<owned disposable database> npx vitest run` | Passed, exit 0; 214 files passed / 1 skipped, 2,463 tests passed / 10 skipped; 936.69s |
| Admin browser boundaries | Isolated Playwright: `e2e/admin`, control-panel and AI-toggle specs; include retired routes, owner/non-owner behavior and AI & routing | Passed across initial invocation and affected-file rerun; see browser evidence below |
| Development browser workflows | Isolated Playwright: setup, execution, history, evaluation, evaluation-tools, results, costs; include owner tool links | Passed across initial invocation and affected-file rerun; see browser evidence below |
| Customer regression browser checks | Isolated Playwright: s0-upload, s1-parse, s2-gap-extract, s3-tactic-extract, s6-partial-split, s10-timeline | Passed across initial invocation and affected-file rerun; see browser evidence below |
| Final retired-dependency scan | Production imports/commands, exact retired-route boundaries and allowed historical/schema references | Passed source scan at unchanged application SHA; 3 intentional references, detailed below |
| Security and scope review | Baseline-to-head diff: no schema drops/migration, secrets/private artifacts, unrelated stage edits or unclassified test deletion | Current working-tree changes are Markdown only; no source/schema/dependency/test changes. Local final scan/diff review passed; publication identity/CI remain parent-owned |
| Documentation static checks | `git diff --check`; local link/path validation described below | Final checks completed after evidence edits, 2026-11-03; both exit 0 (108 links, 8 current helper paths, 14 rollback paths) |
| Publication and CI | Commit identity, matching branch on origin + github, PR into `admin-accuracy-removal`, final-head CI | Pending parent; no merge/deployment authorized |
| Owned resource cleanup | Record process ownership, exact container name/ports/databases/mounts, stop/remove outcome and retained/deleted volumes | Parent confirmed owned container stopped (`exited`), no listener on browser port 43223; volume retained. Exact container removal pending PR acceptance |

## Documentation check evidence (Task 1)

- `git diff --check`: exit 0 on 2026-11-03 after documentation edits.
- `python /private/tmp/kan213-check-doc-links.py`: exit 0; validates local Markdown link targets introduced by this task, current retained helper/CLI paths, and rollback paths against Git at `6f4387a110bf77e9f3b601e71dca725ecf76e819`. Historical links and pre-existing broken links are reported separately rather than presented as current instructions.
- No runtime suite, database, private backup, live access policy, paid provider call or rollback rehearsal was run by Task 1. The verification owner must replace pending entries with actual observations, not inferred passes.

## Typecheck and suite evidence

The parent reports exit 0 for each final typecheck invocation on 2026-11-03:

- `npx next typegen`: `/private/tmp/kan213-typegen-final.log`, “Types generated successfully”.
- `npx tsc --noEmit`: `/private/tmp/kan213-tsc-final.log`, empty successful output.
- `npm run typecheck:kan100`: `/private/tmp/kan213-benchmark-typecheck-final.log`, TypeScript invocation shown with no diagnostics.

Early benchmark invocations (`/private/tmp/kan213-benchmark-tests.log`, `kan213-benchmark-tests-rerun.log`) and an early full-suite invocation (`kan213-unit.log`) were interrupted by the parent while output showed only the Vitest startup banner. They do **not** establish either passing tests or a proven runner stall. The parent-owned sequential process session `29191` completed the benchmark invocation **exit 0**: **8 files / 183 tests passed**, duration **426.27s**, start **19:19:05** on 2026-11-03. `/private/tmp/kan213-benchmark-threads.log` contains the final summary. The exact command was `DATABASE_URL=<owned loopback database at 127.0.0.1:55433/synapse_kan213_test> npm run test:kan100 -- --pool=threads`; the isolated benchmark config does not load normal database test setup. No benchmark tests were skipped in the reported summary.

The same sequential session then started `DATABASE_URL=<owned loopback database at 127.0.0.1:55433/synapse_kan213_test> npx vitest run --pool=threads`, writing `/private/tmp/kan213-unit-threads.log`, startup 19:26. The full suite completed **exit 0**, confirmed by the parent from session `29191`: **214 files passed / 1 skipped**, **2,463 tests passed / 10 skipped**, duration **936.69s**, start **19:26:12** on 2026-11-03. No suite was rerun by the documentation worker.

The ten skipped tests are existing connection-pool-gated concurrency cases: three in `tests/kan-121-freshness.test.ts`, one in `tests/kan-121-linking.test.ts`, two in `tests/manual-mapping.test.ts`, and all four in `tests/merge-lock-order.test.ts`. Their `skipIf` guards require larger workspace pools (thresholds 2, 3 or 4); no skips were added by this documentation-only change. Those concurrency scenarios were not exercised in this run.

The full-suite log contains expected failure-path stderr (transaction/audit rollback and recovery assertions), a deliberately tested BigInt serialization failure in `kan-90-plan-coverage`, and Node warnings that `--localstorage-file` lacks a valid path. All associated test files passed. These warnings were observed and were not fixed by KAN-213.

## Targeted browser evidence

Parent-operated isolated Playwright on 2026-11-03 used `E2E_PORT=43223`, `NEXT_TELEMETRY_DISABLED=1`, a local test-only `SESSION_SECRET`, and `E2E_DATABASE_URL` on `127.0.0.1:55433`. The application code was unchanged at the SHA above. The Playwright config defaults to a fresh temporary server (`E2E_REUSE` unset), sets `SYNAPSE_TEST_STUB_LLM=1`, and empties all five provider-key variables for the owned server. No paid provider calls were used.

The selected scope was all `e2e/admin` specs; feature specs `control-panel-provider-keys`, `control-panel-session`, `ai-toggle-settings`, `development-setup`, `development-execution`, `development-history`, `development-evaluation`, `development-evaluation-tools`, `development-results`, `development-costs`, `s0-upload`, `s1-parse`, `s2-gap-extract`, `s3-tactic-extract`, `s6-partial-split`, and `s10-timeline` (each `.spec.ts` under `e2e/features`).

- Initial log `/private/tmp/kan213-browser.log`: **129 passed, 1 failed, 1 did not run (4.0m)**. The failing provider-control outage fixture explicitly requires a disposable loopback database named `synapse_e2e`; the initially assigned `synapse_kan213_e2e` name failed that safety guard. This is a fixture setup failure, not a waived failure.
- Parent created `synapse_e2e` inside the same owned container and reran the complete `e2e/features/control-panel-provider-keys.spec.ts` file against it: `/private/tmp/kan213-browser-rerun.log`, **12 passed (19.7s)**, including the formerly failed outage test and the formerly unrun serial successor. No application/test code or retry/timeout settings changed.
- These are overlapping invocations; **do not sum 129 and 12 as a unique-test count**. The rerun resolves the affected-file failure/skipped successor. Browser logs also contain a React hydration warning and standard color-variable warnings; passing test assertions do not establish those warnings were fixed.

The initial invocation finished **exit 1**, confirmed by the parent after recovering process session `4567`; its log records the fixture failure above. The complete-file rerun finished **exit 0**, confirmed by the parent from process session `82544`. Counts above are directly visible in the retained local logs. Logs are local verification artifacts, not public backups or tracked evidence content.

Executed browser command (local disposable credentials and session value redacted):

```sh
SESSION_SECRET=<local-test-only-value> NEXT_TELEMETRY_DISABLED=1 E2E_PORT=43223 \
E2E_DATABASE_URL=postgres://<disposable-user>:<disposable-password>@127.0.0.1:55433/synapse_kan213_e2e \
npx playwright test e2e/admin \
  e2e/features/control-panel-provider-keys.spec.ts \
  e2e/features/control-panel-session.spec.ts \
  e2e/features/ai-toggle-settings.spec.ts \
  e2e/features/development-setup.spec.ts \
  e2e/features/development-execution.spec.ts \
  e2e/features/development-history.spec.ts \
  e2e/features/development-evaluation.spec.ts \
  e2e/features/development-evaluation-tools.spec.ts \
  e2e/features/development-results.spec.ts \
  e2e/features/development-costs.spec.ts \
  e2e/features/s0-upload.spec.ts \
  e2e/features/s1-parse.spec.ts \
  e2e/features/s2-gap-extract.spec.ts \
  e2e/features/s3-tactic-extract.spec.ts \
  e2e/features/s6-partial-split.spec.ts \
  e2e/features/s10-timeline.spec.ts
```

The rerun used the same environment with database name `synapse_e2e`, and command `npx playwright test e2e/features/control-panel-provider-keys.spec.ts`. These placeholders describe the captured invocation; supply shell-quoted private values when using it locally.

## Dependency, security and scope scan

`rg -n 'src/accuracy|@/accuracy|/api/accuracy|/admin/accuracy|/accuracy' src package.json` completed exit 0 on 2026-11-03. Its three matches are the retirement guard in `src/modules/auth/gate.ts:27`, the deliberate presentation-slide exclusion in `src/lib/room/slides.ts:59`, and a historical copied-pattern comment in `src/components/breakouts/breakout-room.tsx:395`. No retired runtime import or benchmark command dependency was found by this scan.

`git diff --name-only 8708bbc9` and working-tree status show documentation-only edits/new Markdown files. Scoped diff inspection found no table drops/migrations, executable source edits, lockfile/dependency changes, removed tests, private source/artifact content or credentials introduced by this task. The protected-source inventory records metadata only. The parent repeated `git diff --check` and the same source scan after all local runtime checks, both exit 0 with the same three intentional source matches. Local source/scope review is complete for the documentation-only working tree. A published-head identity/CI check remains the parent's publication gate; this scan does not claim a general dependency vulnerability audit.

## Resource and limitation record

The parent created the exact owned container `synapse-kan213-verification`, published at **127.0.0.1:55433**, with databases `synapse_kan213_test`, `synapse_kan213_e2e`, and fixture-compatible `synapse_e2e`. The attached database volume is `71ab5d98c5928efac9f794455be01ffd1999b19fb323860075bda5ba73dcc619`. Its mount destination is `/var/lib/postgresql/data` (parent-confirmed container inspection). Browser server port: `43223`.

The parent confirmed `lsof` found no listener on browser port `43223` after the browser checks. Test process session `29191` completed exit 0. After verifying ownership with `docker inspect`, the parent successfully ran `docker stop synapse-kan213-verification`; subsequent inspection reported state `exited`. The attached volume is **retained**, not deleted. Exact container removal remains a parent action after PR acceptance; do not remove sibling/main resources or infer volume deletion. No shared/main resources were cleaned up.

At the local verification checkpoint on **2026-11-03**, the parent confirmed both remotes' `admin-accuracy-removal` branches point to `8708bbc9307c83bf04c5326266c849d0ebde12c6`; this confirms the parent baseline only. KAN-213 documentation has not yet been committed or published and no KAN-213 PR exists at this checkpoint.

Repository paths and historical DDL establish the retention inventory only. Actual private holdings, database row counts, filesystem permissions, backup identifiers and recovery usability remain unverified. No automatic migration, cleanup SQL, data disposal or retention deadline is introduced. Final publication identity and CI will be recorded by the parent in the PR/Jira, avoiding a self-referential commit identity in this document. Jira comment/Done transition and any next-ticket handoff remain the parent task's responsibility.
