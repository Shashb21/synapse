# KAN-4 independent review evidence

Whole-branch review predates the final deployment-ID fix; the scoped report below covers that fix. Integrated verification is recorded in kan4-earlier-judge-validation.md.

# KAN-4 independent final review

Review scope: the complete tracked and untracked implementation in `final-review.diff`, against `19ed756a491c5d867a8a34dd831c1a120ebe3aaa`, plus the exact current Jira description, approved plan, acceptance matrix, verification record, and the existing integration owners named below. HEAD remained at the baseline during review. This review made no source, Git, database, Jira, or deployment changes and ran no test suite. Only this report was written.

## Verdict

**Requirements verdict: Compliant within the approved scope and the explicit qualifications below.** All 15 acceptance criteria have implementation and test coverage. Actual produced snapshots are retained; production early exits do not invent unused V1–V3 records. Execution metadata establishes traceable identity and comparison compatibility, not guaranteed replay of an unavailable provider revision or an unarchived dirty checkout.

**Code-quality verdict: Approved.** No Critical, Important, or Minor defect was confirmed in the reviewed change. The new selection decision is resolved against retained immutable content, omission consumers share one conservative resolver, and the work uses the existing persistence, publication, approval, and experiment owners.

**Release/completion verdict: Not yet established.** The stable full suite and integrated Playwright were still pending at the review cutoff. This is not permission to mark KAN-4 Done, publish, merge, or deploy. The parent must record the final stable integrated results and satisfy its remaining task lifecycle requirements. A failed or interrupted run is not passing evidence.

## Strengths

- `kernel/agentic.ts` separates a judge decision from output construction. A selector supplies only an existing iteration and a nonempty reason; the kernel checks admissibility and returns a clone of that exact retained draft. Invalid decisions and failed assessment/provider paths cannot append a successful judgment. Revisions still use the immediately preceding version.
- `modules/extraction-judge.ts` uses production evidence only. It excludes invalid quotes, structural failures, unavailable checks, and final-normalization failures, then compares coverage and omissions before structural score. Equal observed quality deliberately prefers the latest admissible version. Gold answers are not part of this decision.
- `domain/effective-assessment.ts` preserves findings from both selected and terminal versions. Choosing V1 does not erase V3's open omissions, and V3 cannot retrospectively close an omission in V1's different content. Missing historical judgment has a documented legacy path; a present malformed judgment has an invalid-lineage path. Ambiguous finding IDs cannot reuse a human decision.
- `kernel/structural-fate.ts` tracks findings by content and evidence rather than row position. Disappearance alone does not close a model finding. Closure needs a successful responsible exhaustive check or validated disposition; malformed, duplicated, absent, and failed evidence stays unresolved.
- `eval/pass-comparison.ts` distinguishes requested revision count, terminal version, selected version, selected-version quality, and total runtime usage. Regressions in unselected versions remain visible and can prevent recommendation. Missing execution identity, incomplete history, and incompatible conditions remain unknown or ineligible.
- `kernel/execution-identity.ts`, routing checkpoints, and preparation journals preserve rendered prompt hashes, provider configuration, available response identity, source/build identity, and interrupted/failed completion evidence. Journal evidence without a judgment cannot become reusable merge authority.

## Findings

**Critical:** None confirmed.

**Important:** None confirmed.

**Minor:** None confirmed. I have not promoted speculative performance concerns or pre-existing implementation style into findings without evidence of a defect.

The pending integrated verification is a release gate, not an inferred source-code failure. The accepted operational and semantic limits are listed separately below.

## Acceptance-criterion audit

