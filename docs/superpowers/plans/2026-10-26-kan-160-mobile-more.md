# KAN-160 Mobile More Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Keep the mobile navigation sheet open for disclosure and non-navigation actions, and close it when a destination is selected.
**Architecture:** PlanChrome owns sheet state; NavLists passes an optional navigation callback to NavButton destination links. Native details/summary keeps its browser keyboard behavior. Desktop omits the callback.
**Tech Stack:** Next.js 16.3.8, React, TypeScript, Playwright, Vitest.
**Spec:** https://synapse21.atlassian.net/browse/KAN-160 (description retrieved October 26, 2026).

## Global Constraints

- More expands inside the open sheet; choosing a destination closes the sheet.
- More collapses again without closing the menu.
- Needs navigation remains reachable and closes the menu on selection.
- Restart walkthrough remains reachable.
- Desktop More behavior remains correct.
- Add a mobile Playwright regression covering disclosure expansion and destination navigation, plus keyboard access.
- Preserve unrelated user edits in the original checkout. No dependency changes or UI redesign.

## Review Focus

- Primary links close the mobile sheet, including same-page destinations.
- Secondary Needs link closes the sheet and reaches its URL.
- Native keyboard activation opens/collapses More and activates a destination.
- Non-navigation controls such as ThemeToggle keep the sheet open.
- Desktop disclosure and secondary links remain usable without a callback.

### Task 1: Fix sheet close ownership and add regression coverage

**Files:**
- Modify: `src/components/plan-chrome.tsx`
- Create: `e2e/features/kan-160-mobile-navigation.spec.ts`

**Interfaces:**
- Consumes: PlanChrome open/setOpen state; NavLists and NavButton; freshWorkspace from e2e/support/session.ts.
- Produces: optional `onNavigate?: () => void` on NavLists and NavButton, attached to each destination Link as an explicit selection handler. Only mobile NavLists receives `() => setOpen(false)`.

- [ ] Write Playwright tests using existing freshWorkspace isolation, at 390x844. Open Open places, toggle More twice, assert sheet stays open and Needs/Restart walkthrough are visible when expanded; select Needs, assert correct URL and hidden sheet. Add keyboard Enter/Space disclosure and Enter destination coverage, primary/same-page link closing, and a non-navigation control stays open. Include a desktop More smoke case with existing rail helper.
- [ ] Run the focused Playwright file before implementation and record a failure caused by the sheet closing on More. Use a dedicated E2E_PORT if another server exists; never target the developer database or kill unrelated servers.
- [ ] Add optional onNavigate callback to NavLists/NavButton and pass to primary and secondary links, removing blanket wrapper onClick. Read installed Next Link docs before editing. No stopPropagation workaround, custom disclosure, or route observer.
- [ ] Run focused Playwright file, npm test, npm run typecheck, and focused eslint. Record exact commands/results. Use existing Vitest/Playwright tooling for this TypeScript project.
- [ ] Self-review and report. Controller handles git commit, dual remote pushes, PR and CI monitoring.
