# KAN-34 Task 4 report

## Design decisions

- Added pipeline mode to the existing experiment runner. It creates the existing isolated workspace copy and persists a normal experiment record before any module is invoked.
- Added `extraction-pipeline.ts`, which uses the established extraction-batch store and resume journal for draft publication and downstream replay. Extractor calls happen before the batch persistence transaction; merge and status remain the established mechanical journal stages, so no model call is made while the journal transaction is open.
- Moved the production route's merge/status helper to the new module so production and experiment resume paths use the same reserved IDs and stage sequence. A separate experiment-only batch or recovery mechanism was rejected because it would diverge from omission pause and replay semantics.
- Sources are processed sequentially in request order. This is intentional: merge/status consume the copied workspace's accumulated draft state. Parallel source execution would need a new ordering and conflict contract.

## Behaviours completed

- `mode: "pipeline"` runs inventory extraction, needs extraction, draft persistence, merge/dedupe, and status derivation in every selected copied source workspace.
- Extracted drafts are inserted through `applyExtractionBatch` before merge/status are invoked.
- Each successful stage retains all available snapshots and a gold evaluation. A failed downstream stage records a model-error evaluation after its batch transaction rolls back, while the journal reservation remains replayable.
- Repeated requests create independent copies, experiments, run IDs, and evaluation IDs.
- Production's existing route calls the shared downstream helper, preserving the existing extraction batch and resume journal path.

## Files changed

- `src/accuracy/experiments/run.ts`
- `src/accuracy/experiments/extraction-pipeline.ts`
- `src/app/api/accuracy/extract/route.ts`
- `tests/accuracy-experiment-pipeline.test.ts`

## Tests added

- Pipeline draft visibility, call ordering, per-stage evaluations, live workspace isolation, and repeat independence.
- Failed merge retention with its copy-local resume journal reservation.

## Verification

- `npx tsc --noEmit --incremental false` — passed.
- `npx vitest run tests/accuracy-experiment-gold.test.ts` — passed (8 tests).
- `npx vitest run tests/accuracy-experiment-pipeline.test.ts tests/accuracy-omission-resume.test.ts` — could not reach assertions because this sandbox blocks the configured local PostgreSQL connection: `connect EPERM 127.0.0.1:5432`.
- `git diff --check` — passed.

## Unresolved risks

- The pipeline intentionally reports a paused copy as a failed experiment because experiment records currently expose only `running`, `completed`, and `failed` terminal states. The resumable extraction journal retains the distinct pause state; introducing an experiment-level `paused` status would require a schema and API contract change outside this task.

## Review follow-up (2026-10-01)

- Guarded the copy's claim insert so a parsed source with no existing claims creates a valid empty-claim experiment copy. Added a database-backed regression test.
- Deferred downstream experiment call/evaluation persistence until the resume callback commits or rolls back. A successful merge is now retained if `status_derive` fails and causes the journal callback to roll back; the status error and replayable reserved journal remain retained too.
- Added pipeline coverage for a real important omission critique event. The copied pipeline pauses before merge/status, leaves the resume journal resumable, and leaves the live workspace claims, runs, and agent events unchanged.
- Expanded the success case to two sources and asserted each source's complete extraction sequence, independent repeats, and live agent-event isolation.
- Verified with local PostgreSQL: `npx vitest run tests/accuracy-experiment-copy.test.ts tests/accuracy-experiment-pipeline.test.ts tests/accuracy-omission-resume.test.ts` passed: 32 tests.

## Rereview follow-up

- Strengthened the two-source pipeline test to record the copied `source_file_id` received by every inventory and need extractor. It now proves that each distinct copied source receives `inventory_extract → need_extract → merge_dedupe → status_derive` in request order.
- The test also proves the first experiment has exactly two copy-local extraction batches and two resume journals, each journal referring to one of those batches and the batches covering both copied source IDs.
- Verified with local PostgreSQL: `npx vitest run tests/accuracy-experiment-pipeline.test.ts` passed: 3 tests. `npx tsc --noEmit --incremental false` and `git diff --check` passed.