| # | Exact Jira acceptance criterion | Independent assessment and evidence |
|---|---|---|
| 1 | V0, V1, V2, and V3 are retained for every agentic evaluation run. | Satisfied under the approved actual-produced-version interpretation. `kernel/agentic.ts` records each proposal/revision before assessment and selection; experiment controls support the requested depth. `accuracy-agentic-cycle.test.ts` and `accuracy-agent-events.test.ts` cover controlled depth, ordered persistence, and production early exits. Four-version lineage is exercised in `accuracy-selected-lineage-integration.test.ts`. An early exit has no fabricated versions. |
| 2 | Each critic response is stored in a structured, machine-readable format. | `kernel/agent-events.ts` supplies validated issue, critique, completeness, and structural-fate shapes; `agentic.ts` persists them for every assessed version, including a failed structural assessment before throwing. Strict writes and historical compatibility are covered by agent-event tests. |
| 3 | Every revision records which critic issues were resolved, partially resolved, ignored, or judged invalid. | `structural-fate.ts` records one explained disposition for each prior open structural finding; the completeness inspector retains omission dispositions. Ignored findings remain explicitly unresolved. Structural-fate tests cover all four outcomes, responsible deterministic reruns, positional changes, and malformed/duplicate/missing/failed evidence; experiment-record tests round-trip the outcomes. Historical absence is explicitly unavailable. |
| 4 | Each iteration has its own evaluation record. | `experiments/run.ts` and `experiments/extraction-pipeline.ts` retain each snapshot and call `evaluateExperimentVersion`; `experiments/records.ts` appends version-bound evaluations. Production snapshots separately retain quote/invariant/completeness observations without pretending they have gold scores. Experiment run/pipeline/record tests cover version persistence. |
| 5 | Each V(n-1) → V(n) transition exposes delta/regression metrics. | `eval/pass-comparison.ts` compares gold item keys with the prior version and V0, records gained/lost findings, quote and invariant regressions, content/evidence-based serious findings, and cumulative metering. Pass-comparison and comparison-run tests cover these deltas and all-version regression gates. The retained fate records support analysis of resolved/partial/invalid/unresolved issues. This is not a claim that every semantic regression can be detected. |
| 6 | Benchmark evaluation and production evaluation are explicitly distinguishable in the schema/API/UI. | Explicit evaluation context is retained in run/events; isolated experiment records and gold evaluation remain separate. Run detail and experiment-results presentation expose the context. Agent-event and experiment tests cover separation. |
| 7 | Precision/recall/F1 are only emitted when an appropriate gold/reference set exists. | `eval/experiment-gold.ts` checks pack/call applicability and output validity; it emits scored results only for supported applicable reference data. Inapplicable and malformed cases return explicit unscored/error states. Production strict-schema tests reject gold fields. No gold input was added to the production selector. |
| 8 | Production runs expose grounding, provenance, invariants, completeness/critic signals, and human-feedback metrics instead of fake gold metrics. | Snapshot signals, structured critiques, completeness assessments, and assembly-bound operational feedback remain separate from benchmark accuracy. `assembly-feedback-store.ts` and the feedback UI remain the responsible owners of human feedback tied to consumed output. Selected/terminal omission presentation and invalid-lineage blocking are added without relabeling acceptance as accuracy. |
| 9 | Existing reference-pack scoring can be attached automatically to benchmark runs. | Both experiment execution paths call `evaluateExperimentVersion` for retained versions. Record creation validates evaluator, pack fingerprint, call kind, and workspace lineage. Experiment-run and pipeline tests exercise automatic attachment; gold remains evaluator-only. |
| 10 | Experiment history is append-only and reproducible using source/gold/prompt/model/evaluator/code version metadata. | `records.ts` inserts immutable call/evaluation children under a running-experiment lock; terminal status is the bounded mutable field. Baseline/source/gold/evaluator metadata is retained. New execution identities include exact rendered prompt hashes, configured/response provider identity, source/configuration hashes and available Git/build/deployment identity. Execution, record, and pipeline tests cover failures, retries, corruption, and exports. Qualified: hashes identify bytes, they do not archive dirty source or recreate a provider revision that was not supplied. Historical unknowns are not upgraded. |
| 11 | A complete experiment can be exported as JSON. | `records.ts` reads workspace-scoped calls/evaluations plus complete per-call progression and execution evidence, including preparation evidence when runtime is absent. JSON exports use that same complete record. Record and API tests cover retained evidence. |
| 12 | Bulk experiments can be exported in an analysis-friendly format such as JSONL. | JSONL uses the same records and stable ordering as JSON. Record tests parse JSONL and compare with JSON, including tied creation times and private execution evidence. |
| 13 | The UI/API makes it possible to inspect progression across loops and compare V0/V1/V2/V3. | Run detail exposes progression and structural fate; experiment results display selected versus terminal version and whole-run cost. Existing detail/results tests plus the new browser scenario exercise presentation/export agreement. The browser scenario is a controlled response fixture; real persistence is covered separately. |
| 14 | The final judge may select an earlier iteration if a later revision regresses. | The retained selector and both extraction modules implement this. Unit/module tests cover earlier and latest winners, invalid candidates and source evidence, nonexistent/malformed decisions, exact returned content, and failure paths. The new Postgres integration fixture follows V1 defeating V3 through publication, honest normalized final lineage, assembly creation, authenticated exact approval, and downstream consumption. This applies to the approved extraction scope; legacy non-extraction judge callers retain their existing behavior. |
| 15 | Tests cover persistence, versioning, loop deltas, regression detection, benchmark-vs-production metric separation, and export round-tripping. | The named agent-event, agentic-cycle, structural-fate, extraction-judge, module, omission-review, selected-lineage, execution-identity, experiment-record/pipeline, pass-comparison, API/UI, and browser tests cover these behaviors. Test presence and assertions were reviewed; final integrated success is withheld pending the parent's stable run and browser evidence. |

