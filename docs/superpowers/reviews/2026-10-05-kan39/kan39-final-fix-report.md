
## Final review F1 — ClaimHistory human authorship and lineage

Base: `2bf2b75466f46f2af9691f0ace6e96117e14447b`. Scope: the single final-review finding in `/private/tmp/kan39-final-review.md`.

Confirmed root cause: `readItemHistory` already returns `human_origin` and null generated-origin fields for human revisions. `ClaimHistory` rendered run/snapshot/iteration unconditionally, showing a blank Run and judged-output fallbacks for the human row.

Correction: branch on `version.human_origin`. Human versions now show the stored contributor name/function, change action and reason, revision ID, parent proposal ID, and predecessor version (or `New addition` for null predecessor). Generated versions retain their exact existing run, snapshot, and iteration presentation. Payload, source, timestamps, item identity and relationship behavior remain intact. No run or snapshot is synthesized.

Added a parameterized mixed-origin DOM regression test: generated version and later human edit share the original claim ID. It checks human authorship/reason/lineage and corrected payload, excludes generated-origin labels from that row, and verifies generated output with both a real snapshot/iteration and the existing judged-final-output fallback. The real React component is rendered; only HTTP response and existing router dependency are mocked.

Commands/results in `/private/tmp/synapse-kan39-worktree`:

- Before production fix: `npx vitest run tests/accuracy-item-history-ui.test.ts -t 'human authorship' --silent` — exit 1; 2 failed, 9 skipped. Both failed on missing human contributor; received DOM showed blank Run and judged-final-output snapshot/iteration labels. Duration 1.00s.
- After fix: `npx vitest run tests/accuracy-item-history-ui.test.ts tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent` — exit 0; 4 files, 42 tests passed (11 item history, 18 revision, 8 review, 5 assembly history). Duration 3.96s.
- `npm run typecheck` — exit 0; route types generated and TypeScript completed.
- `npx eslint src/components/accuracy/claim-history.tsx tests/accuracy-item-history-ui.test.ts` — exit 0; no diagnostics.
- `git diff --check` — exit 0; no whitespace errors.
- Inspected final scoped diff: exactly the two files below, 52 additions / 4 deletions.

Modified files:

- `src/components/accuracy/claim-history.tsx`
- `tests/accuracy-item-history-ui.test.ts`

Limits: jsdom verifies displayed DOM behavior, not real-browser layout or complete keyboard/screen-reader compatibility. No API/store changes or database verification needed for this rendering-only correction. Parent owns full-suite integration, independent review, commits, dual-forge publication, and Jira lifecycle. No subagents, commits, pushes or Jira writes were performed. Editing stopped after this correction and covering checks.

### Resumed verification (2026-10-05)

After the interrupted agent stopped, inspected the two-file worktree diff and preserved it without further source changes. The pre-fix failure is recorded above; no new pre-fix run was needed. Reran checks against the current worktree:

- `npx vitest run tests/accuracy-item-history-ui.test.ts tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent` — exit 0; 4 files / 42 tests passed (11, 18, 8, 5), duration 4.17s.
- `npm run typecheck` — exit 0; `next typegen && tsc --noEmit` completed.
- `npx eslint src/components/accuracy/claim-history.tsx tests/accuracy-item-history-ui.test.ts` — exit 0, no diagnostics.
- `git diff --check` — exit 0.

The only worktree modifications remain `src/components/accuracy/claim-history.tsx` and `tests/accuracy-item-history-ui.test.ts`. No new source edits, commits, pushes, or Jira writes were made during resumption.
