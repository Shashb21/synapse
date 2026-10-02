# KAN-35 Controlled Pass Comparison Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Requirements below implement the design approved in conversation; proceed continuously through all tasks and reviews.

**Goal:** Retain and compare matched isolated one-, two-, and three-pass extraction experiments without changing production execution.

**Architecture:** Extend trusted kernel execution context for experiment-only fixed depth. Reuse experiment records and agent events; derive a versioned comparison from those records and expose it through the existing authenticated experiment boundary.

**Tech Stack:** TypeScript, Next.js, Drizzle/PostgreSQL, Zod, Vitest.

**Spec:** docs/superpowers/specs/2026-10-02-kan35-pass-comparison-design.md; Jira KAN-35.

## Global Constraints

- Production depth, early exit, omission gates, and source workspace data remain unchanged. Gold stays evaluator-only.
- A cohort is three separate attempts; repeating a cohort creates three new attempts.
- Actual source/baseline/pack/evaluator/module/route identities must match before attributed comparison.
- Gold nonmatches alone are not evidence of source falsity.
- Failed/incomplete conditions and serious findings are ineligible; unknown eligibility cannot win.
- Exact must-find recovery and exact correctness outrank cost and latency; partial matches do not count as exact recoveries.
- A recommendation never changes production settings or constitutes deployment approval.
- Preserve authenticated workspace scoping, existing exports and failure retention; no new recovery journal.

## Review Focus

- Clean critics must still yield the requested revisions in controlled experiments (Task 1).
- Forged/invalid controls must fail before module calls or workspace copies (Tasks 1, 3).
- Source edits or route changes between conditions must prevent attributed comparison (Task 2).
- Failed output rows and missing assessments must not win or masquerade as successful final snapshots (Task 2).
- Cross-workspace comparison IDs must never disclose experiment records (Task 3).

### Task 1: Trusted experiment-only fixed pass execution

**Files:** Modify src/accuracy/kernel/contracts.ts, run.ts, observability.ts, agentic.ts; src/accuracy/experiments/run.ts, extraction-pipeline.ts. Tests: tests/accuracy-agentic-cycle.test.ts and tests/accuracy-experiment-run.test.ts, tests/accuracy-experiment-pipeline.test.ts as needed.

**Interfaces:** Export `ExperimentPassCount = 1 | 2 | 3` and `ExperimentCycleControl = { critic_revision_passes: ExperimentPassCount }` from kernel/contracts.ts. Add optional `experiment_cycle_control` to trusted run arguments and RunHandle/recorder. Experiment condition `critic_revision_passes` supplies the control; validate runtime values before copying. Pass-count control is permitted for pipeline or single-call need_extract/inventory_extract, rejecting unsupported controlled call kinds. Pipeline passes it only to agentic extraction calls.

- [ ] Add failing tests: each controlled clean critic produces exactly snapshot indices 0..N for N=1,2,3, with N revisions and existing terminal assessment; default production still early exits; control in production or invalid counts throws before proposer/run side effects.
- [ ] Implement validation in the responsible execution boundary. Fixed experiment depth overrides maxExchanges and bypasses only clean-critique early exit. Exceptions, per-snapshot assessment, judgment, omission pause, and metering keep existing semantics. Retain effective control in experiment condition; no gold on run handle.
- [ ] Prove propagation through actual single-call and pipeline experiment paths using controlled modules and retained events; source rows stay unchanged. Reject invalid controls before copying; failed models retain available snapshots/errors.
- [ ] Run focused changed tests, `npm run typecheck`, changed-file lint, and `git diff --check`; report commands/results and red/green evidence. Controller owns commits/pushes; implementer does not commit.

### Task 2: Matched cohort runner and conservative comparison

**Files:** Create src/accuracy/experiments/pass-comparison.ts and src/accuracy/eval/pass-comparison.ts; tests/accuracy-pass-comparison.test.ts and tests/accuracy-pass-comparison-run.test.ts. Modify existing experiment files only if needed for exact retained identities.

