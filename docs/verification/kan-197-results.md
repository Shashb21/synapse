# KAN-197 browser acceptance evidence

Recorded 2026-10-29 against `/private/tmp/synapse-kan197`, branch `fix/kan-197-actionable-errors`, baseline `6c75d0d9`. The browser acceptance work is verified by the 14-spec batch plus the bounded S0/S4 rerun below. All covered scenarios have passing evidence. This record does not claim whole-application, publication or Jira completion.

## Environment and command

Playwright used Chromium, one worker, the existing isolated test server configuration, provider stubs and empty provider credentials. The disposable database was `synapse_e2e` on loopback port `55497`; the browser server used port `43397`. The developer database was not used. The configured setup project signs in and each journey creates its own disposable workspace. Auxiliary workspaces created while testing a lost response are deleted only after verifying their exact id, name, creator and schema ownership.

```sh
E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_e2e \
E2E_PORT=43397 \
npx playwright test \
  e2e/features/kan-197-actionable-errors.spec.ts \
  e2e/features/control-panel-provider-keys.spec.ts \
  e2e/features/kan-115-next-action.spec.ts \
  e2e/features/kan-116-evidence-details.spec.ts \
  e2e/features/kan-117-source-suggestions.spec.ts \
  e2e/features/objective-priority-context.spec.ts \
  e2e/features/direct-gap-priority-context.spec.ts \
  e2e/features/supported-ai-priority.spec.ts \
  e2e/accuracy/accuracy-extract-continuation.spec.ts \
  e2e/features/observability-trace.spec.ts \
  e2e/features/s0-upload.spec.ts \
  e2e/features/s4-kg-mapping.spec.ts \
  e2e/features/kan-50-tactic-side-panel.spec.ts \
  e2e/features/shared-gap-panel.spec.ts \
  --project=chromium --output=/private/tmp/kan197-playwright-final-results \
  > /private/tmp/kan197-browser-final-regression.log 2>&1
```

Result: **exit 1; 69 passed, 2 failed, 2 did not run; 73 scheduled including setup; 2.8 minutes.** Log: `/private/tmp/kan197-browser-final-regression.log`. All nine direct KAN-197 acceptance cases, the historical API/SSR regression, observability and the additional tactic/gap panel suites pass. The two failures are stale S0/S4 copy expectations: they expected generic current-state wording, while the settled product returns the task-specific safe guidance quoted below. Their status and raw-text suppression checks remain unchanged.

After aligning only those two exact copy expectations, the two complete serial suites were rerun so the previously skipped follow-up cases execute:

```sh
E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_e2e \
E2E_PORT=43397 \
npx playwright test \
  e2e/features/s0-upload.spec.ts \
  e2e/features/s4-kg-mapping.spec.ts \
  --project=chromium --output=/private/tmp/kan197-playwright-final-stage-results \
  > /private/tmp/kan197-browser-final-stage-regression.log 2>&1
```

Result: **exit 0; 11 passed, no failures or skips; 10.4 seconds.** Log: `/private/tmp/kan197-browser-final-stage-regression.log`. These two runs provide passing evidence for all covered scenarios; no single all-green 73-test rerun is claimed. The browser worker changed only the two copy expectations before the bounded rerun. Initial sandbox execution could not start the local test server; authorized runs used the same disposable environment. A blocked attempt is not counted as test evidence.

## Direct acceptance evidence

All nine cases in `kan-197-actionable-errors.spec.ts` pass in that batch:

