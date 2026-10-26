# KAN-164 Review Task Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Allow Evidence Inventory review tasks to open, close, reopen, and switch using the existing next-action disclosure.

**Architecture:** Keep ownership in GapsWorkbench's existing openId and focusTask state. Toggle the current row closed, explicitly focus its disclosure button, and preserve task focusing on open. Native button semantics supply Enter and Space activation without custom keyboard handlers.

**Tech Stack:** React, Next.js, Vitest, Playwright.

**Spec:** https://synapse21.atlassian.net/browse/KAN-164 (fetched 2026-10-26).

## Global Constraints

- Users can open and close the same inline review row using mouse and keyboard.
- aria-expanded accurately reflects visibility.
- Opening another gap does not leave multiple review rows open.
- Opening still focuses the relevant review task; closing restores sensible focus.
- Add regression coverage for open, close, reopen and switching gaps.
- Keep this a focused fix; no dependencies, unrelated refactors, or design changes.

## Review Focus

- Close when focus is inside the expanded row: return focus to its trigger.
- Reopen after close: focus the relevant task again.
- Switch to a second gap: only its review region remains.
- Enter and Space: browser tests exercise native activation.
- Existing primary task priority and remaining-task behavior remain intact.

### Task 1: Toggle inline review tasks and cover disclosure behavior

**Files:** Modify src/components/gaps-workbench.tsx, tests/kan-115-next-action.test.ts, e2e/features/kan-115-next-action.spec.ts.
**Interfaces:** Consumes existing GapsWorkbench props, openId, focusTask, and InventoryReviewTasks. Produces no new public interfaces.

- [ ] Add failing Vitest coverage for a closed initial row (aria-expanded=false), open (true and relevant task focused), second click close (false, region absent, trigger focused), reopen (true, task focused), and switching two gap cards (one region, previous trigger false). Use existing test fixtures. Existing tests that click an already-open trigger to change focus must explicitly close/reopen or render fresh state to reflect the new contract.
- [ ] Run npx vitest run tests/kan-115-next-action.test.ts and record the expected close failure before implementation.
- [ ] In the existing Button onClick, if open, clear openId, focus event.currentTarget, and return; otherwise retain existing open/focus behavior. Use a native button, no custom key handler. Preserve existing labels.
- [ ] Extend the Playwright feature test with mouse open/close/reopen plus Enter and Space open/close, checking aria-expanded, region visibility, opening task focus, and closing trigger focus. Cover switching in unit tests and real browser if fixtures permit reliably.
- [ ] Run npx vitest run tests/kan-115-next-action.test.ts; npm run typecheck; npx eslint src/components/gaps-workbench.tsx tests/kan-115-next-action.test.ts e2e/features/kan-115-next-action.spec.ts --max-warnings=-1. Report commands and outcomes. Browser coverage will also run in GitHub CI with an isolated Postgres service.
- [ ] Self-review and report. Controller owns commits, push, PR, and Jira lifecycle.
