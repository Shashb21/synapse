# KAN-255: paired Development release-run procedure

This procedure prepares an evidence run; it does not authorize a production release or make a model-quality claim. Use fictional examples in training and local verification. A real run may begin only after the named approvals below are recorded.

## What the current system already supplies

The existing Development workflow already keeps source generation and evaluator-only references separate, freezes source snapshots, module/prompt/code identities, routes, and prerequisite output identities. It supports two modes: `single_pass` (proposer only) and `standard` (proposer, critic, reviser, and internal judge). The worker persists raw calls and receipts, prevents uncertain automatic re-sends, and has an execution-level cost ledger. `buildComparison` checks paired source, output, route, profile, and evaluation compatibility. Development output remains `unreviewed`; an internal judge and provisional semantic reference score are not expert acceptance.

`summarizePairedReleaseEvidence` is the only KAN-255 addition. It consumes saved comparison evidence only. It reports descriptive per-mode/per-stage counts and ranges; it performs no generation, provider dispatch, database write, or acceptance decision.

## Required approvals before a real run

Do not use real customer or production state for this preparation. Before any release experiment, record all of the following:

1. An approved, de-identified held-out source cohort, its immutable document IDs and content hashes, and the frozen prerequisite state for S2, S3, S4, and S6.
2. Independent structured reference labels for each stage, with source provenance, label version/hash, expert reviewer identity or pseudonymous reviewer record, rubric version, conflicts, and adjudication outcome. These labels must not be supplied to generation.
3. A named experiment owner, exact provider/model/route snapshots, an explicit total USD allowance covering generation **and external evaluation** for every planned repeat, and acknowledgement that a provider can report an unknown charge.
4. A KAN-181-approved acceptance rubric, thresholds, adjudication rule, and sign-off owner. KAN-255 cannot create these governance decisions.

## Budgeted paired procedure

Use an approved small number of repeats (for example, `R=3`; this is a planning placeholder, not an acceptance threshold). For each repeat `R1` through `R3`:

1. Create fresh Development executions from the *same* immutable source snapshots. Record experiment, execution, source/reference hashes, code identity, modules, prompts, frozen proposer route, evaluator profile/route, and all execution/evaluation IDs. A saved execution or evaluator record may appear in one repeat only.
2. Run one `single_pass` execution and one `standard` execution. The mode is the intended varying factor. Do not reuse an output from one mode in the other.
3. Use existing estimate and cost-account reservations for each generation and evaluation request. Sum every planned repeat's single-pass, standard, external-evaluation, and allowed structural-repair/JSON-retry allowance before approval. If any saved generation or evaluation receipt has an unknown charge, stop budget-total reporting: do not state that the combined maximum is within budget until provider accounting supplies the missing amount or the owner records that the experiment is financially unresolved.
4. Keep the existing one-send rule: never automatically rerun a `sending`, `needs_attention`, failed-settlement, or uncertain provider call. Record and investigate it. A fresh user-authorized attempt may charge again.
5. Start independent evaluation only after generation completes. Bind it to the exact saved output and the frozen independent reference snapshots. For each expert review/adjudication, save a decision record containing the review ID, output ID, reference-item IDs, source/reference hashes, label/rubric version, reviewer records, both initial ratings, and final KAN-181 adjudication. The decision record is the handoff evidence; the current semantic evaluator remains explicitly provisional.

S2 and S3 can be compared as mode-only observations when their saved comparison reports compatible frozen source, reference, evaluator, and proposer-route identities. **Current limitation:** S4 and S6 run through the all-stage workflow generate mode-bound upstream output identities; they cannot be represented as a shared-prerequisite, mode-only comparison without changing production execution contracts. Record S4/S6 as paired end-to-end observations with their full lineage instead, and do not label them frozen-prerequisite comparisons.

Stop the planned comparison if a pair lacks saved output/source lineage, compatible evaluator/profile/route snapshot, or known review provenance. A valid empty-output observation is not a missing result: when the frozen reference has expected items and the generated output has none, retain it as an all-miss observation (zero recall, no precision denominator) alongside its expert adjudication. Do not replace a failed pair to make the results look complete without recording the deviation and re-approving the protocol.

