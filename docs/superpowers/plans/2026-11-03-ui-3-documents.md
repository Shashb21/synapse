# UI-3 Experiment Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Make owner-only experiment documents understandable and easy to add.
**Architecture:** Extend the existing DevelopmentSetup UI and reuse existing owner APIs, experiment persistence and fixed copies. Keep API schemas and generation/reference roles unchanged. Use existing UI styles.
**Tech Stack:** Next.js 16, React, TypeScript, Vitest, Playwright.
**Spec:** https://synapse21.atlassian.net/browse/UI-3 (acceptance criteria reproduced in Task 1).

## Global Constraints
- Preserve experiment isolation, authorization, fixed document identities, frozen execution history, concurrency protection and spending safeguards.
- Do not alter customer workspaces, shared model routing, pipeline algorithms or human-review semantics.
- No paid calls; use isolated persistence and scripted parsing responses.
- Branch from and target updated-dev-environment-ui per owner's ticket comment. Publish to both origin and github. Leave PR open.
- Each agent must run commands inside /private/tmp/synapse-ui3. Preserve others' changes. No nested subagents.

## Review Focus
- Discovery failure must preserve a persisted experiment and unsaved name/file/reference selections.
- A private-only experiment must never appear bound to a workspace or silently rebind.
- Missing original and missing parse require different actionable guidance.
- Optional references remain evaluator-only and cannot become generation documents.
- Labels and success/error/progress announcements must work with keyboard and narrow screens.

### Task 1: Document selection, recovery and persistence experience

**Files:** Modify src/components/development/development-setup.tsx; extend src/modules/development/documents.ts only for user-facing safe error messages if needed; update affected Development e2e labels/assertions; tests/kan-201-development.test.ts; add e2e/features/development-documents.spec.ts if useful. A focused document UI component/helper is allowed only if it clarifies ownership.
**Interfaces:** Existing /api/admin/development APIs and Experiment/DevelopmentDocument schemas remain authoritative. No second document system or rebinding endpoint.

Acceptance criteria:
- Use “experiment document” for saved inputs and an action such as “Add a copy to this experiment”; remove “source snapshot” from ordinary user-facing controls/messages.
- Explain workspace selection before creation: experiment bound to one selected workspace; “Private uploads only” exposes no existing workspace documents.
- Existing private-only experiments explain uploads or creating a new experiment bound to desired workspace; no silent rebinding.
- Offer understandable Workspace documents and Upload files paths. Select eligible workspace file or supported upload, announce preparation progress, show saved document after reopening.
- Show names and useful status first; origin, identifiers and fixed-copy metadata under Document details. Explain once fixed copy enables reproducibility without changing original.
- Distinguish empty workspace, discovery failure, unselected document, unsupported/empty/oversized upload, missing retained original, missing readable parse; recovery action for each.
- Refresh choices without losing persisted experiment or unrelated edits after discovery fails. Retry reads only, never recreate experiment.
- Preserve experiment-local storage, one-workspace boundary, revision checks, server authorization and immutable customer originals/parsed artifacts.
- Optional gold standards clearly separate from generation inputs; never sent as generation documents.
- Clear labels, keyboard access, announced success/errors.
- Demo selection, parsing algorithm changes and live synchronization are out of scope.

- [x] Inspect existing behavior and relevant Next docs before edits. Read impeccable/reference/craft-floor.md, impeccable/reference/clarify.md and uncodixfy skill; preserve incumbent design. No PRODUCT.md or DESIGN.md exists in this worktree.
- [x] Run baseline npx vitest run tests/kan-201-development.test.ts tests/ui-2-development-workflow.test.ts. Add failing behavioral regression coverage for changed recovery and labels. Explain Arrange/Act/Assert in report.
- [x] Implement UI and safe errors with existing serialization/abort/stale checks. Avoid changing backend behavior when existing tests already prove invariants.
- [x] Extend API tests where needed for missing retained original/parse, persistence, ownership/malformed input/no customer writes. Run npx vitest run tests/kan-201-development.test.ts tests/ui-2-development-workflow.test.ts plus new tests.
- [x] Update existing browser selectors everywhere affected (search all Development specs) and add focused flow for workspace choice explanation, discovery recovery with edits retained, import/upload/reopen. Run npx tsc --noEmit and targeted eslint. Controller handles browser infrastructure if unavailable.
- [x] Self-review and write task report with changed files, tests (commands and exit codes), risks, remaining browser checks. Do not commit or push: controller owns git publication.

## Delivery evidence

- Original task review approved after regression fixes: failed discovery recovery remains available after successful saves/uploads, and browser import asserts the selected workspace-file ID.
- Fresh whole-branch review approved requirement compliance, quality and security; its two minor wording findings were fixed in one bounded wave and received scoped re-review.
- API/workflow tests: `npx vitest run tests/kan-201-development.test.ts tests/ui-2-development-workflow.test.ts` — 29 passed against isolated PostgreSQL.
- Execution/stage tests after final wording changes: `npx vitest run tests/kan-202-execution.test.ts tests/kan-202-stages.test.ts` — 67 passed.
- Affected browser set: `npx playwright test e2e/features/development-{documents,setup,workflow,execution,history}.spec.ts` — 32 passed against task-owned port 43253 and isolated database on port 55453.
- TypeScript, targeted ESLint and diff whitespace checks passed. Desktop 1440px/mobile 390px and keyboard-operated expanded details checked.
- Browser workspace import scripts the existing API boundary and persists via real upload. Real workspace imports, ownership, malformed inputs, missing original/parse, revisions and immutable customer tables are covered by API tests. No paid calls.
- Task database container: `synapse-ui3-verification`; PostgreSQL volume `b5e1d27ce61631c9e050ba5f8dce70e18b49da8bccc5e7c6a7950c2582c8ab4a`. Stop while idle; preserve volume and defer container removal until PR merge/acceptance.

Decisions: use the owner-directed integration branch; reuse existing persistence and native controls; keep parsing algorithms and customer data unchanged. The explicit ticket workflow authorizes implementation, independent reviews and publication without routine approval pauses. Native subagents fulfil its required review workflow. No schema or dependency changes.

Final reference-announcement browser proof after wording changes: `npx playwright test e2e/features/development-setup.spec.ts -g "owner creates, uploads, saves and reopens a private experiment"` — 2 passed (authentication and scenario). Scoped final review: both wording findings addressed, no fix breakage.
