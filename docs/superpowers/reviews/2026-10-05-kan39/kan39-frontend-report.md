# KAN-39 Task 2 frontend report

Implemented in `/private/tmp/synapse-kan39-worktree`. **Editing has stopped for independent review.** No backend edits, commits, pushes, Jira writes, or subagents. Controller-owned plan edits were preserved.

## Summary

Contributor-only add/edit/remove gap and tactic forms now use labeled schema-specific fields and required reasons. Source and evidence-block controls consume authorized detail `evidence_blocks`, show text excerpts in choices and full selected source text, and require quote support. No raw JSON authoring. Edits clone every provenance span, preserve untouched fields and optional character offsets, and omit obsolete offsets only on a changed quote/block. Removal sends only a reason and the selected version; server resolves its source and immutable history.

History distinguishes agent baseline, human revision, incomplete/failed linking, and complete linking. Human item lineage shows the real contributor/reason/parent/predecessor, without fabricating a model run, snapshot, or final-output origin. Successor history has baseline navigation; historical baseline/revision entries offer navigation to the current successor. Saved successor IDs are taken from mutation responses and reloaded through detail before mutation/review controls become usable.

Incomplete-link retry uses the saved assembly's exact fingerprint/head. Content changes, retries, and approvals share one synchronous in-flight guard. Late responses after workspace switches are ignored. Conflicts, failed saves, and failed list/detail refreshes invalidate cached mutation and approval authority; inspection remains where available, and only successful fresh detail restores controls. Review remains independent from contributor mutation permissions. `can_revise`, `can_retry_revision`, and `can_review` come exclusively from server response flags; revision metadata's `can_retry` does not grant mutation permission.

Native labels/selects/inputs/buttons support keyboard operation. Loading uses status messages; errors use alerts. Existing Ledger tokens and components are preserved. Read the uncodixfy skill and installed Next.js server/client component guide before edits; server contract/schema modules are imported as types in client code.

## Changed files

- `src/components/accuracy/assembly-history.tsx`: revision metadata/history labels and human origins; controls, saved successor navigation, retry; shared revision/review submission guard and authority invalidation.
- `src/components/accuracy/assembly-revision-form.tsx` (new): reasoned schema-specific form, authorized evidence controls, preservation of spans and untouched fields.
- `tests/accuracy-assembly-revision-ui.test.ts` (new): 16 real React DOM tests covering required reason/evidence, gap/tactic add/edit/remove payloads, exact provenance preservation, quote offsets, span add/remove, human labels, successor/baseline navigation, partial-link retry, independent server permissions, conflicts/failed refresh, submission serialization, and late workspace responses.
- `tests/accuracy-assembly-review-ui.test.ts`: regression assertion that a review conflict disables approval until fresh detail.
- `tests/accuracy-assembly-ui.test.ts`: update selected-item heading assertion because history now includes generated and human items.
- `docs/kan-39-human-revisions.md` (new): contributor/reviewer workflow, terminology, API/authorization boundaries, failed-link recovery, concurrency, verification commands, manual browser checklist, and limitations.

## Verification

Commands ran in `/private/tmp/synapse-kan39-worktree`. Database-bearing focused runs needed approved escalated localhost PostgreSQL access. No test timeout or backend code changes were made to address the intermittent timeout.

### Test-first and corrections

1. `npx vitest run tests/accuracy-assembly-revision-ui.test.ts --silent` — **exit 1**, 10 failed / 2 passed (12 tests). Failures targeted missing human labels and add/edit/remove controls before implementation. The two read-only permission cases passed against the existing inspection UI.
2. `npx vitest run tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent` — initial implementation **exit 1**, 24 passed / 1 failed. Sole failure was the existing assertion for `Selected generated items`; corrected to `Selected items`, reflecting generated and human history.
3. Same three-suite command after evidence/navigation/permission tests — **exit 0**, 3 files / 29 tests passed (16 revision UI, 8 review UI, 5 history UI).
4. Initial `npm run typecheck` — **exit 2**: the new typed Assembly fixture lacked required `extraction_runs`. Added only the fixture's production lineage; rerun **exit 0**.
5. Added a conflict-disabled assertion to the existing review UI test, then ran `npx vitest run tests/accuracy-assembly-review-ui.test.ts --silent` — **exit 1**, 7 passed / 1 failed: expected disabled `Approve proposal`, received `false`. Corrected review-error handling to invalidate cached control authority, alongside revision errors. Subsequent focused runs pass this regression.

### Covering focused command

```bash
npx vitest run tests/accuracy-assembly-api.test.ts tests/accuracy-assembly-revision.test.ts tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent
```