## Stage-specific expert review instructions

Blind reviewers to mode where practical. They must work from the independent reference package, not an internal-model score, and record both false positives and misses.

| Stage | Expert checks |
| --- | --- |
| S2 gap extraction | Is each proposed gap grounded in a quoted frozen source? Identify unsupported/duplicated gaps (false positives) and independently labelled gaps absent from output (misses). |
| S3 tactic extraction | Check that each tactic is supported by the source, correctly characterized, and not an invented intervention; record missing reference tactics. |
| S4 matching/coverage | Review mapping relevance, coverage status, evidence links, and whether unsupported tactic-gap relationships were asserted; record unmapped reference relationships. |
| S6 partial splitting | Check the addressed/open division, residual claim, linked tactics, and source grounding; record spurious splits and reference splits that were missed. |

For every disagreement, record the two ratings and the KAN-181 adjudication decision. The terms **true positive**, **false positive**, and **miss** below describe agreement with the independent label set; they are not a claim of clinical or production correctness outside that label scope.

## Aggregate and decide

1. Retrieve each pair through the owner-only saved-comparison endpoint, then save the returned `comparison` objects in a local JSON wrapper with unique, operator-assigned `trial_id` values. For example, after authenticated retrieval from `/api/admin/development/comparison?left_experiment_id=…&left_execution_id=…&right_experiment_id=…&right_execution_id=…`, create `saved-comparisons.json` as:

   ```json
   { "trials": [
     { "trial_id": "R1", "comparison": { "left": { "execution": { "id": "saved-single-R1" } }, "right": { "execution": { "id": "saved-standard-R1" } } } },
     { "trial_id": "R2", "comparison": { "left": { "execution": { "id": "saved-single-R2" } }, "right": { "execution": { "id": "saved-standard-R2" } } } }
   ] }
   ```

   The abbreviated objects above show the wrapper only: each `comparison` must be the complete object returned by the endpoint. This endpoint reads saved records only and does not run a worker.
2. Run the offline-only command `npx tsx scripts/summarize-kan-255-release.ts saved-comparisons.json`. It reads that local JSON file and prints a summary; it makes no provider, database, route, billing, or remote call. The helper refuses aggregation if fewer than two complete pairs are supplied, a pair is incomplete or incomparable, execution evidence is reused, proposer settings differ between arms, or frozen controls drift. It prints explicitly labelled `provisional_reference` counts plus per-repeat `observations`, timing coverage, and generation-cost coverage; it does not present provisional evaluator counts as expert judgments. Current `buildComparison` represents an empty-output/all-miss reference assessment as unscored, so retain that valid observation and its expert decision record in the handoff package and report it separately; do not silently drop it or relabel it as missing evidence.
3. The summary is generation-call accounting only; external-evaluation charges must be read from the linked saved evaluation receipts/cost account and included separately in the budget ledger. Treat `known_total: null` or any unknown generation/evaluation charge as **unknown cost**, not `$0`. Obtain provider accounting or record the unresolved amount before asserting a budget total.
4. Do not calculate a significance claim from these few repeats. Report raw counts/ranges and all deviations.
5. KAN-181's approved rubric and human sign-off determine whether the evidence is acceptable. This runbook only establishes evidence traceability and accounting.

## Evidence missing today and KAN-181 handoff

There is no approved held-out cohort, verified expert-labelled reference set/adjudication record, selected production route/provider budget, or real paired run data in this change. The synthetic local test validates only deterministic accounting; it does not evaluate model quality, safety, usefulness, latency, or cost with a provider.

KAN-181 must provide the approved independent-label governance, acceptance thresholds, adjudication process, and final human acceptance decision. Preserve this run's execution/evaluation IDs, snapshot hashes, route/code identities, cost ledger, reviewer record, and any failures as the handoff package. No scheduled worker, live CI runner, production route, or provider configuration is changed by KAN-255.
