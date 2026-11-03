# KAN-212 retirement classification

The inventories below describe destinations after retirement. No records, private sources, artifacts or audit history are migrated or deleted.

## KAN-210 capabilities

| Inventory row | Destination |
| --- | --- |
| Workspace, private uploads and parsed source setup | Development experiment setup selects a customer workspace or private uploads and freezes source identities. Reuse `development-setup.tsx`, `documents.ts` and owner APIs rather than creating an Accuracy workspace for each model comparison. |
| Current customer generation and route/role experiments | Existing execution controls run `gap_extraction`, `tactic_extraction`, `matching_coverage`, `partial_splitting`, with frozen requested/actual routes, single-pass/standard modes and AI-off checks. Historical stage names are not interchangeable with these stages. |
| Saved-output scoring and evaluator/reference configuration | Existing Development evaluation controls and profiles associate evaluator-only references and immutable scores with saved output identities. References do not become generation input. |
| Model/configuration comparison and selection evidence | `development-comparison.tsx` compares saved experiments/executions and supports explicit configuration copying. No model is selected or deployed automatically. |
| Generation results, raw replies, failed attempts and diagnostic history | `development-results.tsx` and execution/evaluation histories retain candidates, issues, raw call evidence, provenance, progress and failures. This reuses the current pipeline's record model. |
| Provider-cost estimates, usage, allowance, unknown-charge acknowledgement and corrections | Existing execution spending controls and ledger keep budgets execution-local and distinguish known usage from owner reports. Experiment choices do not write shared live settings. |
| Owner access, source isolation, frozen routes and AI-off protection | Existing Development owner gates, selected source snapshots and section availability checks already enforce these boundaries; the new tools page calls the same owner page gate. |
| Accuracy-specific control/routing and observability screens as another model-selection console | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Accuracy workshop scenes, facilitator actions/tags and readiness screens | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Accuracy planning, prioritization, ideation, status derivation, Gantt and final-plan screens | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Historical local full-matrix benchmark and human-gold review | `src/modules/development/evaluation/benchmark/`; `npm run benchmark:kan100 -- <prepare/run/review> ...` preserves historical `need_extract`/`inventory_extract`, arguments, private artifacts, budget rules and human review. It remains separate from the customer worker. |
| Historical saved-run review/report/CSV browser viewer | Local no-paid CLI review and retained JSON/Markdown/four CSV outputs are preserved. The tools page explains access; it does not read arbitrary private artifacts. A browser result adapter and stage mapping need a separately defined contract. Current Development result history is not claimed to display these historical runs. |
| Historical extraction prompts and completeness audit identity | `evaluation/historical/` contains exact copies of the pure original implementations. Compatibility tests freeze their identities; Development evaluator prompts are not silently substituted. |
| Committed reference-pack loading and source recall helpers | `evaluation/reference-gold.ts` and `pack-recall.ts` retain pack-per-pack behavior and evaluator-only gold. Gold-file lookup still requires repository-root working directory; ideated tactics remain excluded from source recall. |
| Existing Accuracy reference import names | Retire compatibility imports; callers use Development evaluation helpers directly. |
| Discoverability of retained historical tools | Owner-only `/admin/development/evaluation-tools` is linked from Development and Evaluation. It explains current versus historical scope and local commands, without provider dispatch or private-file APIs. |

## KAN-211 controls

