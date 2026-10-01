# KAN-34 Task 1 report

## Behaviours completed

- Cloned a selected source set into a new organization and workspace using one accuracy transaction.
- Copied source metadata, parse blocks, baseline claims, provenance rows, and coverage joins with new IDs and remapped foreign keys.
- Returned old-to-new source, block, and claim maps plus SHA-256 source and baseline fingerprints.
- Returned a deterministic baseline snapshot that records original and copied IDs and excludes gold-seeded baselines.
- Rejected unknown and cross-workspace source IDs, gold reference-pack sources or claims, and unresolved source/block/claim edges before a copy workspace could remain.
- Preserved the live source workspace rows byte-for-byte.

## Files changed

- `src/accuracy/experiments/copy-workspace.ts`
- `tests/accuracy-experiment-copy.test.ts`

No schema or tenant changes were required for Task 1; experiment persistence tables and deletion ownership belong to Task 2.

## Tests added

- Complete source, parse block, claim, provenance, and coverage copy with foreign-key remapping and live-row immutability checks.
- Unknown and cross-workspace source rejection.
- Gold-seeded claim rejection and rejected-copy cleanup check.
- Unresolved provenance source omission rejection and rejected-copy cleanup check.

## Verification performed

- `npx vitest run tests/accuracy-experiment-copy.test.ts` — 5 tests passed.
- `npx tsc --noEmit --pretty false` — passed.
- `npx eslint src/accuracy/experiments/copy-workspace.ts tests/accuracy-experiment-copy.test.ts` — passed.
- `git diff --check` — passed.

## Unresolved risks

- The focused suite requires the local Postgres test database; the initial sandboxed run was blocked by local socket permissions and the verified rerun used approved database access.
- Snapshot fingerprints intentionally hash the original baseline rows so repeated copies can compare despite generated copied IDs; the snapshot itself retains both ID sets.

## Review follow-up

- Added provenance-table closure for claims with no direct `source_file_id`.
- Rejected crossed source/block provenance pairs in both claim metadata and provenance rows.
- Acquired the existing `omission:<workspace_id>` advisory transaction lock before reading the baseline, matching extraction-batch and omission-review mutations.
- Added reproducibility, material-change, and lock coordination tests.

Follow-up verification: `npx vitest run tests/accuracy-experiment-copy.test.ts` — 9 tests passed; typecheck, focused ESLint, and `git diff --check` passed.

## Review follow-up round 2

- Verified Drizzle's `postgres-js` session supports PostgreSQL transaction isolation levels, including `repeatable read`.
- Set `REPEATABLE READ` as the first statement inside the copy transaction, before the advisory lock and all baseline reads. This gives the clone one database snapshot even when an ordinary writer does not use the advisory lock.
- Added an integration test with an uncoordinated writer that updates claims and coverage in one transaction while the copy runs; the copied claim and coverage rationale must come from the same complete version.

Round 2 verification: `npx vitest run tests/accuracy-experiment-copy.test.ts` — 10 tests passed; typecheck, focused ESLint, and `git diff --check` passed.

## Review follow-up round 3

- Verified that `withAccuracyTransaction` joins active transactions, while Drizzle's top-level Postgres transaction accepts `isolationLevel: "repeatable read"`.
- Extended `withAccuracyTransaction` with transaction configuration support and a typed nested-isolation error.
- `copyExperimentWorkspace` now requests repeatable-read at transaction creation and rejects invocation from an already-active accuracy transaction before schema or baseline work, because a joined transaction cannot safely change its isolation after prior queries.
- Replaced the timer-based copy race with a deterministic database test: read inside the configured transaction, commit an ordinary writer, read again, and assert the original snapshot remains visible.

Round 3 verification: `npx vitest run tests/accuracy-experiment-copy.test.ts` — 11 tests passed; typecheck, focused ESLint, and `git diff --check` passed.
