# KAN-255: paired Development release-run procedure

This procedure prepares an evidence run; it does not authorize a production release or make a model-quality claim. Use fictional examples in training and local verification. A real run may begin only after the named approvals below are recorded.

## What the current system already supplies

The existing Development workflow already keeps source generation and evaluator-only references separate, freezes source snapshots, module/prompt/code identities, routes, and prerequisite output identities. It supports two modes: `single_pass` (proposer only) and `standard` (proposer, critic, reviser, and internal judge). The worker persists raw calls and receipts, prevents uncertain automatic re-sends, and has an execution-level cost ledger. `buildComparison` checks paired source, output, route, profile, and evaluation compatibility. Development output remains `unreviewed`; an internal judge and provisional semantic reference score are not expert acceptance.

`summarizePairedReleaseEvidence` is the only KAN-255 addition. It consumes saved comparison evidence only. It reports descriptive per-mode/per-stage counts and ranges; it performs no generation, provider dispatch, database write, or acceptance decision.

## Required approvals before a real run

Do not use real customer or production state for this preparation. Before any release experiment, record all of the following:

1. An approved, de-identified held-out source cohort, its immutable document IDs and content hashes, and the frozen prerequisite state for S2, S3, S4, and S6.
2. Independent structured reference labels for each stage, with source provenance, label version/hash, expert reviewer identity or pseudonymous reviewer record, rubric version, conflicts, and adjudication outcome. These labels must not be supplied to generation.
3. A named experiment owner, exact provider/model/route snapshots, an explicit total USD allowance, and acknowledgement that a provider can report an unknown charge.
4. A KAN-181-approved acceptance rubric, thresholds, adjudication rule, and sign-off owner. KAN-255 cannot create these governance decisions.

## Budgeted paired procedure

Use an approved small number of repeats (for example, `R=3`; this is a planning placeholder, not an acceptance threshold). For each repeat `R1` through `R3`:

1. Create fresh Development executions from the *same* immutable source and prerequisite snapshots. Record experiment, execution, source/reference hashes, code identity, modules, prompts, and frozen routes.
2. Run one `single_pass` execution and one `standard` execution. The mode is the intended varying factor. Do not reuse an output from one mode in the other.
3. Use a per-execution allowance whose combined maximum is within the written release-experiment budget. Include the additional `critic`, `reviser`, and `internal_judge` calls, plus structural-repair and JSON-retry tails, in the standard-mode allowance.
4. Keep the existing one-send rule: never automatically rerun a `sending`, `needs_attention`, failed-settlement, or uncertain provider call. Record and investigate it. A fresh user-authorized attempt may charge again.
5. Start independent evaluation only after generation completes. Bind it to the exact saved output and the frozen independent reference snapshots.

Stop the planned comparison if a pair lacks a saved output, source/prerequisite lineage, compatible evaluator/profile/route snapshot, successful scored reference result, or known review provenance. Do not replace a failed pair to make the results look complete without recording the deviation and re-approving the protocol.

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

1. Run `buildComparison` for every saved pair, then pass those results to `summarizePairedReleaseEvidence`.
2. The helper refuses aggregation if a pair is incomplete or incomparable. It reports, by mode and S2/S3/S4/S6, trial count, latency min/max/range, matches, false positives, misses, known cost, zero-cost calls, and unknown-cost calls.
3. Treat `known_total: null` or any unknown-cost call as **unknown cost**, not `$0`. Obtain provider accounting or record the unresolved amount before asserting a budget total.
4. Do not calculate a significance claim from these few repeats. Report raw counts/ranges and all deviations.
5. KAN-181's approved rubric and human sign-off determine whether the evidence is acceptable. This runbook only establishes evidence traceability and accounting.

## Evidence missing today and KAN-181 handoff

There is no approved held-out cohort, verified expert-labelled reference set/adjudication record, selected production route/provider budget, or real paired run data in this change. The synthetic local test validates only deterministic accounting; it does not evaluate model quality, safety, usefulness, latency, or cost with a provider.

KAN-181 must provide the approved independent-label governance, acceptance thresholds, adjudication process, and final human acceptance decision. Preserve this run's execution/evaluation IDs, snapshot hashes, route/code identities, cost ledger, reviewer record, and any failures as the handoff package. No scheduled worker, live CI runner, production route, or provider configuration is changed by KAN-255.
