# KAN-39 Task 2 F1 scoped re-review

**F1: ADDRESSED.**

**Specification compliance: PASS for the reviewed Task 2 scope.** The previously required correction now handles current-successor navigation when that successor is missing from the original list snapshot. No remaining specification finding was established in this correction.

**Code quality: PASS for the fix diff.** No new actionable Critical, Important, or Minor finding was established in the changed code. This is a scoped correction review, not a repeat whole-branch audit.

## What resolves F1

`loadDetail` now merges the exact successfully fetched, authorized assembly and its revision state into cached history. This happens only after response success, a returned assembly, and the existing mounted/request-token checks. Fresh content and mutation/review permissions still come from that detail response's independent server flags; merging the row does not invent permission or authority.

The renderer now includes the selected open assembly ID even when the cached list lacks it. Before successful detail, this row contains an ID placeholder and the existing loading/error/retry panel. It supplies no contributor or review controls. Thus an unseen target's deferred request is announced, its failed request has visible error and retry, and the existing failure path invalidates cached authority. A successful exact-target retry merges and displays the successor without needing a list refresh.

Rendered handlers and state lookups consistently use the selected `assemblyId`, including review, revision, incomplete-link retry, refresh, errors, and submission state. Baseline/current-head navigation remains server-driven; old baseline detail closes on successor navigation, and successful baseline reads remain available for history comparison.

## Verification evidence

The two added regressions both start with a list containing only the baseline and a detail pointer to an unseen successor. The success case checks successor fingerprint/changed content, contributor controls, fresh approval, absent baseline detail, exactly three reads before baseline navigation (no list refresh), and a return to the preserved baseline. The deferred failure case checks announced loading, visible error and retry, absent mutation/approval controls, and exact-target recovery through fresh detail.

Worker evidence: both unseen-target tests failed before the production correction; covering revision/review/history UI verification passed **31 tests across 3 files** after it (18 revision UI, 8 review UI, 5 history UI). Typecheck, changed-file lint, and diff whitespace verification passed. These results were inspected from the appended report; no unchanged tests were rerun here.

Reviewed `/private/tmp/kan39-frontend-fix-review-package.diff` and the appended fix evidence in `/private/tmp/kan39-frontend-report.md`, using the original finding/spec context already reviewed. No source edits, git writes, subagents, or test reruns. The only file written is this re-review report. Full-suite integration remains controller-owned, and the earlier unexplained timeout/browser/provider/scale limitations are unchanged.
