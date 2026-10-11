# KAN-4 earlier-version judge and parent acceptance review

Ticket re-fetched 2026-10-09; currently In Progress pending integration choice and Jira completion lifecycle. Working baseline 19ed756. All 15 criteria below were independently reviewed against current implementation. Produced versions follow existing early exits; missing versions are never invented.


The approved design keeps revisions sequential: V1 starts from V0, V2 starts from V1, and V3 starts from V2. Every produced snapshot has an independent assessment. The final extraction judge chooses an existing admissible whole snapshot, records its iteration and reason, and returns that snapshot’s exact content. A lost valid citation can therefore make V1 win over V3. Existing human mixed-item assembly remains a separate guarded workflow.

Earlier selection cannot remove unresolved omission blockers from either the chosen or terminal assessment. Invalid decisions and failed provider calls do not produce successful judgments. Selected-version quality is reported separately from requested loop depth and total run usage.

Historical KAN-43 review documents describe the baseline at their review date. This record supersedes their earlier-version-selection limitation with the implementation and controlled verification below. Controlled fixtures establish software behavior and lineage, not clinical accuracy or live-model quality.

| # | Exact criterion | Implementation and test evidence | Final verification |
|---|---|---|---|
| 1 | V0, V1, V2, and V3 are retained for every agentic evaluation run. | kernel/agentic.ts retains actually produced snapshots; accuracy-agentic-cycle.test.ts covers controlled depth and production early exit; accuracy-agent-events.test.ts checks exact persisted order. | Full Vitest: passed (197 files / 2,276 tests) |
| 2 | Each critic response is stored in a structured, machine-readable format. | kernel/agent-events.ts validates structured CriticIssue and critique events; accuracy-agent-events.test.ts checks strict writes and historical reads. | Full Vitest: passed (197 files / 2,276 tests) |
| 3 | Every revision records which critic issues were resolved, partially resolved, ignored, or judged invalid. | kernel/structural-fate.ts records an explained fate for every prior open structural finding; completeness/snapshot-inspector retains omission fates. Missing, malformed, duplicate or failed evidence remains unresolved. Resolved findings require a successful responsible exhaustive check; partial/invalid dispositions require independent evidence validation. accuracy-structural-fate and snapshot-completeness tests cover conservative transitions; experiment-records tests round-trip all disposition types. Ignored findings remain open with a reason rather than silently disappearing. | Full Vitest: passed (197 files / 2,276 tests) |
| 4 | Each iteration has its own evaluation record. | experiments/records.ts persists per-version evaluations; experiments/run.ts and extraction-pipeline.ts automatically score snapshots; accuracy-experiment-records.test.ts retains all call versions. | Full Vitest: passed (197 files / 2,276 tests) |
| 5 | Each V(n-1) → V(n) transition exposes delta/regression metrics. | eval/pass-comparison.ts compares exact recovered/lost reference keys with prior and V0, quote-invalid count increases, new invariant failures and content/evidence-matched serious critic findings; accuracy-pass-comparison.test.ts and pass-comparison-run tests exercise retained source transitions and all-version gates. | Full Vitest: passed (197 files / 2,276 tests) |
| 6 | Benchmark evaluation and production evaluation are explicitly distinguishable in the schema/API/UI. | Strict production event schema; experiment-gold.ts scores benchmark-only records; run-detail and experiment-results UI identify contexts. accuracy-agent-events, accuracy-experiment-run and results UI tests. | Full Vitest: passed (197 files / 2,276 tests) |
| 7 | Precision/recall/F1 are only emitted when an appropriate gold/reference set exists. | eval/experiment-gold.ts requires applicable reference pack and supported call shape; accuracy-experiment-gold.test.ts covers unscored inapplicable/malformed outputs; production strict-schema rejection tests. | Full Vitest: passed (197 files / 2,276 tests) |
| 8 | Production runs expose grounding, provenance, invariants, completeness/critic signals, and human-feedback metrics instead of fake gold metrics. | Quote validity, invariant and completeness records plus exact consumed-assembly operational feedback in assembly-feedback-store.ts and assembly-feedback.tsx; accuracy-agent-events and assembly-feedback store/UI tests. Recorded signals are not clinical accuracy. | Full Vitest: passed (197 files / 2,276 tests) |
| 9 | Existing reference-pack scoring can be attached automatically to benchmark runs. | experiments/run.ts and extraction-pipeline.ts call evaluateExperimentVersion for each retained output; accuracy-experiment-pipeline and experiment-run tests provide persistence proof. | Full Vitest: passed (197 files / 2,276 tests) |
| 10 | Experiment history is append-only and reproducible using source/gold/prompt/model/evaluator/code version metadata. | Existing append-only experiment records retain source/gold/evaluator inputs. kernel/execution-identity.ts adds actual rendered prompt hashes, provider configuration and available response revision, source/configuration hash and Git/build/deployment identity. observability checkpoints starts and failures; extraction-batch-store retains prepared/retried evidence behind its existing lease fence. execution-identity, experiment-records and experiment-pipeline tests verify identity, failure retention and complete exports. Historical unavailable identity remains unknown. | Full Vitest: passed (197 files / 2,276 tests) |
| 11 | A complete experiment can be exported as JSON. | experiments/records.ts and results-report.ts complete JSON exports; accuracy-experiment-records and experiment-results-api tests retain private evidence. | Full Vitest: passed (197 files / 2,276 tests) |
| 12 | Bulk experiments can be exported in an analysis-friendly format such as JSONL. | Same responsible export paths support JSONL; accuracy-experiment-records test exports tied records stably and compares parsed JSONL with JSON. | Full Vitest: passed (197 files / 2,276 tests) |
| 13 | The UI/API makes it possible to inspect progression across loops and compare V0/V1/V2/V3. | Run detail API/page and experiment-results UI expose progression; accuracy-agent-events detail tests and experiment-results UI tests. | Full Vitest: passed (197 files / 2,276 tests) |
| 14 | The final judge may select an earlier iteration if a later revision regresses. | Validated retained selection and extraction callers; selected-lineage integration and conservative omission consumers independently approved; real Postgres publication/history/assembly/authenticated exact approval/downstream V1 proof in tests/accuracy-selected-lineage-integration.test.ts. | Full Vitest: passed (197 files / 2,276 tests) |
| 15 | Tests cover persistence, versioning, loop deltas, regression detection, benchmark-vs-production metric separation, and export round-tripping. | Existing persistence, comparison, metric separation and export tests plus new selection/integration tests; final integrated run passed. | Full Vitest: passed (197 files / 2,276 tests) |

