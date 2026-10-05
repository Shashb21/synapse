# KAN-40: benchmark exact mixed selections through the downstream pipeline

Status: written specification approved by the user on 2026-10-05. Implementation plan pending review.

Issue: [KAN-40](https://synapse21.atlassian.net/browse/KAN-40), under [KAN-4](https://synapse21.atlassian.net/browse/KAN-4).

Starting implementation: KAN-39 commit `9f3d53c26fd28edf8d4428219700f94cad7d1b6b`.

## Purpose

Measure what happens when an exact mixed selection and a specified baseline are passed through the accuracy-first pipeline. Both candidates must use the same source documents, starting context, gold pack, evaluator versions, downstream settings, and recorded no-edit validation rule. Preserve the complete results and the lineage of the items that produced them.

A better selected item or extraction score is not evidence that the final pipeline is better. A matched pair may support an observed gain on supported reference dimensions; repeated experiments are required before describing an improvement as consistent.

## Scope and decisions

1. The caller nominates two existing immutable assemblies by ID and expected fingerprint: `mixed` and `baseline`. Neither is inferred from a moving latest version. A complete-snapshot baseline must first be represented using the existing assembly mechanism. Both assemblies must contain model-origin items, belong to the authorized source workspace, and use the same nominated source set. Human revisions are excluded from this model-selection benchmark.
2. Replay begins from the assemblies' exact selected gap and tactic payloads. It does not run extraction again. Source and block identifiers are remapped into isolated copies; original payloads and all original identities remain in the evidence record.
3. The endpoint is the downstream pipeline through final plan/Gantt projection, including coverage, validation, residual splitting where applicable, status derivation, prioritization, and ideation. Stopping at extraction or status alone does not count as a completed full-pipeline benchmark.
4. Replay uses candidate-only knowledge-base inventory. Pre-existing copied claims and coverage must not become extra input to either candidate. The source workspace's baseline fingerprint and snapshot are retained for reproducibility, but unrelated knowledge-base content is excluded identically. Newly generated downstream residuals and proposed tactics are allowed, with explicit lineage.
5. The fixed gate policy is `deterministic_checks_pass_no_edits_v1`. Blocking deterministic failures stop that candidate. Advisory model findings remain visible and do not trigger candidate-specific edits or discretionary overrides. Passing a benchmark gate means permission to continue this isolated measurement, not human endorsement or production approval.
6. Gold evaluation is limited to dimensions represented in the curated pack. Coverage, status, priority, ideation, and plan dimensions without reference labels are explicitly unscored. Their output changes and deterministic regressions remain measurable and exportable. KAN-40 does not manufacture missing reference labels.

These choices resolve the design questions identified by the repository trace. They are part of the requested specification review.

## Existing behavior to extend

`src/accuracy/experiments/run.ts` already creates independent experiment workspaces and retains per-version outputs and gold evaluations. `copy-workspace.ts` provides source/block/claim remapping, repeatable-read copying, source/baseline fingerprints, and protection against reference-answer leakage.

The existing extraction pipeline runs extraction, merge, and an initial status derivation, then generates an assembly. Assembly generation performs pairwise coverage work, but those coverage calls are not fully attached to the experiment call/evaluation records. There is no supplied-assembly paired replay.

`assembly-store.ts` and `domain/assembly.ts` own immutable assembly identity, exact selected-item validation, source checks, and coverage bindings. `withAssemblyExperiment` is a trusted server scope that keeps experiment work apart from live approval projection. Production approval remains owned by the existing assembly review store.

`experiment-gold.ts` supplies the existing versioned gap/tactic reference evaluator. Existing experiment persistence provides append-only call/evaluation records, terminal-state protection, and JSON/JSONL export. Extend these owners instead of creating a second pipeline kernel or production approval mechanism.

## Request and authorization boundary

Add an authenticated paired-replay API within the existing experiment API family. Its request identifies the source workspace, distinct source file IDs, reference pack, and exact mixed/baseline assembly IDs and fingerprints. The actor comes from the authenticated session. Use existing experiment access rules; the client cannot nominate a more privileged actor.

The service assigns comparison, attempt, workspace, gate-policy, and evaluator identities. Reject client-controlled trusted-scope flags, gold answers, arbitrary gate rules, server-owned identity fields, and unknown request keys.

Before creating copies, resolve both assemblies server-side and validate ownership, source-set equality, supplied fingerprints, original item lineage, and model-only origin. Verify that the required source data and reference pack are available. An assembly must not be accepted merely because its ID exists.

## Matched setup and isolation

Create two separate copied organizations/workspaces with the existing copy mechanism. Before executing either candidate, require matching original source and baseline fingerprints. If state changes between copies, retain the setup failure and execute neither candidate; do not silently compare different inputs. This reuses the existing consistency machinery without introducing a new snapshot service.

Capture source identities, parse-block identities, original baseline snapshot, gold-pack fingerprint, evaluator versions, downstream module/prompt/model configuration, gate-policy fingerprint, and code identity. Preserve original-content fingerprints separately from fingerprints of remapped copied content.

Materialize only the exact selected candidate items into each isolated inventory, using existing claim/provenance validation. Keep a mapping from each original item version, call run, snapshot iteration, item index, and selection reason to its copied claim and evidence IDs. Remove copied stale coverage from the candidate's downstream state before recomputing it.

Gold contents reach evaluator code only. Generators, critics, revisers, judges, and gate decisions must not receive reference answers. All writes remain inside the experiment copies and experiment history.

## Downstream execution

Use existing accuracy modules and their domain/store operations, not HTTP calls back into application routes. Keep orchestrating code under `src/accuracy/experiments/` and reuse fitting helpers for retained calls and failures.

For each candidate:

1. Validate the exact selected inventory and provenance; record deterministic checks and advisory findings.
2. Generate candidate pairs and recompute coverage against exact copied selected payloads and their source blocks. Run the existing coverage critic when required by the recorded downstream configuration. Retain every call input, output, evaluator identity, and error.
3. Apply the fixed experiment gate to candidate claims and coverage decisions. Validate passing objects without changing their generated content. Persist the exact acted-on IDs, content/check fingerprints, rule version, decision, rationale, and advisory findings.
4. Run applicable residual splitting and derive statuses from this candidate's validated inventory and coverage. Record residual-to-parent lineage and preserve each generated output.
5. Run prioritization, ideation, and final plan/Gantt projection using existing behavior and the same recorded settings for both candidates. Validate newly generated artifacts under the same no-edit rule wherever an existing human gate would otherwise require a decision. Empty applicable inputs produce a recorded empty/skip result, not fabricated items.
6. Retain the final inventory, coverage, statuses, priorities, proposed tactics, plan projection, all newly generated item lineage, and module-run identities.

Revisions performed by existing agent modules are part of the model pipeline and remain observable. Human content edits are prohibited throughout the benchmark. Failures and blockers remain visible; there is no silent replacement with another snapshot or assembly.

## Gate policy

The policy is an experiment rule, never a forged production review. Bind each decision to the exact candidate/check identity and record that the decision was automatic under the named benchmark policy.

Blocking source, schema, reference, duplicate-identity, coverage-consistency, or downstream structural failures stop progression. Advisory model judgments, including completeness risks, are retained as warnings under the same rule for both candidates. They are not dismissed as invalid or converted into production approval.

Validate only the exact unedited objects the policy checked. A changed payload requires checks and a new recorded decision before subsequent use. The API cannot broaden this policy. Production roles, omission gates, assembly review states, and approval bindings retain their existing semantics.

## Evaluation and comparison

Use the existing gold evaluator for source-derived gap and tactic inventory at entry and after downstream execution. Keep generated residual needs and proposed tactics separately identified; do not count a deliberately new downstream proposal as a false extracted source item. Preserve a trace from final source-derived items back to their original selected versions, including downstream transformations.

Record supported exact/partial/missed/wrong outcomes and precision/recall/F1 against the same gold fingerprint and evaluator version. Do not reuse the last extraction snapshot's score as the assembled-output score.

Add a versioned downstream evaluator/comparison that records:

- reference applicability by dimension, with an explicit unscored reason;
- recovered/lost reference items and retained/removed correct source-derived items;
- supported provenance lost, unsupported evidence introduced, and invalid references;
- deterministic coverage/status/residual/plan invariant failures;
- source-derived items dropped, merged, or changed during downstream processing;
- changed coverage/status decisions, distinguished from proven errors where gold is unavailable;
- stage latency, token usage, and estimated cost where supplied by existing run records; unavailable values stay unavailable rather than becoming zero.

Output changes without reference labels are descriptive differences, not measured accuracy regressions. A matched comparison must verify source/baseline/gold/evaluator/configuration/gate identities. Report observed supported gains alongside blockers, regressions, warnings, and unscored dimensions. Do not emit an overall full-pipeline accuracy score or an automatic promotion recommendation unsupported by the available labels.

## Durable records and export

Postgres remains canonical. Add an immutable comparison header linking the original request/setup identity and the two experiment attempts. Add one append-only terminal comparison result containing candidate artifacts, gate evidence, selected/generated item lineage, evaluator identities, final outputs, regressions, applicability, and completion/failure status.

Use existing experiment call/evaluation records for stage histories rather than duplicate their payloads into a parallel run store. The exported comparison must include those linked records and the terminal evidence so it can be understood without consulting mutable live knowledge-base state.

Child writes and terminalization must follow the existing transaction/locking discipline. A result is appended once; conflicting repeats fail. An explicit rerun creates a new comparison and new experiment attempts. Exports support a complete JSON record and analysis-friendly JSONL records. Detailed comparison UI work remains KAN-41; KAN-40 supplies inspectable API records and export evidence.

## Failure handling

Reject unauthorized or invalid candidates before replay. If copy consistency fails, execute neither candidate. Once an attempt has been persisted, retain successful calls and the primary failure; later evaluator or persistence failure must not erase earlier evidence or replace the useful error.

Each candidate may complete, be blocked, or fail. Continue the other isolated candidate when its setup is valid, so the record distinguishes candidate failure from setup failure. The comparison may be marked completed only when both full downstream runs and required final evidence persistence succeed. A blocked or failed comparison remains inspectable and cannot be presented as a successful matched gain.

Retried stage operations must not duplicate successful calls or overwrite historical results. Setup cleanup may remove copies with no retained experiment evidence; retain copies once they contain an auditable attempt.

## Verification

Use the repository's Vitest and database-fixture conventions for TypeScript changes. Tests assert behavior, not helper layout. Begin with a complete happy-path pair, then exercise errors and regressions.

Required coverage:

- exact nominated versions reach downstream input; no extraction rerun, unselected claims, or stale coverage participates;
- both candidates use disjoint copies of matching original state and cannot modify live rows;
- source drift, stale fingerprints, crossed workspace references, human revisions, and client gate overrides fail safely;
- both candidates use the same gate rule, record exact decisions, and never edit generated content;
- full execution reaches final projection and retains applicable empty branches;
- final assembled/source-derived gold evaluation differs correctly from last-snapshot scoring;
- supported regressions are detected, while unsupported dimensions remain explicitly unscored;
- downstream residuals/proposals preserve lineage and are not misclassified as extracted source errors;
- partial success survives a later module/evaluator/persistence failure;
- append-only terminalization, retry behavior, separate repeats, and JSON/JSONL evidence round trips;
- production approval and experiment isolation regressions remain covered.

Run the smallest covering unit/integration suites, relevant existing experiment/assembly suites, type checking, scoped lint, and diff checks. Broaden verification only when changes or unresolved failures justify it. Record exact commands and outcomes in the task ledger and Jira completion comment.

## Non-goals and completion

Do not change production loop depth, introduce adaptive stopping, edit benchmark outputs by hand, manufacture downstream gold, convert automatic gates into human acceptance, or promote prompts/models automatically. Do not reorganize unrelated modules or build KAN-41's comparison interface in this task.

KAN-40 is complete only after full replay behavior, durable evidence, and sufficient verification are implemented; limitations are reported; Jira receives the required summary/verification comment; and the Done transition succeeds. The parent KAN-4 remains open while its other required subtasks remain unfinished.
