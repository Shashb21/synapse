# SDD ledger — plan: docs/superpowers/plans/2026-10-03-kan39-human-revisions.md

Jira: KAN-39. Base: bb35e95. Worktree: /private/tmp/synapse-kan39-worktree, branch KAN39.

Ruling: Continue under the recovered user authorization “Yes, do what you need to get the next tasks done” and requested subagent workflow — avoid repeating intermediate permission menus — a misunderstood design can require reviewable rework.
Ruling: Move the app-created worktree into writable /private/tmp using approved git worktree move — sandbox cannot edit its default location — app attachment may retain its former path.
Ruling: Keep generated and human origins distinct, with human revisions owning current review-head selection — avoids attributing corrections to model output — adds migration and lineage validation responsibilities.

| Check | Producer/consumer | Result |
| --- | --- | --- |
| Task 1 self | persistence/API tests against revision contracts | Consistent; exact API reported for Task 2 |
| Task 2 self | labeled forms against contributor authorization | Consistent; no raw JSON authoring |
| Task 1 → Task 2 | assembly API and review state | Frontend uses server contracts from accepted Task 1 |
| Task 1 ↔ Task 2 | src/app/api/accuracy/assemblies/route.ts | Task 1 owns API, Task 2 consumes only |

Baseline: npx vitest run tests/accuracy-assembly-approval-integration.test.ts --silent, exit 0, 49 tests. Initial sandbox run failed EPERM connecting localhost; approved escalation resolved environment restriction.

Task 1: dispatched via delegate-implement prepare/dispatch. Request /var/folders/q8/7gnlqcx94vv4wbg83v4865d00000gn/T/delegate_implement_20261003_163430_4pQOd_req.json; response sibling _res.json; terminal session 40994. Worker owns backend/API; no frontend, commits, Jira or publication.

Ruling: Delegate wrapper failed before edits; execute its prepared requirements through native /root/kan39_backend (gpt-6.1-sol high) — available transport preserves ownership/review — wrapper observation does not track native completion.
Ruling: Use nullable model run IDs plus explicit human origin metadata for corrected versions — human activity is not a model extraction run — downstream history consumers must handle null explicitly.
Ruling: Retry failed linking by creating an immutable checked completion artifact under the same revision operation — preserve blocked artifact and reuse successful pair runs — one revision can have both blocked and completed assembly records.
Jira In Progress confirmed by transition 21.

Task 1 implementation complete, awaiting independent /root/kan39_backend_review. Report /private/tmp/kan39-backend-report.md; diff /private/tmp/kan39-backend-review-package.md. Evidence: 167 distinct tests, typecheck/lint/diff check pass. No commit yet.
Ruling: Extend approved projection for opposite-kind human additions to a valid one-kind baseline; reject incompatible separately owned extraction scope — honor missing-item corrections without silent downstream omission — overlapping sources may need a coordinated future review flow.

Task 1 review: spec and quality changes required. Important F1: a later opposite-kind extraction owner marks the human revision stale in review, but live projection silently filters its addition and accepts old approval. /private/tmp/kan39-backend-review.md contains concrete sequence. Fix round 1 dispatched to original backend implementer with symmetric ownership regressions and downstream calls begun after ownership changes. Pre-fix snapshots: /private/tmp/kan39-backend-fixbase.

Task 1 fix round 1: F1 reproduced in both directions, including saved stale downstream status. Fix gates human revision heads with existing current-production ownership predicate before projection, retains generated/legacy projection. Covering tests 73/73 (14 revision, 49 approval integration, 10 review-store), typecheck/lint/diff check exit0. Scoped re-review pending; diff /private/tmp/kan39-backend-fix-review-package.diff.

Task 1: complete (bb35e95..eba5f92, review clean). F1 ADDRESSED by /root/kan39_backend_review in /private/tmp/kan39-backend-rereview.md; spec and quality pass, no new findings. Controller committed accepted backend at eba5f92, dual remote publication started.
Task 2 prepared request: /var/folders/q8/7gnlqcx94vv4wbg83v4865d00000gn/T/delegate_implement_20261003_170149_9rBqf_req.json. Native delegation transport will consume this prepared request, due prior wrapper launch failure. Base eba5f92.

Ruling: Use existing gh authentication as a command-local Git credential helper for HTTPS publication — push-both succeeded on origin then lacked HTTPS credentials for github — requires working gh login but saves no token/config.
Task 2 dispatched /root/kan39_frontend (gpt-6.1-sol high), owns frontend/tests/guide; no backend edits without coordination.

