# KAN-159 Initial Objective Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow first objective entry in a blank or resumed draft without a revision reason, preserving audit and priority safeguards for later changes.

**Architecture:** Extend the existing wizard guard and transactional setup objective synchronizer. Use the presence of persisted objective records, never saved_at or client flags, as the initial-creation boundary. Record initial creation attribution with an explicit system description when the caller supplies no reason; preserve user reasons when supplied.

**Tech Stack:** Next.js 16.3.8, TypeScript, Drizzle/Postgres, Vitest, Playwright.

**Spec:** https://synapse21.atlassian.net/browse/KAN-159 (fetched 2026-10-25). Acceptance requirements copied below.

## Global Constraints

- A blank workspace completes initial setup with no revision reason.
- Reloading a partial draft before creating its first objective still works without a reason.
- Editing an existing objective/context still requires a meaningful reason server-side.
- Linked gaps retain priority-review safeguards.
- Preserve creation attribution and later edit history.
- Do not rely only on saved_at: earlier wizard sections save drafts before the first objective is entered.
- Keep existing transaction, stale-write, authorization, deletion and priority-review protections.
- Restrict work to KAN-159; do not change unrelated uncommitted work. Use existing TypeScript test frameworks for this TypeScript application.

## Review Focus

- Persisted draft with saved_at but no objectives permits first creation.
- Existing objectives cannot evade rationale by clearing client IDs, adding replacements, or mixing creation with edits.
- First objective save returns IDs; subsequent edits immediately require a reason, including before setup completion.
- Creation history includes actor and add records even without a user reason.
- Existing linked objective context changes still invalidate priority validation while retaining scores/history.

### Task 1: Distinguish initial objective creation from revisions end to end

**Files:**
- Modify: `src/components/setup/setup-wizard.tsx`
- Modify: `src/lib/iegp/store.ts`
- Test: existing setup route/store tests (`tests/setup-*.test.ts` or a focused new `tests/kan-159-initial-objectives.test.ts`), `tests/objective-priority-context.test.ts`
- Test: `e2e/features/setup-wizard.spec.ts`, existing objective-priority Playwright spec

**Interfaces:**
- Consumes: existing `saveProductSetup`, `syncSetupObjectives`, `PlanningContext`, `POST /api/iegp` with `save_product_setup`.
- Produces: same interfaces and persistence schema; only first creation rationale exemption changes.

- [ ] Step 1: Add route/store regression tests using current workspace/session helpers. Assert a blank workspace saves its first objective without reason, partial draft save + reload still permits first creation, and history retains actor/action. Assert later edits (including key_decision/date and global lifecycle/indication/geography) fail without meaningful reason, leaving persisted state/history unchanged. Assert later additions/replacements do not bypass the existing rationale policy. Include a mixed insertion/edit transaction rollback case if the existing helpers allow it concisely.
- [ ] Step 2: Run focused Vitest regression tests before implementation and record expected failure proving creation currently requires a reason.
- [ ] Step 3: In the store, determine first creation from locked persisted state.objectives being empty. Exempt only initial creation from requireRationale; give add history a meaningful creation description when no meaningful user rationale is supplied. Later insertions and all existing edits/deletions retain existing rationale validation. Preserve transaction and priority code unchanged.
- [ ] Step 4: In the wizard, show/require the revision-reason UI only for changes when baseline already has persisted objectives. Preserve the baseline update from server response, so a second edit requires a reason. Do not use saved_at or isNew as exemption criteria.
- [ ] Step 5: Update initial setup browser regression to complete without filling a reason; reload the saved pre-objective draft before adding objectives. Assert revision-reason field is absent during initial entry. Add/assert later edits are blocked without reason and succeed with reason; use existing test helpers and avoid unrelated visual changes.
- [ ] Step 6: Run `npx vitest run tests/kan-159-initial-objectives.test.ts tests/objective-priority-context.test.ts` (adapt first filename if extending existing tests), `npx playwright test e2e/features/setup-wizard.spec.ts e2e/features/objective-priority-context.spec.ts` (confirm actual existing filename), and typecheck/lint for changed files. Use a dedicated test server/port and test database. Record any environment blocks honestly; do not use a developer database. Run the full Vitest suite once before handoff if feasible.
- [ ] Step 7: Self-review diff and write task report with RED/GREEN commands/results, changed files, and limitations. Do not commit or push: controller owns git publication and will commit the reviewed deliverable.
