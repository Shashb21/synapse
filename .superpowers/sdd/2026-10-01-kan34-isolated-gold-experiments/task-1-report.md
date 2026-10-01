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