Task 2 implementation/report complete, fresh /root/kan39_frontend_review pending. Report /private/tmp/kan39-frontend-report.md, diff /private/tmp/kan39-frontend-review-package.md. 16 new UI tests+13 existing UI pass; combined UI/API/revision unchanged rerun 51/51 passes, typecheck/lint/diff pass. Earlier DB auth test timed out with976s elapsed; cause unknown, evidence retained. Overnight interruption recovered completed session8634 (exit0); no active worker test sessions remain.
Ruling: Continue the previously authorized push-and-PR workflow against dependency KAN38, preserving the isolated branch — makes the next task reviewable without merging a shared branch — changes remain pending PR integration.

Task 2 review changes required: Important F1 unseen successor absent from cached list is fetched but cannot render. Report /private/tmp/kan39-frontend-review.md. Fix round1 dispatched original frontend worker; require successful unseen-target fresh detail and failed navigation visible retry/control-denial regressions. Snapshots /private/tmp/kan39-frontend-fixbase.

Task2 fix round1: F1 reproduced (2 failing unseen-successor tests); fixed pending target rendering and merge exact authorized fetched detail/revision state into list. 31UI tests passed, typecheck/scoped lint/diff pass. Scoped reviewer pending; diff /private/tmp/kan39-frontend-fix-review-package.diff. No backend changes.

Task 2: complete (eba5f92..2bf2b75, review clean). F1 ADDRESSED, spec/quality pass in /private/tmp/kan39-frontend-rereview.md. Accepted frontend committed2bf2b75; push-both with temporary gh helper started. Native attach_worktree at moved path refused (not managed); physical Git worktree remains valid and retained.
Final integration: full Vitest session40609, log /private/tmp/kan39-full-vitest.log; wholebranch /root/kan39_final_review (gpt-6-astra high), diff /private/tmp/kan39-whole-branch-review-package.diff, report /private/tmp/kan39-final-review.md pending. Basebb35e95..head2bf2b75. No Critical/Important task findings remain open.

Resume 2026-10-05: final reviewer changes required F1 human revisions labeled judged final output in existing ClaimHistory. Single final correction wave resumed /root/kan39_frontend; report /private/tmp/kan39-final-fix-report.md. Full suite completed: 4 files failed, 24 tests failed,984 passed, duration5483s; original log retained /private/tmp/kan39-full-vitest.log. Timeouts plus cleanup FK and CONNECTION_ENDED cascade require diagnosis; /root/kan39_suite_diagnosis owns read-only reproduction. No Done claim.
Both named remotes verified via ls-remote at2bf2b75; no existing KAN39 PR. Final fixer and suite diagnosis both hit model capacity, edits/results preserved. Resumed through fresh gpt-6-sol high workers /root/kan39_final_fix_resume and /root/kan39_diagnosis_resume with file-backed context. Original diagnosis confirmed four direct serialization tests4/4 independently3.24s; root stall cause not yet established.
Final correction F1: mixed-origin tests failed2before fix; human row now shows contributor/reason/revision/parent/predecessor without generated run labels. Resumed verification42UItests passed,typecheck/scopedlint/diffcheck passed. Report /private/tmp/kan39-final-fix-report.md; scoped final re-review pending /private/tmp/kan39-final-fix-review.diff.
Final F1 scoped re-review PASS /private/tmp/kan39-final-rereview.md, no new breakage; accepted correction commita40bcaf. Both required named pushes initiated with command-local SSH override. Read-only suite diagnosis found no consistent failure: direct race4/4pass; remaining three affected suites62/62pass28.68s. Original root stall unknown; cleanup FK/CONNECTION_ENDED cascade retained. Full final-suite rerun started /private/tmp/kan39-full-vitest-final.log.
Publication: origin push a40bcaf succeeded; github command-local remote.url override still used HTTPS for push (credential failure). Command-local remote.github.pushurl SSH override now launched; no persistent remote/auth configuration changed.

Final verification: npx vitest run --silent exit0,91files/1010tests passed169.08s at a40bcaf; log /private/tmp/kan39-full-vitest-final.log. Earlier failed run retained, cause unknown; no masking timeout changes. Final whole-branch review plus one correction/re-review clean. Both remotes ls-remote confirmeda40bcaf. Review artifacts preserved docs/superpowers/reviews/2026-10-05-kan39 before scratch cleanup.

Completed lifecycle: PR https://github.com/Shashb21/synapse/pull/79 created againstKAN38 and attached. Jira comment10376 saved implementation/proof/limitations; transition41 confirmedDone. Assigned eligible query (Ready absent on site; To Do queried) selected KAN40 by Mediumpriority and earliest creation; both dependenciesDone; full context saved /private/tmp/kan40-next-issue.json. Handoff armed session01a10261-2258-7092-9f6c-ef8efdf16350. Review workspace cleanup only after retained archive; physical Git worktree retained for PR feedback.
