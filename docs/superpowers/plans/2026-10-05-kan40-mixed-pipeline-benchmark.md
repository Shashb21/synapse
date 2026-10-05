# KAN-40 Mixed Pipeline Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the user-selected local subagent-driven-development skill to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replay two nominated immutable model assemblies through the downstream pipeline in matched isolated workspaces and retain an auditable comparison.

**Architecture:** Extend the existing experiment copy, run, and append-only record owners. Candidate materialization owns exact payload/provenance remapping; downstream orchestration owns retained module calls and automatic experiment gates; a pure evaluator owns supported comparisons. Production assembly approval is never synthesized.

**Tech Stack:** TypeScript, Next.js 16, Zod, Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-kan40-mixed-pipeline-benchmark-design.md` (approved 2026-10-05).

## Global Constraints

- Associate all implementation and commits with KAN-40; leave parent KAN-4 open.
- Start from KAN-39 commit `9f3d53c26fd28edf8d4428219700f94cad7d1b6b`, in `/private/tmp/synapse-kan40-workspace` on `codex/kan40-mixed-pipeline-benchmark`.
- Exact mixed and baseline assembly IDs and expected fingerprints are mandatory; source inventory is model-origin only; extraction never reruns.
- Fixed automatic rule: `deterministic_checks_pass_no_edits_v1`. Blocking deterministic findings stop progression; advisory findings remain recorded and nonblocking.
- Source, baseline, gold, evaluator, configuration, and gate identities must match. Both copies must exist and pass setup matching before either candidate executes.
- Gold answers belong exclusively to evaluator code. No overall full-pipeline accuracy score or automatic promotion recommendation.
- Candidate-only copied inventory; no unrelated copied claims or stale coverage. Generated residuals/proposals have separate lineage.
- Reuse current module behavior, including empty branches. Placeholder residual/priority output cannot count as a completed applicable transformation: retain a typed blocker and report the module limitation rather than fabricate semantics.
- Use TypeScript Vitest conventions. Read relevant installed Next.js guides before route edits. No unrelated refactors or new dependencies.
- Implementers work sequentially, do not spawn agents, and do not publish. Controller owns git/publication. Resolve both real forge destinations before publishing; current clone origin is a local worktree.

## Review Focus

- An assembly changes or belongs to another tenant: reject before copy writes (Task 2).
- Source/parse state changes between copies: execute neither candidate and retain setup failure (Task 5).
- A later evaluator/persistence error follows successful model work: retain the primary error and earlier calls (Tasks 3, 5).
- Existing placeholder modules return plausible IDs with no real artifacts: report blocked applicable stages, preserve empty valid stages (Task 3).
- Concurrent terminal requests or JSONL export after live state changes: immutable evidence survives and conflicting append fails (Tasks 1, 6).

## File ownership

- `src/accuracy/experiments/mixed-types.ts`: shared request and evidence schemas/types, fixed policy identities.
- `src/accuracy/experiments/mixed-records.ts`, existing store schema/bootstrap: comparison header, terminal evidence, scoped reads/exports and transaction protection.
- `src/accuracy/experiments/mixed-materialize.ts`: resolve originals and materialize exact candidate claims/provenance in an isolated copy.
- `src/accuracy/experiments/mixed-pipeline.ts`: run retained downstream stages, gates and final artifact capture.
- `src/accuracy/eval/mixed-comparison.ts`: deterministic supported evaluation and descriptive downstream differences.
- `src/accuracy/experiments/mixed-comparison.ts`: paired setup and terminal orchestration.
- `src/app/api/accuracy/experiments/mixed-comparisons/route.ts`: authenticated strict API and export.
- Focused `tests/accuracy-mixed-*.test.ts`: behavior and fixture-based persistence/API proofs.

### Task 1: Durable comparison contract and records

**Files:** Create mixed-types.ts and mixed-records.ts; modify `src/accuracy/store/schema.ts` and `src/accuracy/store/db.ts` bootstrap; create `tests/accuracy-mixed-records.test.ts`.

**Interfaces:** Produce `MixedComparisonRequest` (source_workspace_id, source_file_ids, pack_id, mixed/baseline objects containing assembly_id and fingerprint, server actor); `MixedCandidateEvidence` (candidate label, attempt IDs, original assembly, copy maps, gates, lineage, stage outputs, entry/final source inventory, status and primary error); `MixedComparisonRecord` (immutable header, optional terminal result, linked ExperimentRecords). Export `createMixedComparison`, `finishMixedComparison`, `readMixedComparison`, `exportMixedComparison` with workspace-scoped argument objects. Terminal states are completed, blocked, failed; header also supports running.

- [ ] Write failing fixture tests `terminal_evidence_is_append_only`, `cross_workspace_read_returns_null`, `concurrent_conflicting_finish_rejects`, and `export_retains_linked_calls_and_evaluations`. Assert same terminal repeat is idempotent, differing payload fails, late child writes fail, JSON/JSONL preserve exact outputs and nullable usage.
- [ ] Run `npm test -- tests/accuracy-mixed-records.test.ts`; confirm failure for missing implementation.
- [ ] Define Zod evidence schemas and typed validation/conflict errors. Add comparison header and one terminal-result row with unique comparison identity; use existing migration/bootstrap conventions, foreign keys and parent row locks. Bind two attempt IDs once before replay starts; permit setup failure with absent attempts. Reuse experiment records for calls/evaluations. Terminal write verifies referenced attempts/source scope and successful full-stage evidence for completed status.
- [ ] Run focused tests and scoped lint; verify schema setup twice is safe.
- [ ] Commit `feat(KAN-40): retain immutable mixed comparison evidence`.

### Task 2: Exact candidate validation and materialization

**Files:** Create mixed-materialize.ts and `tests/accuracy-mixed-materialize.test.ts`; extend copy-workspace.ts only if candidate-only copy mode is needed.

**Interfaces:** Consume Task 1 types. Produce `resolveMixedCandidates(request: MixedComparisonRequest): Promise<{ mixed: Assembly; baseline: Assembly }>` and `materializeMixedCandidate(args: { assembly: Assembly; copy: CopyExperimentWorkspaceResult }): Promise<MixedCandidateEvidence>` with an initial pending stage state. Use existing Assembly and copy types directly.

- [ ] Write failing tests `selected_versions_are_the_only_materialized_inventory`, `remapped_quotes_match_original_blocks`, `stale_or_cross_workspace_candidates_fail_before_writes`, and `human_revision_origin_is_rejected`. Assert raw original payloads/IDs/reasons remain evidence, copied references resolve, unrelated claims/coverage are absent, and live rows are unchanged.
- [ ] Run `npm test -- tests/accuracy-mixed-materialize.test.ts`; confirm expected failure.
- [ ] Resolve assemblies with readAssembly and exact version-origin checks, recompute/validate fingerprints and source-set equality, and reject unresolved source/provenance. In a copy-only transaction remove copied inventory/coverage using correct FK order, then insert exact selected claims/provenance with existing store semantics. Explicitly remap recognized fields; fail closed on unresolved references. Never replace payload text from mutable canonical claims. Keep original and remapped fingerprints separately.
- [ ] Run focused materialization tests plus `tests/accuracy-experiment-copy.test.ts` and `tests/accuracy-assembly-store.test.ts`.
- [ ] Commit `feat(KAN-40): materialize exact assembly candidates in isolated copies`.

### Task 3: Retained downstream execution and automatic gates

**Files:** Create mixed-pipeline.ts and `tests/accuracy-mixed-pipeline.test.ts`; extend existing retention helpers only when reuse reduces duplication without changing extraction behavior.

**Interfaces:** Produce `runMixedCandidatePipeline(args: { evidence: MixedCandidateEvidence; actor: Actor; pack_id: string }): Promise<MixedCandidateEvidence>`. Consume original/copy/attempt identities from earlier tasks. Evidence accumulates stage results, exact gate decisions and lineage; blocked/failed returns retain successful stages and primary error.

- [ ] Write failing tests `replay_reaches_final_gantt_without_extraction`, `blocking_gate_stops_only_its_candidate`, `advisories_are_recorded_without_content_edits`, `empty_branches_have_retained_outputs`, `placeholder_partial_split_is_a_recorded_blocker`, and `later_failure_preserves_successful_calls`. Assert coverage binds exact selected payloads/blocks, validated joins drive status, no production approval row exists, generated items are separate from source items, and Gantt bars bind validated tactics.
- [ ] Run `npm test -- tests/accuracy-mixed-pipeline.test.ts`; confirm expected failure.
- [ ] Under withAssemblyExperiment, run existing pair generation/coverage/critic, fixed no-edit gates, status, applicable partial splitting with re-derived status, prioritization, ideation, proposal gates and gantt_project through runAccuracyModule. Record every call/version/evaluation with existing reserved-run/idempotency semantics; do not silently lose critic/runtime evidence. Persist coverage validation and claim validation only after exact deterministic checks, record acted-on fingerprints and warnings. Preserve current production omissions and authorization rules. Validate applicable placeholder outputs against durable effects; mark blocked if required residual/priority work is unavailable. Store final inventory and projection, even when empty, and nullable latency/usage/cost.
- [ ] Run focused pipeline tests plus existing experiment-pipeline and assembly-approval-integration suites.
- [ ] Commit `feat(KAN-40): replay retained downstream stages with fixed experiment gates`.

### Task 4: Supported gold and downstream comparison

**Files:** Create eval/mixed-comparison.ts and `tests/accuracy-mixed-evaluation.test.ts`.

**Interfaces:** Produce `evaluateMixedComparison(args: { mixed: MixedCandidateEvidence; baseline: MixedCandidateEvidence; pack_id: string }): Promise<MixedComparisonRecord["result"]>`. Own evaluator version `mixed-downstream-v1`; consume existing evaluateExperimentVersion and experimentPackFingerprint, without passing gold into pipeline code.

- [ ] Write failing tests `assembly_gold_is_not_last_snapshot_gold`, `lost_supported_items_are_regressions`, `generated_proposals_are_not_false_extracted_items`, `unlabelled_dimensions_remain_unscored`, and `identity_mismatch_prevents_matched_gain`. Assert exact/partial/missed/wrong plus precision/recall/F1 for source inventory; no invented downstream F1; descriptive coverage/status differences distinguish proven invariant failures.
- [ ] Run `npm test -- tests/accuracy-mixed-evaluation.test.ts`; confirm expected failure.
- [ ] Evaluate entry/final exact source-derived arrays using existing per-kind gold evaluator. Follow source lineage through changes/merges; exclude deliberate generated residuals/proposals from extraction false positives. Compare recovered/lost reference matches, retained/removed correct items, provenance/reference validity, structural coverage/status/residual/Gantt failures and changed decisions. Verify matching setup identities before supported gain; report unscored reasons for missing labels, blockers/warnings and unavailable telemetry. Never synthesize promotion eligibility or overall accuracy.
- [ ] Run focused evaluator tests and relevant existing experiment-gold/pass-comparison tests discovered in tests directory.
- [ ] Commit `feat(KAN-40): compare supported inventory outcomes and downstream invariants`.

### Task 5: Matched paired orchestration and failure retention

**Files:** Create experiments/mixed-comparison.ts and `tests/accuracy-mixed-comparison.test.ts`.

**Interfaces:** Produce `runMixedComparison(request: MixedComparisonRequest): Promise<MixedComparisonRecord>`. Consume Tasks 1–4 functions. New invocation always creates new comparison and attempt identities; stage retry only reuses successful reserved calls within its own attempt.

- [ ] Write failing tests `both_copies_match_before_any_execution`, `source_drift_retains_failure_and_executes_neither`, `independent_candidate_failure_does_not_cancel_valid_peer`, `rerun_creates_separate_attempts`, and `persistence_failure_never_reports_completed`. Assert separate org/workspace IDs, identical original source/baseline/gold/config/policy identities, actor from server, and successful partial evidence survives evaluator failure.
- [ ] Run `npm test -- tests/accuracy-mixed-comparison.test.ts`; confirm expected failure.
- [ ] Validate candidates and pack first, retain immutable header, create both copies, compare original fingerprints before either replay, and create/link experiment attempts. Capture actual module/prompt/model configuration, evaluator versions, pack fingerprint and code identity once. Fail setup on drift. Materialize/run candidates independently and evaluate terminal evidence. Complete only after both full endpoints and durable evidence succeed; otherwise retain blocked/failed status and primary errors. Clean only copies without retained attempts. Keep transaction scopes short around persistence, never across model calls.
- [ ] Run combined mixed suites and relevant existing experiment records/copy/pipeline suites.
- [ ] Commit `feat(KAN-40): orchestrate matched paired assembly benchmarks`.

### Task 6: Authenticated API, complete exports and branch verification

**Files:** Create mixed-comparisons/route.ts and `tests/accuracy-mixed-api.test.ts`; update feature documentation with usage, supported scores and module limitations.

**Interfaces:** POST strict request fields from Task 1 with actor excluded; GET requires source_workspace_id and comparison_id, optional format=json or jsonl. Return scoped retained evidence. Reuse sessionContext, role capability and authorizedSourceWorkspace from existing experiment API family.

- [ ] Read installed Next.js route-handler guides. Write failing API tests `server_session_owns_actor`, `unknown_fields_and_gate_overrides_are_rejected`, `unauthorized_reads_do_not_disclose_comparisons`, and `exports_round_trip_after_live_state_changes`; assert 401/403/404 and typed 400 errors under existing conventions.
- [ ] Run `npm test -- tests/accuracy-mixed-api.test.ts`; confirm expected failure.
- [ ] Implement strict Zod request and query parsing, authorized source checks, typed error mapping and JSON/JSONL download responses. Never accept server IDs, gold answers, trusted scope flags or gate settings. Document nominated assembly request example, immutable evidence, unscored dimensions and applicable blocked stub stages.
- [ ] Run all mixed tests and covering existing assembly/experiment suites, `npm run typecheck`, scoped `npx eslint` on changed TypeScript, and `git diff --check`. Record exact commands/results. Perform task review and final whole-branch review with fresh reviewers.
- [ ] Commit `feat(KAN-40): expose authenticated paired benchmark records and exports`.

## Execution and completion

The user has chosen subagent-driven development. After plan review, create the plan-specific SDD ledger/briefs with the skill scripts, record a task/file/interface preflight matrix, and execute sequential implementation/review gates using delegate-implement scripts. Preserve original repository changes. Install dependencies using the lockfile, inspect required Next.js guides, and establish focused verification baseline before Task 1.

Before publication, inspect original repository forge URLs and authentication without printing secrets; replace this clone's local origin appropriately and configure github. Follow repository dual-publication instructions for the feature branch. Report any verification, provider, database or stub limitation accurately; a blocked required full-pipeline path keeps KAN-40 open. Only after implementation, verification, Jira completion comment and confirmed Done transition may the lifecycle helper arm the next eligible assigned issue. Never mark KAN-4 Done for this subtask.