## Integration boundaries checked

Selection to publication remains explicit: the kernel returns the retained raw draft; extraction normalization assigns public IDs and removes draft-only fields; `publishGeneratedItemHistory` preserves raw origins and adds a judged-final origin when normalized content is not exactly a raw item. `assembly-generation.ts` resolves exact persisted payloads and prefers the selected raw origin only when it really matches. The integration test checks both raw V0–V3 retention and the normalized final origin rather than assigning a misleading raw snapshot ID.

Approval remains owned by `assembly-review-store.ts` and the authenticated assemblies route. The route derives reviewer identity from the session and checks workspace authorization. The store rechecks the exact body/check fingerprints and expected prior review under its workspace lock. `approvedLiveInventory` resolves the current production head and successor, requires complete passing checks and a matching approval, and prevents stale content from becoming live. `listDownstreamClaims` continues to read this approved inventory before applying its type/source filters and limits. The new test rejects unsigned, stale-fingerprint, and stale-competing decisions.

Managed human edits, mixed-item selection, and inverse operations remain separate from automatic whole-snapshot judgment. Existing revision ownership creates immutable successor assemblies; current-head lookup prevents old approval fallback. Managed split rollback rejects copied archival operations and later conflicting changes and returns a fresh assembly requiring approval. The change does not introduce an alternate approval, rollback, or live-inventory owner.

Omission listing, details, mutation, and downstream pause use the shared effective-assessment resolver. Both selected and terminal evidence remain visible. Invalid current selected lineage pauses downstream even when there is no invented omission to display. Incomplete or failed newer coverage cannot silently supersede older reviewable evidence. Human decisions remain protected by source/run/evidence identity; ambiguity is not resolved by choosing whichever observation arrived last.

Experiment copying retains typed remapped audit history with `baseline_origin`; `copy-workspace.ts` and `baseline-history.ts` strip managed live authority. No new code copies production approval into experiment authority. Source/tenant filters remain in record/progression/journal reads. Paging, source evidence validation, human locks, manual/AI-off behavior, and automatic pending coverage have no replacement path in this change; their existing owners remain responsible.

Provider calls remain outside database transactions. Recorder checkpoints reject transaction use; the preparation callback stores audit evidence behind the existing reservation fence. Successful prepared judgment and incomplete preparation evidence have distinct types and authority. Node-only fingerprint dependencies are used in server code; the experiment-results component imports comparison types with `import type`. The parent reports a passing webpack production build, which is additional evidence against a client-bundle leak.

## Verification evidence and remaining gates

At the last read, `final-verification.md` reports passing `npm run typecheck`, full lint with three pre-existing unrelated navigation warnings, zero-warning lint over 46 changed/new JS/TS files, `git diff --check`, and authorized `npx next build --webpack`. Default Turbopack failed on local worker-port permissions. The exclusive recheck of 14 earlier timeout files passed 169 tests.

Earlier full runs were restricted, moving-tree, or interrupted and do not establish stable integrated success. The parent subsequently reported repeated Mac sleep intervals explaining very long wall-clock timeouts, termination/reaping of its owned interrupted run, and a fresh unchanged-deadline full suite under `caffeinate -diu`. That report is diagnostic context, not a passing test result. Integrated Playwright remains a separate gate after database tests. No tests were rerun by this reviewer, avoiding shared database contention.

To verify completion, record the fresh full-suite exit code/counts and the integrated Playwright result against the reviewed tree, update the acceptance matrix's pending entries, and preserve the already recorded build/type/lint evidence. If code changes are needed, review the resulting diff and rerun the smallest affected checks plus any required integrated gate.

## Explicitly declined judgments and material limitations

- I do not judge deployment, migration rollout, live-customer end-to-end lineage, dual-remote publication, or Jira completion: none was performed or evidenced by this review.
- I do not claim the final full suite or integrated Playwright passed: those results were pending at cutoff. Prior scoped reviews and tests are supporting context, not substitutes for these gates.
- I do not infer clinical accuracy, live-model semantic quality, or an optimal selection policy from scripted providers and controlled source fixtures. They demonstrate software behavior and lineage. Ranking observed coverage/omission evidence is a documented policy, not a proof that the chosen content is objectively best.
- I do not claim true production precision, recall, or F1. No-gold production checks and human interaction categories remain operational signals; human acceptance is not correctness.
- I do not claim byte-for-byte replay of remote inference. Provider revision can be absent, source hashes do not preserve uncommitted source bytes, and metadata cannot guarantee provider determinism. Historical unavailable evidence remains unknown and cannot authorize comparison recommendations.
- I do not require nonexistent V1–V3 versions after an approved production early exit, nor new earlier-selection behavior for every legacy non-extraction judge caller. These are the explicit scope decisions in the review contract and approved plan.
- I do not claim comprehensive semantic regression detection or new stage-specific adjudicated gold datasets. Existing deterministic/reference/model-based checks have their stated limits; this change does not turn model judgments into ground truth.
- I did not independently execute every unchanged approval/copy/rollback/manual-mode path. I inspected their responsible integration boundaries and relevant test assertions for compatibility with the changed selection/evidence paths; final regression execution belongs to the parent.
- I did not benchmark synchronous source fingerprinting or large-history query scalability. No measured failure was provided or observed; no speculative defect is asserted.
- KAN-17 and unrelated product work remain outside this review. No new optimization/early-stopping policy or automatic prompt promotion is endorsed here.