Operational limits: no production deployment, migration rollout, live-customer lineage, clinical accuracy or live-model quality is established by controlled tests. Default Turbopack build has local port-binding restriction; supported webpack baseline passed and must be rechecked after changes.

## Design rulings retained from independent acceptance review

- Extended the approved plan to cover structural issue dispositions and prompt/code identity because the parent criteria require them. This adds in-scope work; a mistaken interpretation would cost review and rework.
- Require a successful structural terminal assessment even when historical coverage lacks a judgment. Readable history alone cannot establish validation; older unresolved findings may remain reviewable.
- Retain valid evidence from malformed history while marking the overall history unavailable. Corrupt records cannot authorize comparison recommendations.

## Final verification (2026-10-09)

Verified in `/private/tmp/synapse-kan4-judge` on `codex/kan4-earlier-judge`, based on `19ed756a491c5d867a8a34dd831c1a120ebe3aaa`. No source edits occurred during the final full suite or browser checks.

| Command | Observed result |
|---|---|
| `caffeinate -diu -t 1800 python3 /tmp/kan4-timeout.py 1200 npm test` | Exit 0; 197 files / 2,276 tests passed; 869.88 seconds. |
| `E2E_PORT=43319 E2E_NEXT_DIST_DIR=.next/kan4-final caffeinate -diu -t 1200 python3 /tmp/kan4-timeout.py 900 npx playwright test e2e/accuracy/kan4-selected-experiment-results.spec.ts e2e/accuracy/kan83-stage-completion.spec.ts e2e/features/s6-partial-split.spec.ts e2e/features/s8-prioritization.spec.ts` | 16 passed in 3.8 minutes, including setup. The tool session was lost in a server restart, but the process survived; inspected complete log and `test-results/.last-run.json` (`status: passed`, no failed tests). OS exit code unavailable after restart. |
| `npm run typecheck` | Exit 0. |
| `npm run lint` | Exit 0; zero errors, three existing unrelated navigation warnings. |
| `npx eslint --max-warnings 0` over all 46 changed/new TypeScript/JavaScript files | Exit 0; zero warnings. File list collected from Git tracked diff plus untracked files. |
| `caffeinate -diu -t 900 python3 /tmp/kan4-timeout.py 600 npx next build --webpack` | Exit 0; production compilation, TypeScript and route generation complete. |
| `git diff --check` | Exit 0. |

The timeout helper only imposes an outer command deadline; temporary `caffeinate` prevents Mac idle sleep during long verification. Normal repository commands (`npm test`, `npx playwright test`, `npm run typecheck`, `npm run lint`, `npx next build --webpack`) reproduce the checks without these wrappers. Use an ignored `.next/...` custom browser output directory: unignored generated output can be scanned by Tailwind.

The pre-fix full suite passed 197 files / 2,264 tests. A subsequent browser run passed 15 tests and failed KAN-83 upload parsing because Next substitutes boolean `false` for an unset deployment ID. The responsible identity helper now validates runtime type before trimming. Captured red evidence was 1 failed / 17 passed with the original TypeError; green was 29 passed. An independent scoped review approved this fix. The final browser run above proves parsing proceeds through approval and guarded rollback.

Historical release concerns were rechecked: lint's former four errors were not reproduced; the webpack Node-only presentation dependency failure was not reproduced. Default `npm run build` still fails locally with Turbopack worker-port binding `Operation not permitted`; this is an environment restriction. The supported webpack production build passes. Failed, interrupted and moving-tree runs are not counted as final passing evidence.

Final whole-branch review: requirements Compliant, code quality Approved, no confirmed defects. Final narrow metadata-fix review: requirements Compliant, code quality Approved, no findings. Detailed independent reports are retained in `docs/kan4-independent-review.md`.

Criterion 13 additionally has browser proof of selected V1 versus produced V3 and JSONL regression retention. Criterion 14 has real Postgres proof of selected content through publication, version history, assembly, authenticated exact approval and downstream use. Existing KAN-83/S6/S8 browser scenarios passed after this change.

Implementation verification is complete; integration choice, Jira completion comment and successful Done transition remain separate lifecycle steps. No main merge, deployment, migration rollout or live-customer verification has been performed.