| Journey | Verified behavior |
|---|---|
| Owner control panel, three layouts | Injected raw SQL/provider text and sample secret stay out of page copy. Save retains the selected provider; the visible alert is at least 14 CSS pixels and does not overflow. Keyboard-activated Refresh configuration performs a real read and confirms availability while retaining the draft. A subsequent out-of-range temperature keeps its specific correction message and value. |
| Customer workspace creation, three layouts | The real workspace is persisted before its response is replaced with an untrusted failure. The name remains, Create and Cancel are disabled, New workspace cannot remount the form, and a DOM submit cannot issue another mutation. No owner-only navigation is shown. Keyboard-activated Check workspace list performs the real read/reload and finds exactly one workspace; the API list independently confirms that single persisted row. |
| Timeline partial save | A real schedule move succeeds; the following detail update is definitively rejected. The form retains dates and budget draft, disables every confirmed schedule control and explains the partial save. The saved end date is read back from plan state. Correcting budget sends only another detail update, with exactly one original move. Reload confirms both persisted date and budget. |
| Source ingestion | Upload and parsing really finish before extraction receives a raw failure. The title/text remain and recovery explains checkpointed continuation. Retrying reuses the same ingestion job and source-file row; the source is visible afterward. The direct database check verifies no duplicate file. |
| Historical owner run | Stored error, summary, and an appended error-bearing step contain the injected SQL/provider string and sample secret, including raw detail and an arbitrary nested provider payload. The real run-detail API and modules run-list response omit both strings while preserving run id, stage, error status and trace-step presence. The visible run trace shows fixed safe wording with `role=alert`; expanding every available diagnostic detail does not expose either string. Successful scientific traces and evaluations remain covered by observability regressions; deeper failed-LLM and Accuracy payload contracts have separate direct integration tests owned by the final fixer. |

The owner/customer cases use 1280×900 desktop, 390×844 narrow layout, and 1280×900 with `document.documentElement.style.zoom = "2"`. The latter is 200% CSS layout zoom; browser-menu zoom was not automated. Keyboard checks explicitly focus controls, press Enter and verify focus where relevant. Alerts/status roles are asserted; actual screen-reader speech was not tested.

Screenshots are attached under `/private/tmp/kan197-playwright-final-results` and saved under `/private/tmp/kan197-browser-*.png`. Representative inspected artifacts include `*-390px-customer-unknown.png`, `*-390px-owner-error.png`, `*-timeline-schedule-saved-details-rejected.png` and `*-historical-owner-error-redacted.png`. They are local verification artifacts, not public deployment evidence.

## Failures and bounded corrections

The earlier 12-spec batch (`/private/tmp/kan197-browser-regression.log`) finished **exit 1; 40 passed, 2 failed, 2 did not run; 44 scheduled including setup; 2.0 minutes**. It exposed a real product defect: S0 unknown demo id and S4 invalid `max_per_gap` returned the literal API error `Stage run failed`. The final fixer replaced that fallback with: “We couldn’t finish this AI task. Check the current workspace results before running it again. If this continues, contact your Synapse administrator.”

The final 14-spec batch verified that product correction but retained the old generic substring expectations, causing the same two tests to fail on copy alone. The test helper returns the actual API `error` field. Both expectations now require the entire settled task-specific sentence, while preserving HTTP 400 and assertions that the unknown demo id or internal contract error are not exposed. The bounded rerun passes both complete suites, including their serial follow-up tests. No behavioral assertion was removed or replaced with a generic truthiness check.

The existing observability regression now expects the same fixed historical guidance from list and detail readers, verifies the rejected request remains HTTP 400 and its run remains discoverable with the correct id/stage/error status, and checks the visible alert. It no longer expects the historical exception reason to be exposed.

Browser acceptance also found a genuine presentation defect: the historical owner alert was 12 CSS pixels. The authorized one-line correction uses existing `text-sm` and `role=alert`; the subsequent acceptance case passes at the required 14 CSS pixels. Earlier failures in the new test were fixture/locator corrections: use the valid `rwe_study` type, target schedule controls by stable form names, and identify the source text textbox by accessible role/name. These changes preserve the intended state and duplicate-request assertions.

Existing mocked-rejection retry tests now explicitly send `safe_error: true` and `request_outcome: "rejected"` when the route fixture guarantees no write happened. Tests of unknown raw failures keep untrusted envelopes and assert safe current-state guidance. This keeps known rejection retry separate from uncertain outcome handling.

## Static checks and remaining acceptance

`npx eslint` over all 14 touched browser specs and the historical owner run page with `--max-warnings 0` passed after the final copy updates, exit 0, no diagnostics; log `/private/tmp/kan197-browser-final-lint.log`. `git diff --check -- e2e 'src/app/admin/runs/[id]/page.tsx' docs/verification` passed, exit 0.

