# KAN-215 / KAN-216 setup reasons implementation plan

> Execute using ticket-agentic-development and subagent-driven-development.

**Goal:** Preserve untouched demo objectives and collect required change reasons in a dismissible pop-up.
**Architecture:** Fix metadata application in syncSetupObjectives, the existing owner of objective persistence. Extend SetupWizard's save flow using the installed shared Dialog; retain the requested continuation until confirmation succeeds.
**Spec:** Jira KAN-215 and child KAN-216; user explicitly requests a pop-up with an exit option and execution through ticket-agentic-development.
**Stack:** Existing Next.js/React/TypeScript, Base UI Dialog, Vitest and Playwright. No new dependencies.

## Global Constraints
- Initial objective creation needs no user reason. Actual later objective/context revisions still require the existing meaningful reason rule.
- Untouched per-objective lifecycle, indication and geography must survive unrelated setup saves, including a demo with no saved planning context.
- Cancel, close and Escape dismiss the dialog without saving, navigating or losing setup edits or draft reason. Successful save clears the reason.
- Keep failure recovery visible inside the dialog, preserve drafts, block duplicate submissions and resume the original Continue/Finish/tour action only once after successful confirmation.
- Reuse existing UI patterns; preserve impact warnings, authorization, transaction locks, concurrency checks and audit history.
- No merge, deployment, unrelated refactors or new dependencies. Parent owns git commit/push/PR/Jira; all published commits go to both configured remotes.

## Review Focus
- Demo/no persisted planning context: no accidental metadata rewrite.
- Partial shared-context changes: apply only the changed dimension.
- Server rejects a reason unexpectedly: show an input and retry action immediately.
- Dismissal/slow save: no stale continuation or duplicate request.
- Finish with tour versus Continue: preserve original action and route.

### Task 1: Preserve untouched objective metadata
**Ownership:** src/lib/iegp/store.ts and tests/setup-wizard-store.test.ts only.
**Interfaces:** Keep saveProductSetup and syncSetupObjectives signatures. Compare submitted shared values to setupContextFromState(state), the same baseline visible to the user; check its existing implementation/import before choosing the minimal fix.
- [x] Add regressions proving a name-only seeded demo setup save succeeds without a reason and preserves every objective's lifecycle/indication/geography and edit history; test absent saved planning context.
- [x] Add regressions proving a changed shared dimension requires a reason and changes only that dimension; unchanged dimensions retain per-objective values. First creation remains reason-free.
- [x] Run failing tests first, then change syncSetupObjectives to apply shared metadata only for new objectives or dimensions actually changed relative to the displayed baseline. Preserve old lifecycle storage spelling when normalized value is unchanged; preserve existing fallback rules for new records.
- [x] Run npm test -- tests/setup-wizard-store.test.ts and related objective-context regressions; report exact commands/results and any DB limitation.

### Task 2: Add the dismissible reason dialog
**Ownership:** src/components/setup/setup-wizard.tsx; tests/setup-wizard-dialog.test.tsx (new); e2e/features/setup-wizard.spec.ts if needed for real browser keyboard/focus proof. Minimal local helper/component allowed only if clear ownership requires it.
**Interfaces:** Consume unchanged save_product_setup API and Task 1 persistence behavior. Use shared components/ui/dialog.tsx. Read relevant installed Next.js use-client guide, frontend skills, and current e2e/component patterns before editing.
- [x] Write interaction regressions first using installed Vitest/jsdom/React DOM tooling, or existing Playwright patterns where more appropriate. Test opening on a revision save, labelled input, short-reason validation, cancel, close/Escape with drafts retained, no request/navigation on dismissal, confirm with reason, failed-save retry, unexpected reason-required rejection recovery, reason cleared after success, duplicate prevention and original Continue/Finish/tour continuation. Include initial creation without dialog.
- [x] Replace the inline reason editor with a shared accessible Dialog at the save decision. Keep objective impact warnings accessible. Store the pending intended action explicitly and share the actual persistence function; do not let a deferred promise survive dismissal. Preserve errors/reason during retry. Use existing server reason error contract and make narrow scoped machine-readable identification only if the existing response cannot distinguish it reliably.
- [x] Use Cancel and the shared close button, Escape and native dialog focus behavior. Disable dismissal while a request is actively saving, because cancellation cannot undo a committed request; allow dismissal before submission and after failure. Explain saving state. Reopening retains drafts.
- [x] Run focused dialog and setup render/store regressions plus npm run typecheck and targeted eslint. Run targeted browser tests for keyboard/focus if available; report environmental blockers accurately.

## Delivery evidence

- Implemented by separate bounded store and dialog agents. Both task reviews approved specification compliance and code quality. A fresh whole-branch reviewer independently approved both verdicts with no findings.
- Store regressions passed 35/35 across setup and objective-context tests. Interactive dialog/render regressions passed 24/24, after recording failing regressions first.
- Chromium setup suite passed 4/4, including native focus containment/restoration, Escape/Cancel/close, retained drafts and no save request on dismissal.
- Typecheck passed. Full lint passed with no errors and 16 existing warnings. Whitespace check passed.
- Full-suite result and latest PR checks are recorded in the PR and Jira completion comments.
- Unexpected reason-required recovery depends on the existing server validation message. A future contract change must update that consumer or introduce an error code.
