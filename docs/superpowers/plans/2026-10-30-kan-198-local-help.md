# KAN-198 Supporting Text Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and independent task and whole-branch review.

**Goal:** Make current tasks, state and next actions clear while preserving essential guidance and scientific content.
**Architecture:** Refine existing component copy and use native details/summary for local optional help. Keep forms and essential feedback outside disclosures. No new dependency or preference state.
**Tech Stack:** Next.js 16, React 19, Tailwind, Vitest, Playwright.
**Spec:** https://synapse21.atlassian.net/browse/KAN-198 (current ticket fetched 2026-10-30).

## Global Constraints

- Keep critical information visible: error/warning summary and recovery, blocked reason, required input/format, permissions, global scope, irreversible action warnings, stale/conflicting data, unsaved state and next step.
- Preserve scientific/domain meaning, user-entered content, rationale and audit/history records.
- Optional help is local, named, initially collapsed and reversible. Reuse existing advanced-routing/history/review disclosures; no nested/duplicate disclosure systems.
- Keyboard operation, visible focus, accessible expanded state, desktop/390px/200% zoom and light/dark readability are required. Never shrink/truncate text to reduce density.
- Toggling help must not reset inputs, selection or unsaved drafts, save, navigate, hide new errors or move focus unexpectedly.
- Preserve owner authorization, credential secrecy, manual flows and sibling changes. KAN-193/194/197 are Done on current main; KAN-196 developer tools remains separate.
- Work only in /private/tmp/synapse-kan198, branch feat/kan-198-local-help, baseline 71e2fdab. Other worktrees contain unrelated changes and must be preserved.
- Use installed Vitest/Playwright (not Python pytest for TypeScript). Test behavior rather than incidental prose/classes. No new public functions/classes without behavior tests.

## Review Focus

- Long user/scientific content remains intact and wraps at narrow widths.
- Help opened while a form is dirty must retain inputs and selected record.
- Errors raised with help closed stay visible with recovery.
- Global actions keep their scope and consequential warnings visible.
- Owner setup instructions stay available without implying customers manage keys.

### Task 1: Inventory and refine supporting text across existing journeys

**Ownership:** src/components/platform/ai-switch-panel.tsx, provider-panel.tsx and supporting guidance in workspace/settings/setup/upload/review/priority/tactic/timeline components and associated pages; scoped CSS only if needed for readable disclosures. Create specs/design/kan-198-supporting-text-inventory.md and focused behavioral regressions in tests/ and e2e/features/kan-198-help-disclosures.spec.ts. Do not change authentication, server policies, domain content, routing behavior or sibling-owned controls.

**Interfaces:** Existing component props, native details/summary and existing disclosure patterns. No new component API required.

- [ ] Trace every requested journey and existing disclosure before editing. Inventory each surface/path and classify essential visible guidance, optional explanation, redundant copy and preserved domain/user content. Include reviewed/no-change surfaces and reasons. Use realistic long content. Inspect browser before changes and save evidence paths.
- [ ] Add focused failing behavioral tests for named help initially collapsed, keyboard open/close and focus, retained draft/selection with no save/navigation, visible warning/error while help closed, wrapping and no overflow at desktop/390px/200% zoom. Reuse current fixtures and isolated E2E database; never run tests on dev data.
- [ ] Refine supporting guidance: control panel master/section explanation and stage codes in a local How AI settings work disclosure; keep scope/state/master-off/manual-flow/permissions visible. Provider setup metadata/instructions in local Setup instructions disclosures, keep provider names/key state/routing availability and readiness visible. Across workspace journeys shorten redundant introductions and disclose optional methodology where useful; preserve required formats/reasons, warning recovery, rationale/evidence and history. Keep one useful visible sentence where needed. Avoid creating a disclosure for every short hint.
- [ ] Give native summaries visible focus and readable wrapping text using incumbent design tokens (body text around existing text-sm). Do not move controls/forms into help or unmount form content when help toggles.
- [ ] Run focused Vitest, Playwright and typecheck/lint for changed code. Record commands, exits, real test counts and browser evidence (themes, widths, zoom, keyboard, state). Update inventory with verification coverage and limitations honestly.
- [ ] Self-review scope and acceptance coverage; write report with Changed files, Verification, risks and evidence to the assigned task report. Leave changes uncommitted for controller to review and commit. Never push or spawn subagents.
