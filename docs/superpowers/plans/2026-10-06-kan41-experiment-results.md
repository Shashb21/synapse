# KAN-41 Explainable Experiment Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development. Steps use checkbox syntax.

**Goal:** Inspect and export retained version and full-pipeline comparisons with defensible, scoped improvement labels.
**Architecture:** A pure policy builds a versioned report from existing records/derived comparisons. A source-scoped service loads history and an authenticated GET route exports it. An Experiments page renders the same report.
**Tech Stack:** Existing TypeScript, Next.js 16, Postgres/Drizzle, Vitest, React; no new dependencies.
**Spec:** docs/superpowers/specs/2026-10-06-kan41-experiment-results-design.md

## Global Constraints
- Read-only reporting; preserve append-only Postgres evidence and production behavior.
- All reads and exports require sign-in and original source-workspace authorization; unavailable/foreign workspaces receive uniform 404.
- Match document, gold and evaluator versions before attribution; mismatches are Descriptive.
- One pair may be Observed gain, never Consistent improvement without separately retained matched repeats.
- Source-gold gain never establishes improvement in unscored downstream dimensions or deployment approval.
- Missing metering is Unknown, never known zero; raw evidence and selection lineage remain exportable.
- KAN-4 stays open; do not touch /Users/calixtan/personal-projects/synapse.
- Follow existing TypeScript/Vitest/Next.js architecture; add no dependencies.

## Review Focus
- Stale/malformed/unavailable gold or evaluator identity suppresses attribution while preserving historical evidence (Task 1).
- Duplicate/shared experiment or call identities cannot create an independent repeated pattern (Task 1).
- Failed/neutral/adverse comparable repeats cannot be omitted to cherry-pick consistency (Task 1).
- Unauthorized original workspace/foreign IDs never disclose copied workspace evidence (Task 2).
- Unknown runtime measurements, empty/loading/error results and overflowing evidence are visible/accessibly handled (Task 3).

### Task 1: Pure report and attribution policy

**Files:** Create src/accuracy/experiments/results-report.ts; tests/accuracy-experiment-results-report.test.ts.
**Context:** Read docs/kan-35-pass-comparisons.md, docs/kan-40-mixed-pipeline-benchmark.md and /private/tmp/kan41-trace.md for existing exact types. Existing evaluatePassComparison owns stricter cohort matching and safety; do not duplicate its evaluator. Mixed retained evidence has no explicit matched boolean; check captured identities, loaded fingerprint, source evaluations/applicability and mismatch changes conservatively.
**Interfaces:** Export ExperimentResultsReport; buildExperimentResultsReport(args: { source_workspace_id: string; experiments: ExperimentRecord[]; pass_comparisons: PassComparison[]; mixed_comparisons: MixedComparisonRecord[]; loaded_pack_fingerprints: Record<string, string | null> }): ExperimentResultsReport. Export serializeExperimentResultsReport(report: ExperimentResultsReport, format: "json" | "jsonl"): string. Report schema_version is "experiment-results-v1". Preserve raw experiments, pass evidence and complete mixed records in report. Choose small typed report entries with id, kind, created_at, attribution (label, reasons, scope), matched, mismatch_reasons, repeat_key, experiment_ids, call_ids, evidence. Labels are "Descriptive", "Matched results", "Observed gain", "Consistent improvement"; scope is "source_gold". Expose repeat_series with member IDs and rationale. Task 2/3 consume the exported types; record exact resulting shape in task report.

- [ ] Write behavioral failing tests and run npx vitest run tests/accuracy-experiment-results-report.test.ts --silent. Arrange retained records, Act derive report, Assert claim labels, evidence preservation and IDs.
- [ ] Build policy on existing types/canonical JSON utility. Separate pass cohorts, mixed pairs, and standalone attempts. Avoid duplicate display of mixed child experiments; standalone extraction experiments stay descriptive with their existing per-version detail. Include raw record references for every entry, retained critic/judge/runtime data where available.
- [ ] Pass cohorts require existing matched/loaded-pack identity and eligible completed baseline one-pass plus candidate. A gain requires greater exact found recovery (or must-find recovery), nondecreased exact must-find count, nonincreased summed wrong/partial counts, and no serious regression. Compare each two/three-pass candidate to one-pass; keep claims candidate-specific so differing winners cannot manufacture a repeat. Preserve per-version deltas/IDs in existing comparison evidence. Partial cohorts remain descriptive.
- [ ] Mixed pairs require completed records, two distinct completed linked attempts, matching full captured setup, header pack/evaluator identity, loaded pack fingerprint, retained scored source evaluations with matching evaluator/pack identities, scored source applicability and no mismatch findings. Existing proven errors/blocking regressions prohibit gain. Compare distinct exact final reference keys qualified by gap/tactic; require nonincreased wrong/partial counts and no lost exact baseline reference. Preserve explicit unscored downstream applicability; do not label whole pipeline better.
- [ ] Repeat keys include original documents/gold/evaluator/configuration and same baseline/candidate condition (mixed exact assembly fingerprints; pass original request fingerprint plus pass count). Exclude generated comparison/attempt/call/copied workspace IDs from repeat matching. At least two independent full comparisons with disjoint comparison/experiment/call IDs and gain in every member of the complete comparable series establish a repeated source-gold pattern. Failed/blocked/neutral comparable members suppress consistency. A single pair stays Observed gain. If identity is incomplete use no repeat key; explain conservative result.
- [ ] Test document/gold/evaluator/config drift separately; single gain; positive disjoint repeats; duplicates/shared calls; candidate condition drift; comparable neutral/loss/failed repeat; unknown eligibility; unscored downstream; no source loss; null metering preserved; malformed identity; no mutation of inputs.
- [ ] JSON includes the complete report; JSONL emits each complete entry plus its matching repeat-series explanation and schema/source identity, one line per entry with trailing newline; empty JSONL is empty. Assert raw records, inputs/outputs, calls/evaluations/lineage survive both formats and invalid runtime format rejects safely.
- [ ] Run focused tests and scoped ESLint; self-review. Parent handles git commits. Write report with RED/GREEN commands/results, files, final public type shape and concerns.