| Inventory row | Destination |
| --- | --- |
| Accuracy provider, model, temperature, max tokens, backups per call kind/role | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Accuracy default provider | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Customer stage provider/model, temperature, max tokens, backups | Existing AI & routing. KAN-211 persists through actual POST, resolves a fresh customer route and observes raw provider parameters. KAN-63 validates numeric strings/bounds, fallback lists, unknown providers/models and stages; KAN-193 verifies credential selection order and no invented backup. |
| Accuracy module activation | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Customer module activation | Existing AI & routing; KAN-89 proves attributed activation audit. Strengthened KAN-202 test seeds a real S2 activation row and compares all rows after both experiment modes. |
| Accuracy workspace, organization and planning context | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Accuracy workspace slug | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Accuracy archive/unarchive | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Accuracy plan label and planning context | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| UI workspace, tab/filter and route-field selections | Retire legacy runtime and UI. Preserve stored records unchanged; future experiment controls and workflows belong to Development. |
| Benchmark corpus, model list, hashes, scoring/acceptance and budget | Development experiment configuration and comparative spending; retain old config/results. No live budget endpoint exists here. Do not create one for this ticket. |
| Development stage/role routes, Standard/Single pass, evaluator and cost allowance | Existing Development. Strengthened KAN-202 Standard and Single pass test supplies explicit role changes, scripts actual provider adapters and compares nonempty `routing_config`, `accuracy_routing_config`, `platform_settings`, `stage_modules` snapshots. |
| AI master switch and section switches | AI & routing remains owner; Development may read/enforce, never change. KAN-53 covers AI-off sections; KAN-202 tests rechecking immediately before sends/repairs. Seeded snapshots prove experiment execution preserves switches and update metadata. |
| Provider API keys and status | Keep deployment environment and existing status displays. No secret copying, database storage or new control. KAN-211 tests unavailable primary fails closed or uses only an explicitly configured backup, preserving saved rows. |
| Anthropic workspace ID | Deployment environment; not an experiment routing override. Keep one adapter for both consumers. |
| LLM timeout and test environment | Keep environment ownership. KAN-211 spies `isTestStub` false for real credential resolution and scripts provider adapters; all unscripted fetches throw. Never deploy test bypass flags. |
| Model price table, cost computation, cost display | KAN-209 already relocated shared cost helpers into `modules/llm/cost.ts`; preserve shared helpers and consistent unknown-cost semantics; retire Accuracy compatibility exports. `tests/llm-cost.test.ts` and `tests/kan-206-costs.test.ts` cover prices/provenance and allowance handling. No new pricing switch or spending surface. |
| Source quote validation helpers | KAN-209 already relocated shared quote validation out of Accuracy. Preserve semantics and historical artifact compatibility. Source validation is not a route control. |
| Prompt identity/version and historical runs | Keep existing revision governance and exact provenance. Do not migrate/delete or silently promote experimental prompts. KAN-202 tests immutable manifests, replay, exact prerequisite identities and independent evaluator changes. |
| Authorization and change history | Preserve existing enforcement. KAN-211 tests non-owner writes leave routes/audits unchanged and valid edits record real before/after attribution from the actual request context (demo principal under the existing test owner bypass, rather than trusting the body name), while retaining previous events. KAN-63 covers actual signed-in owner/customer access; KAN-89 covers customer route/default-provider/module attribution; historical Accuracy audit records remain intact. |


## Caller and test classification

The retired runtime, UI and API routes have no remaining production callers. Exact `/accuracy` and `/api/accuracy` paths and their descendants return 404; Admin descendants go through the existing owner gate before 404. Similarly named paths retain their normal routing. Development owns the retained benchmark and reference helpers; its historical names and references are compatibility data, not calls into the retired runtime. Database tables and audit records remain untouched.

Mixed suites retain customer execution, authorization, recovery, shared audit history and AI harness checks. The reference manifest, local parser, gold and pack-recall tests remain. KAN-202 and KAN-211 use a synthetic legacy routing table to verify experiment isolation without reviving the runtime. New boundary and browser tests exercise retired routes.

The following tracked Accuracy-only tests and their fixtures were retired with their implementation (their history remains in Git):

