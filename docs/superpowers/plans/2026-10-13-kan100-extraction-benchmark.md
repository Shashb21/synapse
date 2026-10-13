# KAN-100 Extraction Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute Jira tasks in order, review each independently.

**Goal:** Build and execute the isolated, human-reviewed extraction benchmark without modifying deployment.
**Architecture:** A filesystem-only benchmark package at src/accuracy/eval/benchmark consumes explicit frozen inputs and route snapshots. Reuse pure extraction prompts, provider transports, agentic cycle and provenance/completeness utilities; do not import database-backed run/store/routing wrappers into the isolated path. A small CLI loads explicit JSON configuration and emits private artifacts. Existing deployed configuration must be supplied as an exported snapshot; never infer it from defaults.
**Tech Stack:** TypeScript, Zod, Vitest, Node filesystem and existing provider HTTP transports.
**Spec:** docs/superpowers/specs/2026-10-13-kan100-extraction-benchmark-spec.md

## Global Constraints
- Two BeOne decks stay separate; evidence needs and existing tactics are independent stages.
- One frozen complete parsed input per deck; no 80-block truncation. Keep gold evaluator-only.
- Existing resolved configuration vs fixed Extract version 2.5, lowest-cost suitable tier, citations enabled; no silent model/version substitutions.
- Three scored repetitions per configuration per deck. Freeze settings; later tuning distinct.
- Human-approved gold and final semantic matches. Unreviewed scores are provisional.
- Report content recall, citation validity and their intersection separately; duplicates earn no extra recall; parsing losses remain in overall denominator. No minimum recall gate.
- Completeness audit occurs after extraction, uses one frozen process, and cannot inflate extraction recall.
- Private Git-ignored runtime artifacts, no deployed database/writes or credential persistence.
- Provisional US$10 whole-experiment ceiling, conservative cost preflight, unknown cost is not zero, at most one temporary-service retry; no low-recall retry.
- No BeOne external processing without documented provider-specific authorization; synthetic tests incur no API costs.
- Missing prerequisites/runs/review means incomplete, never Done. Model adoption/deployment remains human.
- Every new public function has happy/error behavioral tests. Use Vitest for TypeScript; do not introduce Python unnecessarily.
- Controller owns git commits/push/PR/Jira. Workers edit only their owned task files; no subagents. Preserve unrelated changes.

## Review Focus
1. Missing baseline snapshot must block, not fall back to code defaults (Task 1).
2. Inputs larger than 80 blocks retain identities and content (Task 2/3).
3. Wrong statement with correct ID and broad special-population summary never earn automatic semantic credit (Task 4).
4. Unknown billing/resumed interrupted attempts cannot become free or duplicate paid calls (Task 5).
5. Missing human review or live repetitions cannot produce a completed report (Task 6/7).

---

### Task 1: KAN-101 setup/preflight

**Ownership:** src/accuracy/eval/benchmark/preflight.ts; contracts.ts; tests/kan100-preflight.test.ts and named docs/CLI.
**Requirements:** Export validated BenchmarkConfig and checkPreflight(config, envNames) returning explicit ready/blockers; config includes routes, provider authorization/account/version/citation verification, dated conservative per-call and setup costs, source sizes, cap and isolated storage identity. Never read database or automatically load .env. Write docs/kan-100-benchmark-runbook.md; pending external confirmations are blockers, not fabricated evidence.
**Interfaces:** Read the prior task report/types for exact exported names; keep the stated boundaries, extend existing owner types rather than duplicate them.

- [ ] Write failing behavioral tests for happy path and the task-specific failure modes above.
- [ ] Run focused test and record expected RED.
- [ ] Implement the smallest complete task preserving Global Constraints.
- [ ] Run focused tests and scoped lint; record GREEN command/results and changed files.
- [ ] Self-review and write report. Controller reviews and commits.

### Task 2: KAN-102 frozen inputs

**Ownership:** src/accuracy/eval/benchmark/inputs.ts; tests/kan100-inputs.test.ts and named docs/CLI.
**Requirements:** Consume Task 1 configuration. Export freezeReferencePack(input) with validated source blocks, separate gold stages, reviewer/version identities, hashes and parsing-loss IDs. Include local PPTX preparation via existing parser only if pure; otherwise a small local JSZip text reader in inputs.ts. Support all slides/blocks and original identity. CLI preparation can be delivered with Task 6. Human approval is supplied explicitly, never inferred from existing gold.
**Interfaces:** Read the prior task report/types for exact exported names; keep the stated boundaries, extend existing owner types rather than duplicate them.

- [ ] Write failing behavioral tests for happy path and the task-specific failure modes above.
- [ ] Run focused test and record expected RED.
- [ ] Implement the smallest complete task preserving Global Constraints.
- [ ] Run focused tests and scoped lint; record GREEN command/results and changed files.
- [ ] Self-review and write report. Controller reviews and commits.

### Task 3: KAN-103 extraction