### Task 2: Authenticated source-scoped history and export

**Files:** Modify src/accuracy/experiments/records.ts, mixed-records.ts, pass-comparison.ts only for fitting read helpers; create src/accuracy/experiments/results.ts, src/app/api/accuracy/experiments/results/route.ts, tests/accuracy-experiment-results-api.test.ts and tests/accuracy-experiment-results-store.test.ts.
**Interfaces:** Consume Task 1 exports. Export readExperimentResults(args: { source_workspace_id: string }): Promise<ExperimentResultsReport>. Add listExperimentsForSourceWorkspace and listMixedComparisonsForSourceWorkspace using original source scope, stable created_at/ID ordering and coherent read-only transaction where needed. Reuse existing runtime/event loadEvidence by exporting/renaming a fitting helper or existing readPassComparison. Existing export functions may delegate to fitting list helper without changing their contract.

- [ ] Write and run failing API/store tests first. Use repository Vitest/Postgres patterns. Test actual read helper returns independent historical repeats and includes raw evidence unchanged; use fixture existing completed records rather than paid runners. Include running/failed histories.
- [ ] Load ordinary records and mixed records, group server-generated pass comparison_id conditions into their original cohorts; call existing readPassComparison/evaluatePassComparison for each cohort and standalone extraction evidence where applicable. Load current pack fingerprints once per pack, catch known unavailable/malformed pack failures to null without hiding database/internal failures. Build report through Task 1. No new tables, writes, runner invocations or rescoring mixed snapshots.
- [ ] GET /api/accuracy/experiments/results?source_workspace_id=...&format=json|jsonl (default json). Strictly reject blank/repeated/unknown params and bad format with 400. Authenticate before loading; signed out 401; use authorizedSourceWorkspace; unauthorized/missing 404; unexpected faults generic logged 500. Both formats use private, no-store and correct MIME type. format defaults json. Optionally set attachment filename for explicit export links if UI can use plain anchors.
- [ ] Assert auth/scoping (real grants for store integration where practical), malformed queries, JSON/JSONL complete shape, repeat retention without writes, stable ordering, no runner calls, unexpected faults and missing gold descriptive. Do not leak exception text.
- [ ] Run focused new store/API/policy tests plus existing experiment/pass/mixed API/record tests where touched; npm run typecheck and scoped lint. Preserve files others changed. Parent handles git commits. Report commands/results, files and concerns.

### Task 3: Experiment history, readable comparison and downloads

**Files:** Create src/app/accuracy/experiments/page.tsx, src/components/accuracy/experiment-results.tsx, tests/accuracy-experiment-results-ui.test.ts; modify src/components/accuracy-chrome.tsx to add Experiments workspace-aware navigation; create docs/kan-41-experiment-results.md.
**Interfaces:** Consume ExperimentResultsReport from Task 1 and GET from Task 2. Prefer a small client read-only component fetching the report, hosted by existing shell with workspace picker/authorized workspace context. Never import server DB/crypto runtime code into client components; use type-only imports. Read relevant Next docs in node_modules/next/dist/docs before editing. Follow existing shell and design tokens, uncodixfy skill at /Users/calixtan/.codex/skills/uncodixfy/SKILL.md; no visual redesign.

- [ ] Write and run failing rendered UI tests using existing React/jsdom patterns. Tests arrange a representative report, render or fetch it, assert readable semantics; run npx vitest run tests/accuracy-experiment-results-ui.test.ts --silent.
- [ ] Add workspace-linked Experiments navigation and /accuracy/experiments?workspace_id=... page. Fetch only authenticated API report; handle loading, empty, failure, stale request/workspace switches with visible status/alert and abort/stale protection. No paid experiment execution controls in this read-only task.
- [ ] Render comparison identity/status, matched/descriptive attribution and reasons, original document/gold/evaluator versions, separately retained repeated members and scoped claims. Readable pass tables show condition, per-call/Vn outcomes, must-find recovered/lost, previous/V0 deltas, regressions, cost/latency with Unknown when evidence unavailable. Expand exact critic/judge evidence and inputs/outputs rather than forcing all detail into table.
- [ ] Readable mixed sections show candidate/attempt, final source outcomes, change/regression rows, exact selected/generated lineage, stage/gate statuses, cost/latency and evaluator, explicit scored/unscored dimensions. Use <details> to manage volume; raw JSON may supplement these sections. Full-pipeline status is separate from source-gold gain.
- [ ] Provide JSON and JSONL downloads from the same source-scoped results endpoint, with formats and all evidence. Keyboard controls/labels and scrollable accessible tables; readable long IDs; no decorative metric cards. Unknown is not $0 or 0 ms. A single observed gain does not show consistent improvement; mismatched pair reasons remain explicit.
- [ ] Test complete pass/mixed evidence, scoped gain wording, independent repeat history links, unknown metering, empty, loading/error, cross-workspace stale result handling and export URLs. Documentation lists endpoint/page, claim rule/limits and verification commands. Run new UI tests, npm run typecheck, scoped lint; self-review. Parent handles git commits; report commands/results and concerns.
