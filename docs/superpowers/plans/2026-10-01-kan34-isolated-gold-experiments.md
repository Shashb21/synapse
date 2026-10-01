# KAN-34 Isolated Gold Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run and retain repeatable single-call and extraction-pipeline experiments against a curated gold pack without exposing gold answers to generation or changing the live knowledge base.

**Architecture:** An experiment snapshots a selected accuracy workspace into a new workspace with remapped IDs, records source and baseline fingerprints, and runs the existing accuracy modules only in that copy. A separate evaluator reads the gold pack after each model snapshot and stores item outcomes and output-shape errors. The experiment store retains each attempt, inputs, versioned pack/evaluator identities, call-run IDs, results, and JSON/JSONL exports.

**Tech Stack:** TypeScript, Next.js route handlers, Drizzle/PostgreSQL, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-kan4-agent-loop-design.md` (especially “Key records and boundaries” and “Evaluation contexts”); Jira KAN-34.

## Global Constraints

- Gold answers are available only in `src/accuracy/eval/` and experiment evaluation, never in module inputs, prompts, the copied workspace, or production event records.
- Every repeat creates a new experiment ID; no upsert by condition or input hash.
- Keep production call depth and live workspace behavior unchanged.
- Store exact source-set, baseline state, pack-content, evaluator-version, condition, and call-input identities so comparisons can reject mismatched runs.
- The experiment copy is a real, separate workspace; all intermediate writes, module runs, and event records use its ID.
- Human-edited claims are baseline context only; they are never scored as model output.

## Review Focus

- Gold-seeded demo workspaces must be rejected as baselines, or gold statements will enter the proposer’s claim inventory (Task 1 test).
- An unknown or cross-workspace source, block, claim, or organization ID must fail before any model call or live write (Tasks 1 and 3 tests).
- A failed call must leave its output-shape/error evaluation record and must not be counted as a successful model score (Tasks 2 and 3 tests).
- A second experiment with identical inputs must have a distinct ID, copy, calls, and evaluations (Task 3 test).
- An intermediate pipeline write must be visible to later calls in the copy and absent from the source workspace (Task 3 test).

---

### Task 1: Clone a specified starting knowledge-base state

**Files:**
- Create: `src/accuracy/experiments/copy-workspace.ts`
- Modify: `src/accuracy/store/schema.ts`, `src/accuracy/store/tenant.ts`
- Test: `tests/accuracy-experiment-copy.test.ts`

**Interfaces:**
- Produce `copyExperimentWorkspace(args: { source_workspace_id: string; source_file_ids: string[] }): Promise<{ workspace_id: string; org_id: string; source_id_map: Record<string,string>; block_id_map: Record<string,string>; claim_id_map: Record<string,string>; source_fingerprint: string; baseline_fingerprint: string; baseline_snapshot: unknown }>`.
- `baseline_snapshot` contains the exact copied source metadata, parse blocks, claims, provenance, and coverage joins, with deterministic ordering and no gold payloads. Hash canonical JSON with SHA-256. Record the original and copied IDs separately.

- [ ] Write tests for a copied source, parse block, claim, provenance, and coverage join; assert all copied foreign IDs point into the new workspace, and live rows remain byte-for-byte unchanged.
- [ ] Write rejection tests for unknown/cross-workspace source IDs, a gold-seeded claim (`metadata.reference_pack_id` with a gold source badge), and an unresolved source omission; no experiment workspace may remain after a rejected copy.
- [ ] Run `npx vitest run tests/accuracy-experiment-copy.test.ts` and verify the new tests fail for the missing function.
- [ ] Implement the copy in one transaction using `accuracyDb()` and existing workspace tables. Copy only the selected source set and its referenced baseline knowledge-base rows; reject any claim/coverage edge that would point outside the copy. Use new IDs, not shared primary keys. Ensure `deleteWorkspace` removes any new experiment rows only after their ownership is clear in Task 2.
- [ ] Rerun the focused tests, `npm run typecheck`, and commit the task.

### Task 2: Versioned gold evaluator and immutable experiment records

**Files:**
- Create: `src/accuracy/eval/experiment-gold.ts`, `src/accuracy/experiments/records.ts`
- Modify: `src/accuracy/store/schema.ts`, `src/accuracy/store/tenant.ts`, `src/accuracy/modules/need-extract/module.ts`
- Test: `tests/accuracy-experiment-gold.test.ts`, `tests/accuracy-experiment-records.test.ts`

**Interfaces:**
- Produce `evaluateExperimentVersion(args: { pack_id: string; call_kind: string; output: unknown; output_error?: string }): ExperimentVersionEvaluation`. Return item outcomes (`found`, `partial`, `missed`, `wrong`) with gold item key, model item index, reason, validated output shape, and errors. For gap/tactic extract versions, match stable external IDs first, then normalized statements/titles. Use one-to-one deterministic matching: exact normalized text (or stable ID and exact text) is `found`; a stable ID with different text or word-set overlap of at least 0.6 is `partial`; unmatched gold/model items are `missed`/`wrong`. Give the overlap threshold a named, documented evaluator-v1 constant. Partial matches are excluded from exact precision/recall. Other call kinds record shape and `gold_not_applicable` rather than inventing a score.
- Produce store operations `createExperiment`, `recordExperimentCall`, `recordVersionEvaluation`, `finishExperiment`, `getExperiment`, and `exportExperiments(format: "json" | "jsonl")`. Experiment and child rows are workspace-scoped and append-only except terminal status.
- Define an explicit evaluator version constant and SHA-256 of the selected manifest entry plus gold JSON bytes; validate pack ID from the manifest. Persist exact input JSON, copied baseline snapshot/fingerprints, condition JSON, module version/route per call, and evaluator version.

- [ ] Write pure evaluator tests for exact ID, narrative text, partial text, extra/wrong model item, missing gold item, malformed shape, and model error. Assert score fields are absent when the pack cannot support them.
- [ ] Write database tests that store two attempts with identical input as distinct rows, retain all version indices and call IDs, export complete JSON/JSONL, and reject cross-workspace reads.
- [ ] Run the focused tests and verify failures before implementing.
- [ ] Implement evaluator and persistence. Keep `loadReferenceGold` imports confined to evaluator code; move `scoreGapIdRecall` from `need-extract/module.ts` into `src/accuracy/eval/` and update its callers/tests so generation never imports gold files.
- [ ] Rerun focused tests and typecheck, then commit the task.

### Task 3: Execute isolated single-call experiments

**Files:**
- Create: `src/accuracy/experiments/run.ts`
- Modify: `src/accuracy/kernel/agent-events.ts`, `src/accuracy/kernel/agentic.ts`, `src/accuracy/kernel/run.ts`, `src/accuracy/store/schema.ts`
- Test: `tests/accuracy-experiment-run.test.ts`

**Interfaces:**
- Produce `runAccuracyExperiment(request: { mode: "single_call" | "pipeline"; source_workspace_id: string; source_file_ids: string[]; pack_id: string; condition: Record<string,unknown>; call?: { call_kind: CallKind; input: Record<string,unknown> }; actor: Actor }): Promise<ExperimentRecord>`. Task 3 implements `single_call`; Task 4 adds `pipeline`.
- `runAccuracyModule` receives an internal `evaluation_context: "production" | "experiment"` defaulting to production; its agent event recorder uses that value instead of hardcoding production. The context contains no gold answers or metrics. Its module-run row also retains the context.

- [ ] Write a single-call test with a controlled registered module: assert original input, remapped input, run ID, snapshot identities, gold evaluations, and unchanged live workspace. Add an error-output case with a retained failed experiment/evaluation.
- [ ] Write tests that experiment snapshots have `evaluation_context: "experiment"`, production snapshots still default to `"production"`, and neither event payload includes gold fields.
- [ ] Run the focused tests and verify failures before implementation.
- [ ] Implement orchestration using `runAccuracyModule` and the copy/store/evaluator boundaries from Tasks 1–2. Remap only known old IDs, set workspace ID server-side, and reject unresolved references. Evaluate snapshot events separately after the module returns; on failure, retain a call-level error evaluation. Persist all outputs before returning.
- [ ] Rerun focused tests and typecheck, then commit the task.

### Task 4: Run the complete current extraction pipeline in the copy

**Files:**
- Modify: `src/accuracy/experiments/run.ts`
- Create: `src/accuracy/experiments/extraction-pipeline.ts`
- Test: `tests/accuracy-experiment-pipeline.test.ts`

**Interfaces:**
- `mode: "pipeline"` executes the complete current extraction workflow (`inventory_extract`, `need_extract`, `merge_dedupe`, `status_derive`) for each selected source file in the experiment workspace. Persist each extractor's drafts before merge/status so downstream modules consume the copy's actual intermediate state. Reuse the existing extraction-batch store and pause/resume journal, not a second recovery mechanism. A later KAN-4 ticket may extend the recipe beyond extraction to human-gated stages.

- [ ] Write a pipeline test with controlled extractors: assert call order, copied draft persistence before merge/status, per-version evaluations, and no live claim/run/event mutation. Run the same request twice and assert independent copy/run/evaluation IDs.
- [ ] Write tests for an important omission pausing the copy, and a failed downstream stage retaining error and replay state without changing the source workspace.
- [ ] Run the focused tests and verify failures before implementation.
- [ ] Extract the shared extraction orchestration from `src/app/api/accuracy/extract/route.ts` only as needed so production and experiment use one batch/pause/resume implementation. Reject source or claim references that cannot be remapped into the copy.
- [ ] Rerun focused tests, existing extraction-resume tests, and typecheck, then commit the task.

### Task 5: Authenticated API and exports

**Files:**
- Create: `src/app/api/accuracy/experiments/route.ts`, `src/app/api/accuracy/experiments/[experiment_id]/route.ts`
- Test: `tests/accuracy-experiment-api.test.ts`

**Interfaces:**
- API POST starts a single-call or pipeline experiment for an authenticated contributor with validation capability. GET/export requires an authenticated reader and source workspace scope. Derive actor and organization server-side; never accept gold rows or copied-workspace IDs from the request.

- [ ] Write API tests for unauthorized, forbidden, invalid pack/source, cross-workspace reference, successful run, scoped read, and JSON/JSONL exports. Read the relevant guide in `node_modules/next/dist/docs/` before editing route handlers.
- [ ] Run focused tests and verify failures before implementation.
- [ ] Implement route validation and responses, calling the existing experiment service. Keep JSON/JSONL export complete and deterministic, with one experiment record per JSONL line.
- [ ] Rerun focused tests and typecheck, then commit the task.

### Task 6: Whole-branch verification and documentation

**Files:**
- Create: `docs/kan-34-experiments.md`
- Modify: only files needed to correct findings from the full review

**Interfaces:**
- Document a minimal local experiment request, how to read/export results, the exact evaluator-v1 matching limits, and how to compare repeats with matching fingerprints.

- [ ] Run `npx vitest run --silent --maxWorkers=2`, `npm run typecheck`, changed-file lint, and `git diff --check`.
- [ ] Review the complete KAN-34 diff against every Jira acceptance criterion and the approved KAN-4 gold/production boundary. Fix and reverify any blockers.
- [ ] Commit the documentation and verified corrections. Publish the final branch to `origin` and `github`, then move Jira KAN-34 from In Progress to In Review while it is not merged.