- First sandbox attempt — **exit 1**, 35 passed / 16 failed; failures were database setup `connect EPERM 127.0.0.1:5432`, not assertion failures. Repeated with authorized localhost escalation.
- First escalated run (exec session `60889`, start `20:31:58`) — **exit 1**, 4 files passed / 1 failed; **50 passed / 1 failed**. Existing backend test `KAN-39 immutable human revisions > allows only scoped contributors and rejects spoofed request identity` timed out with `Test timed out in 20000ms.` Vitest reported that test at **976117ms**, revision suite at **985207ms**, total duration **989.92s**. Other 13 revision tests and all UI/API tests passed. No root cause was established; the unusually large elapsed interval is recorded as observed evidence, not proof of environment interruption.
- **Unchanged rerun** with authorized localhost escalation (exec session `8634`, start `22:32:55`) — **exit 0**, **5 files / 51 tests passed**. Revision 14, API 8, revision UI 16, review UI 8, history UI 5. Formerly timed-out authorization test passed in **321ms**; revision suite **8843ms**, total duration **13.62s**. Cause of the prior timeout remains unproven.

### Final static checks

- `npm run typecheck` — **exit 0**, `next typegen && tsc --noEmit`, after the final source/test corrections.
- `npx eslint src/components/accuracy/assembly-history.tsx src/components/accuracy/assembly-revision-form.tsx tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts` — **exit 0**, no warnings/errors, after final source/test corrections.
- `git diff --check` — **exit 0**, final run including the new guide. Only the separate report file was written afterward.

## Material limits and next step

The UI tests exercise React DOM under jsdom, not a real browser. No claims of verified visual layout, mobile behavior, full keyboard/screen-reader compatibility, real-provider correctness, or large-history performance. The guide includes a manual browser checklist. Backend/API verification uses the accepted deterministic-provider integration suites and real localhost PostgreSQL. The isolated earlier timeout did not reproduce in the unchanged rerun; its cause is unknown.

Controller should independently review the owned files, then run the full project suite once at final integration. Commit/publication and Jira lifecycle remain controller-owned. No full suite was run by this worker.

## Task 2 fix round 1 — F1 unseen current successor (2026-10-04)

**F1 corrected; editing has stopped for scoped review.** Read F1 verbatim from `/private/tmp/kan39-frontend-review.md` and reproduced the reported path before production edits. Only `src/components/accuracy/assembly-history.tsx` and `tests/accuracy-assembly-revision-ui.test.ts` changed in this round. No backend/form/guide changes, commits, pushes, Jira writes, or subagents. Pre-fix snapshots remain controller-owned at `/private/tmp/kan39-frontend-fixbase`.

### Root cause and correction

`navigateDetail` selected the server's current successor ID and `loadDetail` saved its exact authorized detail, but rendering iterated only `list.assemblies`. If another contributor created the successor after the list read, no visible row matched the selected ID. The same dependency hid loading, detail errors, and retry controls before a successful read.

The renderer now includes the selected target ID even when it is absent from the list snapshot, showing only an ID placeholder plus loading/error/retry until detail succeeds. A successful authorized detail read merges that exact assembly and its revision state into the cached history. The existing detail success boundary still supplies all mutation/review flags and fresh authority; the placeholder supplies none. No list refresh is required. Server-provided baseline/current-successor navigation is retained, and the old baseline detail is closed when navigating to its successor.

### Behavioral regression and exact verification

Added two focused tests, increasing revision UI from 16 to 18 cases:

- Initial list contains only the baseline; its stale detail points to an unseen successor. Successful successor detail must display its fingerprint and changed content, contributor controls and fresh approval, without another list request. The baseline's old approval is absent; navigation back to the preserved baseline still works.
- Same baseline-only list and unseen pointer, with a deferred successor fetch. Loading must be announced, a failed response must show its error and enabled retry, and no revision/review control may be enabled. Retry must fetch the exact successor ID and restore content/controls only after successful fresh detail.

Commands ran in `/private/tmp/synapse-kan39-worktree`:

1. Before production edits: `npx vitest run tests/accuracy-assembly-revision-ui.test.ts -t 'unseen' --silent` — **exit 1; 2 failed, 16 skipped**. Successful-fetch regression expected `Fingerprint: fp-successor` but received only the cached baseline row. Deferred-fetch regression found no `role="status"` loading message. This establishes the common rendering dependency before correction.
2. After the correction: `npx vitest run tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent` — **exit 0; 3 files / 31 tests passed** (18 revision UI, 8 review UI, 5 history UI), duration **2.63s**. Both unseen-successor tests passed, including error/retry, fresh authority, and baseline navigation.
3. `npm run typecheck` — **exit 0**, `next typegen && tsc --noEmit`.
4. `npx eslint src/components/accuracy/assembly-history.tsx tests/accuracy-assembly-revision-ui.test.ts` — **exit 0**, no warnings/errors.
5. `git diff --check` — **exit 0**.

No API/database/full-suite rerun was required for this rendering-only correction; controller owns integrated full-suite verification after review. Previous timeout evidence and its unchanged clean rerun remain preserved above. Real-browser visual/accessibility, real-provider behavior, and scale limitations remain unchanged.