**Ownership:** src/accuracy/eval/benchmark/extract.ts; tests/kan100-extract.test.ts and named docs/CLI.
**Requirements:** Consume frozen packs and route snapshots. Export extractStage(request, transport) returning normalized findings plus raw output/actual route/usage and citation checks. Transport is one concrete supplied HTTP boundary using existing provider completion transports for baseline; Extract adapter must use verified official API contract or block unsupported account/version. Reuse existing need/inventory prompts and shallow cycle where feasible without DB. Provider receives source/stage/config only, never gold. No production module edits unless unavoidable and documented.
**Interfaces:** Read the prior task report/types for exact exported names; keep the stated boundaries, extend existing owner types rather than duplicate them.

- [ ] Write failing behavioral tests for happy path and the task-specific failure modes above.
- [ ] Run focused test and record expected RED.
- [ ] Implement the smallest complete task preserving Global Constraints.
- [ ] Run focused tests and scoped lint; record GREEN command/results and changed files.
- [ ] Self-review and write report. Controller reviews and commits.

### Task 4: KAN-104 scoring

**Ownership:** src/accuracy/eval/benchmark/scoring.ts; tests/kan100-scoring.test.ts and named docs/CLI.
**Requirements:** Consume frozen gold and normalized findings. Export scoreStage(pack, stage, findings, humanJudgments) with per-item reviewed outcomes and explicit numerators/denominators/provisional state. Human matches are explicit signed records tied to output/source/gold hashes; no heuristic auto-match counted as finalized. Validate matching IDs, unique credit, specificity judgments and citations. Gold correction requires rescoring all output configurations, retaining old artifacts.
**Interfaces:** Read the prior task report/types for exact exported names; keep the stated boundaries, extend existing owner types rather than duplicate them.

- [ ] Write failing behavioral tests for happy path and the task-specific failure modes above.
- [ ] Run focused test and record expected RED.
- [ ] Implement the smallest complete task preserving Global Constraints.
- [ ] Run focused tests and scoped lint; record GREEN command/results and changed files.
- [ ] Self-review and write report. Controller reviews and commits.

### Task 5: KAN-105 batch storage/audit/budget

**Ownership:** src/accuracy/eval/benchmark/batch.ts; artifacts.ts; audit.ts; tests/kan100-batch.test.ts and named docs/CLI.
**Requirements:** Compose prior interfaces at runBenchmarkBatch(config,packs,services). Services are extraction/audit transports plus human judgments; filesystem storage is isolated and ignored. Persist JSON/CSV/report with identities, run and attempt records, cost reservations/reconciliation, restart-safe manifest and explicit completion state. Use exclusive batch ownership/file creation to avoid concurrent corruption. Same frozen audit prompts/process for all outputs, independent audit human verdicts; flag alone never counts as recovered extraction. Unknown cost conservatively reserved and blocks calls without a bound. At most one temporary retry.
**Interfaces:** Read the prior task report/types for exact exported names; keep the stated boundaries, extend existing owner types rather than duplicate them.

- [ ] Write failing behavioral tests for happy path and the task-specific failure modes above.
- [ ] Run focused test and record expected RED.
- [ ] Implement the smallest complete task preserving Global Constraints.
- [ ] Run focused tests and scoped lint; record GREEN command/results and changed files.
- [ ] Self-review and write report. Controller reviews and commits.

### Task 6: KAN-106 CLI and scored execution

**Ownership:** src/accuracy/eval/benchmark/scripts/kan100-benchmark.ts; benchmark/index.ts; tests/kan100-cli.test.ts and named docs/CLI.
**Requirements:** Implement usable local prepare/run/review CLI around batch. Synthetic smoke first, then only execute real runs if authorization, credentials, live configuration feasibility and human-approved inputs are supplied. Never invent those. Preserve blocked evidence and leave Jira open when not possible. Provider protocol verification must use official docs before paid calls. CLI accepts explicit config/private input files; no deployed DB. Prepare actual complete decks locally, but no confidential content in tracked files.
**Interfaces:** Read the prior task report/types for exact exported names; keep the stated boundaries, extend existing owner types rather than duplicate them.

- [ ] Write failing behavioral tests for happy path and the task-specific failure modes above.
- [ ] Run focused test and record expected RED.
- [ ] Implement the smallest complete task preserving Global Constraints.
- [ ] Run focused tests and scoped lint; record GREEN command/results and changed files.
- [ ] Self-review and write report. Controller reviews and commits.

### Task 7: KAN-107 report/completion

**Ownership:** src/accuracy/eval/benchmark/report.ts; docs/kan-100-benchmark-runbook.md; tests/kan100-report.test.ts and named docs/CLI.
**Requirements:** Report stage/deck/run metrics and source-linked examples, repeats/variation, costs/times and advisory conclusions. Map all 40 parent user stories to artifacts/checks. Without successful live matrix and human adjudication, report incomplete and leave parent open. Run smallest sufficient scoped tests, typecheck and lint; broad final review before PR merge. Merge software only if sound and clearly labelled empirical benchmark pending; never represent unfinished experiment as Done.
**Interfaces:** Read the prior task report/types for exact exported names; keep the stated boundaries, extend existing owner types rather than duplicate them.

- [ ] Write failing behavioral tests for happy path and the task-specific failure modes above.
- [ ] Run focused test and record expected RED.
- [ ] Implement the smallest complete task preserving Global Constraints.
- [ ] Run focused tests and scoped lint; record GREEN command/results and changed files.
- [ ] Self-review and write report. Controller reviews and commits.
