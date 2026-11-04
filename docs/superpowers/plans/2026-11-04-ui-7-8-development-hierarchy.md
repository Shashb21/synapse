# UI-7 and UI-8: Development hierarchy and spacing

Base: `updated-dev-environment-ui` at `1998077274eb49e0cb585f1aa156e659c8f8578e`.
PR target: `updated-dev-environment-ui`. Leave the PR open.
Requirements: https://synapse21.atlassian.net/browse/UI-7 and https://synapse21.atlassian.net/browse/UI-8 (subtasks of UI-1).

## Global Constraints

- Preserve the existing font and palette. Keep styles local to Development; no global descendant overrides.
- Preserve all content, controls, disabled-action reasons, warnings, live feedback, privacy boundaries and saved evidence. Do not change APIs, persistence, execution/evaluation behavior, disclosure defaults, or rewrite copy (UI-9/UI-10).
- Use page title 24px/32px; experiment and active-step titles 20px/28px; subsection headings and legends 16px/24px semibold; explanations 14px/24px regular muted; form labels 14px medium; technical metadata 12px/20px. Keep long explanatory text around 65 characters per line.
- Maintain semantic heading order and accessible fieldset legends. Long names, IDs and hashes wrap without whole-page horizontal overflow.
- Use a local 4px spacing scale: approximately 8px label/control, 12px heading/explanation, 16px related fields, 24px subsections, 32px major sections. Group helpers with controls; toolbars wrap; forms become one column on narrow screens without changing DOM/keyboard order.
- Work only in /private/tmp/synapse-ui1-review. You share the repository; preserve others' edits. No merge. Only the controller publishes commits and PRs.

## Task 1: Apply hierarchy and spacing as one presentation batch

Own `src/app/admin/development/page.tsx`, `src/components/development/*` presentation, and narrowly relevant UI verification. Trace the existing markup and its component nesting before changing it; read the relevant installed Next.js guide before editing. The setup owns creation/selection, the experiment title and workflow nav; execution owns active settings/run/results; nested components own their headings, fieldsets and gaps. Apply the Global Constraints across documents, demo files, routes, execution history, results, evaluation, comparison and costs. A small shared role module containing static class strings is appropriate if it removes repeated styling; avoid new component architecture or runtime configuration.

The audit at the base found the h1 was 20px/28px, h4 headings and legends were usually 14px/20px (same as paragraphs), and most groups used 8–12px gaps. Inspect /private/tmp/ui1-Documents-desktop.png, /private/tmp/ui1-Results-desktop.png and /private/tmp/ui1-Documents-mobile.png as incumbent visual evidence. There is no PRODUCT.md or DESIGN.md in this worktree. Keep its existing identity. Impeccable context launcher is unavailable; use source and screenshots directly. Read /Users/calixtan/.agents/skills/impeccable/reference/craft-floor.md before editing UI.

Verification: run `npx tsc --noEmit`, targeted ESLint for changed files, and relevant existing unit tests (UI-2/UI-5/UI-6 and results). Do not write tests that mirror CSS class strings. Add a behavioral or rendered test only when it proves accessibility, overflow or meaningful grouping. The controller will inspect rendered pages at 1440, 390 and 720px, including long content and optional panels, and run browser tests using a temporary isolated server/database. Preserve semantic heading order in all workflow steps.

Report changed files, command/results, self-review, limitations and any deferred acceptance criteria. Do not commit, push, spawn agents, or start persistent servers. Return status and the report path.

## Delivery evidence

- Implementation and independent task review completed, including one fix round for real label/control spacing, heading/explanation grouping and reference filename emphasis.
- A fresh whole-branch reviewer approved requirement compliance and code quality with no outstanding findings. Review included preservation of visible copy, handlers, disabled states, warnings and disclosure defaults.
- `npx tsc --noEmit`, scoped ESLint including the new browser spec, and `git diff --check`: passed.
- `npx vitest run tests/ui-2-development-workflow.test.ts tests/ui-5-development-readiness.test.ts tests/ui-6-results.test.tsx tests/kan-205-results.test.tsx`: 4 files, 56 tests passed.
- `E2E_REUSE=1 E2E_PORT=43229 E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55449/synapse_ui1_review npx playwright test e2e/features/development-hierarchy.spec.ts`: 2 tests including authentication setup passed. All four steps retained heading order and wrapped long saved evidence at 1440, 390 and 720px.
- Supplemental populated reference/evaluation/comparison/spending checks passed at all three widths: reference filenames 14px/500, heading/explanation gaps 12px, measured label/control gaps 9px, no whole-page horizontal overflow or browser errors. These checks used synthetic evidence and did not call paid providers.
- Local full-suite attempt encountered an unchanged learning-browser fixture failure: Turbopack rejects the worktree's dependency symlink pointing outside its filesystem root. Clean hosted CI is the full-suite gate; do not claim the local full suite passed.
- Temporary verification resources: server on 127.0.0.1:43229; container `synapse-ui1-review-preview`, Postgres port 55449, volume `5a8633d86e4c8ca7f86067b67bb232eb22a25f6ae59158cfd15ec78701dbdd22`. Stop task-owned processes and container when idle; retain the volume pending PR acceptance.

UI-9 owns copy shortening and routine status cleanup. UI-10 owns optional management/evidence disclosures. Those changes are intentionally separate from this presentation batch.