The two additional touched retry suites, `kan-50-tactic-side-panel.spec.ts` and `shared-gap-panel.spec.ts`, pass in the final 14-spec batch. The controller owns whole-application tests, final TypeScript/build checks, independent review, publication and Jira lifecycle. The message inventory distinguishes direct tests from reviewed source; room autosave, many Accuracy combinations, generic page retry and assistive-technology speech were not exhaustively induced by this browser task. These limits prevent claiming every runtime error branch has been tested.


## Final controller verification and delivery status

The independent whole-branch review and its scoped fix reviews approved both requirement compliance and code quality, with no Critical or Important findings remaining. The two final historical-reader test corrections were also independently approved: public readers require fixed safe guidance while direct storage checks retain the original diagnostic expectations.

Final local proof on 2026-10-29:

- `DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_test npx vitest run --project application`: exit 1; 229 files passed, 3 failed, 1 skipped; 2,335 tests passed, 6 failed, 10 skipped. Log: `/private/tmp/kan197-final-application-settled.log`. Three assertions in two files still expected raw historical exceptions; these were corrected while retaining original storage checks. The third file, KAN-86 final-package, hit the existing 20-second limit preparing a complete final plan, followed by two dependent failures.
- `DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_test npx vitest run --project application tests/kan-121-document-comparison.test.ts tests/modules-pipeline.test.ts tests/kan-86-final-package.test.ts`: exit 0; all 3 files / 69 tests passed in 116.82 seconds. Log: `/private/tmp/kan197-final-followup.log`. The KAN-86 freeze case passed in 17.049 seconds with its original timeout; no source or timeout changes were made for that failure. This is combined passing evidence, not one entirely green broad run. The slow shared-state fixture remains a test reliability limitation.
- Benchmark verification: 7 files / 180 tests passed, exit 0, in 416.90 seconds. Log: `/private/tmp/kan197-benchmark-verbose.log`.
- `npm run typecheck`: exit 0. Log: `/private/tmp/kan197-controller-typecheck-final.log`.
- `npx eslint . --max-warnings=-1`: exit 0; 0 errors, 16 warnings. Log: `/private/tmp/kan197-controller-lint-final.log`.
- `git diff --check`: exit 0.

At this checkpoint, GitHub access fails even from an escalated CLI call (`gh api repos/Shashb21/synapse --jq .full_name`: error connecting to api.github.com). The authenticated Jira connector also fails with a transport error reaching the MCP endpoint. These are external connection failures, not an approval rejection. Publication to both configured remotes, an open PR into main, latest-head CI, the Jira completion comment and a confirmed Done transition remain required. No merge, deployment, Done claim or next-ticket handoff is authorized by local verification alone. The last authenticated Jira state recorded in the ledger is In Progress.

## Resumed CI follow-up (2026-10-29)

PR #137's initial GitHub checks passed unit tests and static checks, but failed browser regressions. The follow-up distinguishes confirmed rejections from unconfirmed writes for customer/account validation and rolled-back workspace actions. Workspace replacement now includes contents, demo metadata and required audit insertion in one transaction. An injected audit failure proves both contents and metadata roll back. Stage input validation gives safe field-correction guidance, including the S5 rationale minimum, without exposing schema diagnostics or input values.

Browser fixtures for deliberate no-write failures now declare `safe_error: true` and `request_outcome: "rejected"`; unknown-outcome acceptance cases retain their duplicate prevention assertions. Learning controls are located by their current task names. The stale option test now seeds a separate gap: the preceding acceptance changes context and legitimately requires context review, which would confound the intended concurrent-proposal-edit scenario. Its selection, rationale and persisted-status assertions remain intact.

Fresh verification of the follow-up:

- `DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_test npx vitest run --project application tests/kan-197-errors.test.ts tests/kan-197-final-api-recovery.test.ts tests/kan-197-stage-validation.test.ts tests/kan-162-workspace-target.test.ts tests/kan-121-source-review.test.ts tests/modules-pipeline.test.ts`: exit 0; 6 files, 96 tests passed. Log `/private/tmp/kan197-resumed-focused.log`.
- `E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_e2e E2E_PORT=43397 npx playwright test e2e/features/decision-learning-admin.spec.ts e2e/features/tactic-option-audit.spec.ts --project=chromium --output=/private/tmp/kan197-browser-resumed`: 5 passed, 1 failed; both learning cases passed. The remaining failure reproduced the shared-context test setup problem described above.
- After isolating that setup, `E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_e2e E2E_PORT=43397 npx playwright test e2e/features/tactic-option-audit.spec.ts --project=chromium --output=/private/tmp/kan197-option-isolated`: exit 0; 4 passed, including setup, in 18.7 seconds. Log `/private/tmp/kan197-option-isolated.log`.
- `npm run typecheck`: exit 0; `/private/tmp/kan197-resumed-types.log`. Changed-file ESLint with `--max-warnings 0`: exit 0; `/private/tmp/kan197-resumed-lint.log`; the final tactic test edit also passed its separate lint check. `git diff --check`: exit 0.

The fresh full Vitest run uses a newly created disposable `synapse_kan197_verify` database on port 55497; its result and latest-head CI are still pending at publication of this follow-up. Jira remains In Progress until the required checks succeed. GitHub and Jira connectivity have recovered.

## Main conflict resolution (2026-10-30)

Merged main `71e2fda` (KAN-194 ordered backups and KAN-195 switch feedback) into KAN-197 at `55b2e05`. The three conflicts preserve the shared switch save hook, pending/confirmed state and accessible announcements, with `text-sm` error copy. Fallback validation preserves ordered duplicate rejection using `TrustedApplicationError` and safe correction guidance. The duplicate API test also verifies the stored route remains unchanged. The KAN-197 browser locator now uses the current business-first “Evidence gap extraction” heading; all recovery assertions are retained. Independent focused conflict review approved with no findings.

Fresh verification:

```sh
DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_kan197_verify \
npx vitest run --project application \
  tests/kan-63-admin-validation.test.ts \
  tests/kan-192-control-panel-load.test.ts \
  tests/kan-192-control-panel-recovery.test.ts \
  tests/kan-192-owner-context.test.ts \
  tests/kan-193-feedback.test.ts \
  tests/kan-193-server-state.test.ts \
  tests/kan-193-summary.test.ts \
  tests/kan-194-route-preview.test.ts \
  tests/kan-195-ai-switch-feedback.test.ts \
  tests/kan-197-errors.test.ts \
  tests/kan-197-presentation.test.tsx \
  tests/kan-197-route-regressions.test.ts
```

Exit 0: 12 files / 143 tests passed. Log: `/private/tmp/kan197-merge-tests.log`. The sandbox initially blocked local database connections; that attempt was stopped and is not counted as passing evidence.

```sh
E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55497/synapse_e2e \
E2E_PORT=43397 npx playwright test \
  e2e/features/ai-toggle-settings.spec.ts \
  e2e/features/control-panel-provider-keys.spec.ts \
  e2e/features/kan-197-actionable-errors.spec.ts \
  --project=chromium --output=/private/tmp/kan197-merge-browser-results
```

Exit 0: all 26 tests passed, including setup, in 44.3 seconds. Log: `/private/tmp/kan197-merge-browser.log`. The initial run passed 17 tests and failed on the outdated stage-heading locator (8 subsequent tests skipped); after updating that locator the complete batch passed. Desktop, 390px and 200% CSS layout zoom acceptance, keyboard recovery, unknown-write duplicate prevention, partial saves, resumable imports and historical error suppression are covered.

`npm run typecheck`: exit 0. Focused `npx eslint` on the two switch components, shared save hook, routing module, validation test and KAN-197 browser spec with `--max-warnings 0`: exit 0. `git diff --check`: exit 0. Static logs: `/private/tmp/kan197-merge-types.log` and `/private/tmp/kan197-merge-lint.log` (final browser locator also linted separately).

This is focused integration verification, not a fresh full application-suite run. Actual screen-reader speech and browser-menu zoom remain untested. PR #137 remains open; this conflict resolution does not merge it into main or deploy it. Jira was already Done when re-fetched for this follow-up.