# KAN-4 deployment identity fix — scoped independent review

**Requirements verdict: Compliant. Code-quality verdict: Approved.** No Critical, Important, or Minor defect found in this fix. The prior whole-branch review remains applicable; this review does not repeat it or establish integrated release success.

Reviewed `final-fix-request.md`, `final-fix.diff`, `final-fix-controller-recovery.md`, the actual `src/accuracy/kernel/execution-identity.ts`, and the added tests in `tests/accuracy-execution-identity.test.ts`. Also read the installed Next deployment-ID guide and confirmed the actual substitution in `node_modules/next/dist/build/define-env.js:94`: Next can replace `process.env.NEXT_DEPLOYMENT_ID` with boolean `false` when the deployment identifier is absent. No tests, source edits, Git changes, or database operations were performed by this reviewer. Only this report was written.

## What changed and why it is correct

At `src/accuracy/kernel/execution-identity.ts:94`, the implementation now reads the optional identifier once and calls `.trim()` only when its runtime type is string. Optional chaining in the previous expression guarded null/undefined, but did not prevent calling a nonexistent string method on boolean `false`. The explicit type check fixes that precise failure in the responsible metadata layer.

Absent, boolean, numeric, object, null, empty, and whitespace-only values become `null`. The implementation does not convert boolean `false` into the string `"false"`, so missing deployment metadata cannot create an available identity by itself. A deliberately supplied nonempty string, including the literal string `"false"`, remains a valid string identity under the existing contract; padded strings are trimmed. Source, prompt, build, Git, and compatibility logic are unchanged, and no deployment configuration or fallback was introduced.

## Acceptance and test assessment

- The dedicated false-value regression at `tests/accuracy-execution-identity.test.ts:20` checks the entire unavailable identity result. It would throw under the previous implementation. It substitutes the global process object because assigning a boolean directly to Node's real `process.env` coerces it to a string and would miss the reported failure.
- The parameterized cases at line 28 exercise missing/null values, several nonstring values, blank strings, supported strings, trimming, and the distinction between boolean false and literal string `"false"`. They verify both the stored deployment ID and whether metadata alone incorrectly creates available authority.
- The regression at line 46 creates real temporary source/prompt/build fixtures and compares identities and compatibility with an absent versus boolean-false deployment ID. It establishes that rejecting invalid optional metadata does not discard independently available identity. Git behavior is unchanged by the source diff; the empty temporary checkout retains null/unknown Git fields.
- The existing `afterEach` restores globals/environment and removes temporary directories, preventing the process substitution from leaking into later tests. The fix changes no deadlines and weakens no assertions.

## Verification boundary

The controller recovery record reports the completed identity suite with **29 passing tests**, typecheck exit 0, and scoped lint exit 0. The delegate's final report was not produced. The supplied recovery record does not retain the exact commands, inspected red-test output, or a distinct diff-check result, so I do not claim to have independently verified those missing execution details. The regression's ability to expose the original failure is clear from the old expression and its boolean input; that is source analysis, not an assertion that I observed a red test run.

The parent should retain its available captured command/output evidence and complete its separately planned integrated checks. In particular, rerun the affected browser parse workflow through the compiled Next application to verify that execution identity no longer aborts upload/parse. The narrow unit tests simulate Next's value substitution; they do not themselves execute the Next compiler or prove browser end-to-end success.

The earlier full-suite result of 197 files / 2,264 tests and the pre-fix browser result of 15 passes / 1 failure are context from the request, not final post-fix integrated evidence. I do not infer deployment, Jira completion, live accuracy, or release readiness from this scoped approval.


Controller evidence supplement: inspected captured exact red command `python3 /private/tmp/kan4-timeout.py 120 npx vitest run tests/accuracy-execution-identity.test.ts`, exit 1 (1 failed / 17 passed; original trim TypeError), followed by the same command exit 0 (29 passed). Scoped ESLint and typecheck exit 0. Parent final full suite and browser proof are in the validation document.