**Interfaces:** `runPassComparison(request: AccuracyExperimentRequest)` returns `{ comparison_id: string; experiments: ExperimentRecord[]; comparison: PassComparison }`, running conditions 1,2,3 sequentially with existing `runAccuracyExperiment`. Store comparison ID, pass count, comparison evaluator version and stable original-request identity in each condition (other condition fields preserved; reject conflicting reserved controls). `readPassComparison({ source_workspace_id: string; experiment_ids: string[] })` loads scoped records and agent events, then calls a pure comparator. Export named comparison version and typed results from eval/pass-comparison.ts. Exact result types may be designed locally, with readable named fields and reasons.

- [ ] Write failing pure tests for matched versus mismatched source/baseline/pack/evaluator/module/route/request identity, duplicate/missing conditions, exact must-find found/partial/missed/wrong, recoveries and losses from V0 and prior version, unsupported/provenance regressions, omission distinction, incomplete/error versions, unknown assessments, and quality-before-cost ranking.
- [ ] Derive per-call/version outcomes and costs from stored evaluation and events. Load must-find targets only in eval/. Match call lineage across copies using original source mapping/baseline snapshot (never compare generated copy IDs). Compare actual module IDs/versions and routes from runs; include original request identity excluding only cohort/pass controls. Canonicalize objects for fingerprints/comparison. A mismatched cohort is descriptive and has no recommendation.
- [ ] Serious regression: increase in invalid quote count or new invariant failures; new high/critical non-omission findings explicitly false/unsupported/provenance. Existing invalid/invariant/serious findings make condition ineligible too. Missing events/terminal assessment, unchecked quotes, completeness check_failed make eligibility unknown. Failed experiment, malformed output, missing requested versions are ineligible. Do not conflate omission with false evidence or a gold wrong outcome with unsupported content.
- [ ] Rank only eligible matched conditions by final exact must-find found count, then final exact found count, then fewer wrong items, fewer partial items, lower cost, lower latency, pass count for final deterministic tie. Report recovered/lost keys and per-version deltas alongside counts; totals cover every selected source/call. Cost/latency include critique and judgment where appropriate and distinguish cumulative per-version from full-call totals.
- [ ] Add database integration tests for three distinct copies/experiment/call/evaluation IDs, exact versions via the real cycle, preserved baseline data, separate repeat cohort, scoped reads and retained failures. Use controlled modules, no paid LLM. Run focused tests, typecheck, changed-file lint and diff check; report red/green evidence. Controller owns commits.

### Task 3: Authenticated comparison API and documentation

**Files:** Modify src/app/api/accuracy/experiments/route.ts; Create src/app/api/accuracy/experiments/pass-comparisons/route.ts; tests/accuracy-pass-comparison-api.test.ts; docs/kan-35-pass-comparisons.md.

**Interfaces:** Existing experiment POST condition accepts `critic_revision_passes` only as 1/2/3; keep defaults unchanged. New pass-comparisons POST accepts same source/call request shape, derives actor/session server-side and executes `runPassComparison`; reject client cohort IDs/control overrides. GET accepts source_workspace_id and three experiment IDs, and calls `readPassComparison` after reader authorization. Reuse/export existing experiment request/input authorization helpers where coherent, avoid duplicating the full validation logic. Preserve existing endpoint responses.

- [ ] Read relevant Next.js route-handler guide under node_modules/next/dist/docs/ before code changes. Add failing API tests: unauthenticated, forbidden role, invalid pass count/reserved fields, unknown pack/source, unsupported call, successful cohort, scoped reader, cross-workspace experiment, absent/incomplete condition.
- [ ] Implement public validation and typed errors with safe responses; use existing session capabilities, module input parsing and source ownership checks. Errors must not disclose another workspace. No gold rows or copied IDs accepted.
- [ ] Document a minimal POST request, GET comparison, existing JSON/JSONL raw experiment exports, pass/terminal-assessment meaning, matching identities, exact-vs-partial limits, conservative eligibility and recommendation ranking. Explain metadata labels do not override execution route. No UI or production promotion in scope.
- [ ] Run new/affected API tests, full Vitest suite once (`npx vitest run --silent --maxWorkers=2`), typecheck, changed-file lint, diff check. Report exact counts, commands, risks. Controller owns commits and Jira lifecycle.