- `e2e/accuracy/accuracy-extract-continuation.spec.ts`
- `e2e/accuracy/accuracy-gantt-save-final.spec.ts`
- `e2e/accuracy/accuracy-happy-path.spec.ts`
- `e2e/accuracy/accuracy-ledger-filters.spec.ts`
- `e2e/accuracy/accuracy-llm-parse.spec.ts`
- `e2e/accuracy/accuracy-shell.spec.ts`
- `tests/accuracy-completeness-audit.test.ts`
- `tests/accuracy-completeness-llm.test.ts`
- `tests/accuracy-cost-provenance.test.ts`
- `tests/accuracy-cost-rollup.test.ts`
- `tests/accuracy-coverage-assist-api.test.ts`
- `tests/accuracy-coverage-decide.test.ts`
- `tests/accuracy-coverage-queue.test.ts`
- `tests/accuracy-coverage-schema.test.ts`
- `tests/accuracy-extract-api.test.ts`
- `tests/accuracy-extract-continuation.test.ts`
- `tests/accuracy-extract-gate.test.ts`
- `tests/accuracy-gantt-activity-detail.test.ts`
- `tests/accuracy-gantt-board.test.ts`
- `tests/accuracy-gantt-continuity.test.ts`
- `tests/accuracy-gantt-export-svg.test.ts`
- `tests/accuracy-gantt-project.test.ts`
- `tests/accuracy-gantt-read.test.ts`
- `tests/accuracy-gantt-save-final.test.ts`
- `tests/accuracy-hygiene.test.ts`
- `tests/accuracy-ideate-api.test.ts`
- `tests/accuracy-ideate.test.ts`
- `tests/accuracy-iegp-semantics.test.ts`
- `tests/accuracy-inventory-extract.test.ts`
- `tests/accuracy-ledger-filters.test.ts`
- `tests/accuracy-merge-dedupe-llm.test.ts`
- `tests/accuracy-merge-dedupe.test.ts`
- `tests/accuracy-merge-status-store.test.ts`
- `tests/accuracy-need-extract.test.ts`
- `tests/accuracy-parse-block-preview.test.ts`
- `tests/accuracy-review-miss-flags.test.ts`
- `tests/accuracy-routing-defaults.test.ts`
- `tests/accuracy-run-api-key.test.ts`
- `tests/accuracy-run-retention.test.ts`
- `tests/accuracy-seed-from-gold.test.ts`
- `tests/accuracy-source-upload.test.ts`
- `tests/accuracy-status-engine.test.ts`
- `tests/accuracy-upload-formats.test.ts`
- `tests/accuracy-validation-gate.test.ts`
- `tests/accuracy-workshop-v1.test.ts`
- `tests/ai-off-accuracy-manual.test.ts`
- `tests/ai-off-accuracy-routes.test.ts`
- `tests/kan-161-workshop-scene.test.ts`
- `tests/kan-183-provenance.test.ts`
- `tests/kan-186-claim-selection.test.ts`
- `tests/kan-189-plan-versions.test.ts`
- `tests/manual-accuracy-edits.test.ts`
- `tests/manual-blocks-accuracy.test.ts`
- `tests/support/accuracy-evidence.ts`
- `e2e/support/accuracy.ts`

Mixed-test changes: KAN-61 drops Accuracy workspace, mutation, routing, display and audit assertions while retaining malformed Admin harness JSON and AI-off harness checks; `owner-console` drops Accuracy navigation, API and old redirects while retaining customer authorization and remaining redirects; `ai-off` drops the Accuracy manual-flow browser case while retaining customer manual flow and AI-switch checks. KAN-197 drops Accuracy-only page, API and historical fixture cases while retaining customer recovery, presentation and shared failure-history checks. AI-switch, owner-gate, KAN-89, parser and kernel-run suites retain their customer/shared assertions and drop only Accuracy-specific calls. Reference/pack tests now import Development helpers. The dedicated retirement tests replace old URL behavior assertions with 404 and authorization checks.

Residual references are intentional: historical names and frozen prompts, benchmark compatibility and documentation, database table identifiers and preserved audit/record data, synthetic test fixtures for isolation, and the retired path boundary tests. None dispatches through the removed Accuracy runtime.

## Verification completed 2026-11-03

- Independent task review and fresh whole-branch review: requirements and code quality/security/regression approved; all minor findings resolved.
- `DATABASE_URL=<dedicated KAN-212 test database> npx vitest run`: exit 0, 214 files passed / 1 skipped; 2,463 tests passed / 10 skipped. Includes all eight KAN-100 benchmark files. The existing skips require larger database connection pools for concurrency scenarios; no skips were added by this change.
- `npx tsc --noEmit` and `npm run typecheck:kan100`: exit 0.
- `npx eslint . --max-warnings=-1`: exit 0, zero errors and 17 warnings.
- Isolated Playwright run covering retirement, owner console and AI-off: 29 passed. After strengthening the anonymous fixture and splitting a long serial request case, final retirement rerun: 10 passed in 24.4 seconds without retries. No timeout or retry limit increased.
- Production import scan found no executable Accuracy imports or command paths; `git diff --check` passed.
- Temporary container `synapse-kan212-verification` (127.0.0.1:55432, databases `synapse_kan212_test` and `synapse_kan212_e2e`) stopped after checks. Attached volume `d320ea280b393c2ba33b4856bbce2bbd810ec52b3dbea24f4e8c9d727ee49b54` retained; exact container removal remains pending PR acceptance. Playwright-owned servers stopped automatically.

Initial worktree dependency-link failures were resolved with a local dependency copy. An unsplit browser case timed out once and passed on its configured retry; the final split cases passed without retries. These are local verification limitations/history, not waived failing checks. Latest-head CI remains a separate publication gate recorded on the pull request.
