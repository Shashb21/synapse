# KAN-34 Task 3 scoped re-review 3 (`2f63a36..02aff62`)

**Verdict: request changes for one P2 test-coverage defect.** The two runtime fixes under review are correct: successful and failed module paths now both best-effort terminalize an already-created experiment after a persistence error, and the positive `status_derive` case reaches a controlled module with remapped inputs. No new runtime correctness regression was found in this diff. The positive test's final coverage assertion can still pass with one of its two fields left as a source ID.

## Finding

### P2 — The positive status-derive test does not independently prove both coverage IDs are remapped

**Evidence:** `tests/accuracy-experiment-run.test.ts:227` uses:

```ts
expect(received?.coverages[0]).not.toMatchObject({
  gap_id: gap.id,
  tactic_id: tactic.id,
});
```

`not.toMatchObject` passes when *either* field differs. A regression that remaps `coverage.gap_id` but leaves `coverage.tactic_id` unchanged, or the converse, still passes. This is the one uncovered part of the requirement to remap every supplied status-derive claim reference.

**Impact:** A partial coverage-ID regression could again make a copy experiment operate on a source claim identity while this new characterization test remains green.

**Required change:** Assert `coverage.gap_id` and `coverage.tactic_id` separately, and preferably assert each is a known copied claim ID, not merely different from the original value.

## Confirmed resolved

- **Both persistence branches terminalize.** The failed-module branch now catches secondary read/evaluation/write errors at `src/accuracy/experiments/run.ts:105-130` and calls `terminateAfterPersistenceFailure`; the successful-module branch does the same at `:132-146`. The helper transitions the experiment to `failed` best-effort while rethrowing the primary module/persistence error (`:71-75`).
- **The failed-branch fault test is meaningful.** `tests/accuracy-experiment-run.test.ts:231-247` installs an evaluation-insert trigger after a controlled module throws, verifies the primary module error survives, then verifies the stored experiment is terminal `failed` and its error call remains. Vitest disables file parallelism (`vitest.config.ts:8`), so this table-level test trigger cannot affect concurrently running test files.
- **The positive status remap test exercises the controlled module and request immutability.** `tests/accuracy-experiment-run.test.ts:207-229` supplies source gap/tactic/coverage IDs, runs the copy, observes the copied workspace in the controlled module, and asserts the original request is untouched. Its direct `gap_ids` and nested `tactics[].id` assertions are sound; only the combined coverage assertion above needs splitting.

## Verification

- `git diff --check 2f63a36 02aff62` — passed.
- `npm run typecheck` — passed.
- `npm test -- --run tests/accuracy-experiment-run.test.ts` — passed, 10/10 tests, with the local PostgreSQL instance. The sandbox-only path cannot open the localhost database connection.

## Remediation

- The positive `status_derive` remap test now reads the copied workspace's persisted claim IDs and separately asserts that `coverage.gap_id` and `coverage.tactic_id` each belong to that set. A partial remap that leaves either value as the source claim ID therefore fails independently.
- Verification after the change: `npm run typecheck` passed; `npm test -- --run tests/accuracy-experiment-run.test.ts` passed (10/10) against the local PostgreSQL instance.
