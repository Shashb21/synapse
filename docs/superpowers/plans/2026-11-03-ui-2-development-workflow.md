# UI-2 Development workflow implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the owner Development workflow understandable as Documents → Test settings → Run → Results.
**Architecture:** Retain the setup and execution state owners and existing APIs. Use four accessible navigation buttons and mounted, hidden step sections to preserve native file inputs and component state. Execution owns settings, run and results, and reports a small saved-state progress summary up to setup for navigation/guidance, without extra requests. Step navigation itself must neither fetch nor save.
**Tech Stack:** Existing Next.js 16, React 19, TypeScript, Tailwind, Vitest and Playwright.
**Spec:** https://synapse21.atlassian.net/browse/UI-2 (fetched 2026-11-03).

## Global Constraints

- Preserve experiment isolation, authorization, fixed document identities, frozen execution history, concurrency protection and spending safeguards.
- Do not alter customer workspaces, shared model routing, pipeline algorithms or human-review semantics.
- Keep experiment creation/reopening, documents, all model settings and role overrides, execution modes, individual section runs, costs, evaluation, history and comparison accessible.
- Preserve in-progress edits across step navigation and avoid unnecessary API calls or data-model changes.
- Provide keyboard-accessible navigation, visible focus, correctly associated labels and useful screen-reader structure. Layout remains usable at narrow mobile widths and 200% zoom.
- Use isolated test persistence and scripted model responses; no paid calls.
- Do not replace the site's font system or implement dependent document-choice/button-explanation/results-simplification tickets.

## Review Focus

- Opening another experiment must reset guidance to that experiment; no stale execution summary.
- Hidden steps must retain native selected files, name edits, settings, cost controls and evaluation edits without remounting.
- Failed or queued executions must not appear as successful completion; reopening uses saved history.
- Hidden controls must not remain keyboard focusable; focus remains visible after navigation.
- Narrow layouts and long document/experiment identifiers must wrap without page overflow.

### Task 1: Reshape the existing Development page and prove the workflow

**Files:**
- Modify: `src/app/admin/development/page.tsx`, `src/components/development/development-setup.tsx`, `src/components/development/development-execution.tsx`.
- Create focused UI workflow helpers/components in `src/components/development/` if needed for clear ownership.
- Modify related Development presentation files only where needed to hide technical details or correct heading hierarchy.
- Tests: focused `tests/ui-2-development-workflow.test.ts[x]`, `e2e/features/development-workflow.spec.ts`, and adapt existing `e2e/features/development-*.spec.ts` to navigate/reveal controls they exercise.

**Interfaces:**
- Consumes existing Experiment documents, execution configuration/history/loading/errors and delivery state. Retain API contracts and guarded run behavior.
- Produces navigation and state-derived next-action guidance; internal prop signatures can be defined by implementer, no new public API.

- [ ] Write focused failing Vitest tests for state-derived guidance: new draft/no documents, saved source/no run, active run, saved success, failed run and loading/unavailable history. Test both selected step and completion/attention labels. Use saved facts, never claim settings saved just because defaults loaded or a user visited a step.
- [ ] Run those tests to establish failure, then implement the workflow in the existing state owners. Four semantic step headings, ordered navigation with `aria-current="step"`, explicit Current/Complete/Needs attention/Not started or equivalent text, restrained existing accent. Support free navigation without losing edits. Opening an experiment chooses a useful step after history loads, but background polling must not forcibly navigate. Failed history loads must not imply no history.
- [ ] Put source documents and saved document list in Documents; reference uploads in a clearly labelled expandable optional evaluation area. Put mode, model routes, overrides and legacy evaluator in Test settings; uncommon settings in labelled details. Put cost controls, preview, safeguards and run actions in Run. Put history, evaluation and comparison in Results; move long IDs/provenance to labelled details while retaining decision-critical instructions. Keep an experiment heading/name controls clearly separate, with technical draft details expandable. Correct page intro to include running and evaluating here.
- [ ] Use coherent type scale, weight, spacing and contrast in the scoped surface, normal existing UI controls, no decorative redesign. Read relevant installed Next docs before writing code. Read impeccable craft floor and uncodixfy already supplied by controller.
- [ ] Add browser tests using existing isolated test conventions, mocked/scripted provider responses only: new/reopened experiment, next action changes after source save and saved execution, file/name/model edits persist across navigation, all advanced features reachable, keyboard navigation, 390px mobile and 200% zoom equivalent layout. Capture desktop/mobile screenshots for controller inspection. Update existing Development specs as necessary for navigation/details while preserving their behavioral assertions.
- [ ] Run focused Vitest tests, changed-file ESLint and `npx tsc --noEmit`. Run the Development Playwright specs using isolated persistence. Record exact commands, results and any baseline failures. Do not use main app DB, start paid calls or kill other processes.
- [ ] Self-review and report changes, test evidence, limitations and screenshot paths in task report. Do not commit/push; controller handles git publication after review.
