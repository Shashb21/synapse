# KAN-35 controlled pass comparisons

Approved in conversation on 2026-10-02; authority: Jira KAN-35 and the KAN-4 agent-loop design.

## Behavior

Run separate isolated extraction experiments with exactly one, two, and three feedback/revision exchanges. Retain V0 through VN and the existing terminal critic assessment and judgment. Disable the clean-critique early exit only for controlled experiments. Production depth, early exit, omission gates, and source workspace data remain unchanged. Gold stays evaluator-only.

Reuse the existing experiment records, copied workspace, module runs, and append-only agent events. A cohort is three separate attempts sharing a generated comparison ID and original request identity in condition metadata; repeating a cohort creates three new attempts. Actual source/baseline/pack/evaluator/module/route identities must match before attributed comparison. Detect and report mismatches rather than claiming a controlled result. Condition model/prompt labels are metadata, not execution overrides.

## Evaluation and safety

Report each extraction call and produced version: exact found/partial/missed/wrong outcomes; exact must-find keys recovered and lost relative to V0 and the prior version; retained quote/invariant/critic/completeness evidence; tokens, cost, and latency. Gold nonmatches alone are not evidence of source falsity. A serious source-support regression includes newly invalid quotes, newly failing invariants, or new high/critical non-omission findings explicitly categorized as false/unsupported/provenance problems. Retain reasons and source references. Existing invalid quotes/invariants or serious findings also prevent recommending the condition even if present at V0.

Failed/incomplete conditions and serious findings are ineligible. Missing assessment evidence, unchecked quotes, or failed completeness checks produce unknown eligibility and cannot win. Important omission findings are completeness risks, not false-claim findings. Exact must-find recovery and exact correctness outrank cost and latency; partial matches do not count as exact recoveries. Per-call outcome sums remain visible, but condition recommendations count distinct gold keys, qualified by extraction kind, across selected sources: recovering the same target in two documents cannot outrank recovering two different targets. A recommendation never changes production settings or constitutes deployment approval.

## Access and verification

Expose controlled single-call extraction and current extraction-pipeline cohorts through authenticated, workspace-scoped experiment APIs. Reject invalid pass counts and client-owned execution controls. Comparison reads must validate every experiment against the original source workspace. Recompute versioned comparison results from retained records and events; include all identities and reasons in returned JSON. Do not introduce a second recovery journal or overwrite prior experiments.

Use Vitest controlled proposers, including clean critics, to verify exact version counts, unchanged production behavior, three independent copies, reproducibility mismatches, failed runs, source safety, must-find recovery/loss, conservative eligibility, and quality-before-cost ranking. No paid model run is required to prove implementation behavior. Real benchmark findings require separately executed experiments.
