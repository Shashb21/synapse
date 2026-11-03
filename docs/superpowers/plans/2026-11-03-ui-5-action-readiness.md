# UI-5 Action Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Explain every blocked Development action, expose accurate per-action run readiness, and preserve all execution safeguards.
**Architecture:** Extend UI-2's existing four-step workflow in place. Derive readiness from existing draft, request, provider, delivery and freshness state; use nearby visible descriptions and explicit navigation callbacks. Server validation remains authoritative. Avoid a second state store or execution service.
**Tech Stack:** Next.js 16.3, React 19, TypeScript, Vitest, Playwright.
**Spec:** Jira UI-5 (https://synapse21.atlassian.net/browse/UI-5), acceptance criteria copied into task brief below.

## Global Constraints

- Preserve experiment isolation, authorization, fixed document identities, frozen execution history, concurrency protection and spending safeguards.
- Do not alter customer workspaces, shared model routing, pipeline algorithms or human-review semantics.
- Keep correct button disabled behavior; never enable an invalid operation merely to avoid a grey button.
- No paid model calls. Script browser model/execution I/O.
- Preserve UI-2 workflow and local edits across navigation. UI-3/UI-6 enhancements are not dependencies.
- Work only in /private/tmp/synapse-ui5. Others share the repository; preserve their changes.
- Do not start persistent servers; clean up only processes/containers owned by this task.
- Parent owns commits, pushes, PR and Jira writes.

## Review Focus

- Partial splitting must use current successful matching linked to the same current extraction attempts; unknown freshness fails closed.
- Failed/uncertain execution starts must not imply no provider charges or silently retry; refresh history before retry.
- Navigation and draft refresh preserve unsaved names and selected files/model settings.
- Single-pass mode ignores omitted roles for readiness, while explaining their disabled overrides.
- Spending acknowledgment is explicit; zero allowance is a permitted start that pauses spending, not invented server rejection.

### Task 1: Explain blocked actions and implement run readiness across Development

**Files:** Modify src/components/development/development-{setup,execution,evaluation,costs,route-fields,comparison}.tsx only as needed. Create a focused development-readiness.ts helper if useful. Tests: tests/ui-5-development-readiness.test.ts and e2e/features/development-readiness.spec.ts; adjust existing Development browser expectations if actual invalid states now correctly disable actions.

**Interfaces:** Consume current Experiment, ExecutionConfig, ProviderKeyView, AttemptHistoryMetadata, SECTION_DEPENDENCIES, UI-2 WorkflowStep and navigation. Produce pure typed readiness derivation with ordered blockers where useful; retain existing component interfaces unless threading concrete blocker reasons and step navigation is necessary. No generic framework.

- [ ] Trace existing server validation in src/modules/development/{execution,routes,evaluation,cost}.ts, API routes and corresponding tests before editing. Read installed node_modules/next/dist/docs relevant guide. Read /Users/calixtan/.agents/skills/impeccable/reference/{clarify,craft-floor}.md and /Users/calixtan/.codex/skills/uncodixfy/SKILL.md. Context loader already failed in predecessor; inspect existing PRODUCT.md/DESIGN.md if present and preserve incumbent design.
- [ ] Write meaningful failing readiness tests first (Arrange inputs, Act derive readiness, Assert behavior): source missing; ordered multiple blockers and clearing first; saving/loading vs dirty vs stale; malformed model configuration; unavailable provider and valid fallback per actual server; single-pass inactive overrides; missing/failed/unknown/outdated prerequisites; mismatched partial lineage; active execution; invalid allowance; zero allowance and unchecked unknown prices retain server semantics.
- [ ] Run tests to confirm failure, then implement the smallest coherent readiness logic at its responsible layer and integrate it into controls.
- [ ] Audit all disabled buttons/fieldsets across setup, model configuration, generation, evaluation, comparison, spending. Every disabled action needs concise nearby visible text or an explicitly associated group, not title alone. Cover missing selection/file/source association, empty required name, no changes, saving/loading, dirty/stale drafts, active execution/evaluation, missing provider/model, delivery, prerequisites and spending. Use aria-describedby IDs for explanations; disabled inherited fieldsets need group explanations. Explain immutable/read-only/default inherited evaluation profiles, criterion limits and checks-only evaluator routes.
- [ ] Run all sections remains the primary action; each secondary section has its own readiness and current successful dependencies. Show ordered next useful action without hiding other material blockers. Show mode and actually selected active model roles plus spending requirements before dispatch. Zero allowance/unknown prices are warnings where the server permits paused execution, not blanket dispatch blockers.
- [ ] Provide keyboard-accessible step/settings navigation and appropriate refresh recovery without discarding edits. Distinguish server delivery configuration from browser actions. On newly rejected/stale/uncertain request show actionable recovery and maintain authoritative API validation. Keep no automatic retries.
- [ ] Announce concise meaningful readiness/error changes with a stable polite status region; avoid live-region wrapping polling history or announcing unchanged blockers repeatedly.
- [ ] Add a scripted browser flow from missing input through saved source/settings to ready, start a queued/running execution, observe active blocker, recover stale/failed request. Exercise evaluation and single-pass explanations, aria-describedby associations and keyboard navigation. Use existing setup/database test patterns; invalid direct API must remain rejected. Capture desktop/mobile screenshots and inspect them with view_image, recording actual findings.
- [ ] Verify npx vitest run tests/ui-5-development-readiness.test.ts plus affected development tests; npx tsc --noEmit; npx eslint <changed source/test files>; targeted Playwright browser test with isolated disposable task DB if needed. Record exact commands, exit codes, limitations, server/container cleanup and screenshots in the report. Never claim unrun tests passed.
- [ ] Self-review scoped diff and write report; do not commit or push. Parent will commit after review, publishing to both remotes immediately.

## Delivery evidence — 2026-11-03

- Independent task review and fresh whole-change review: specification compliant; quality/security approved. Final minor retry-copy issue fixed and scoped re-review approved.
- `DATABASE_URL=<isolated UI-5 database> npx vitest run tests/ui-5-development-readiness.test.ts tests/ui-2-development-workflow.test.ts tests/kan-201-development.test.ts`: exit 0, 37/37 tests.
- `npx tsc --noEmit`, targeted ESLint across changed source/tests, and `git diff --check`: exit 0.
- Broad Development browser run: 50/52 passed. Corrected a hidden-step test assertion and inconsistent scripted delivery fixture; no production workaround. Final affected-case run: `CI=1 E2E_DATABASE_URL=<isolated UI-5 database> E2E_PORT=43255 E2E_REUSE=1 npx playwright test e2e/features/development-readiness.spec.ts e2e/features/development-setup.spec.ts --grep 'explains readiness|reopened draft shows saved' --workers=1 --reporter=line --timeout=90000 --retries=0`: exit 0, 3/3 including setup.
- Earlier local attempts encountered a Next manifest-empty HTTP 500 and cold-route timeouts; the final run used the existing CI assertion allowance, with automatic retries disabled. The stale-revision browser response is scripted; real invalid-input and stale-write rejection are covered by the API tests.
- Desktop and 390px mobile screenshots inspected: readable layout, wrapping controls, no page overflow. No paid model calls.
- Ruling: extend the existing workflow with local action-specific explanations rather than introduce a new workflow; this follows the ticket and existing design. If product preferences differ, the cost is copy/layout rework.
- PR targets `updated-dev-environment-ui` per owner Jira comment 10715. Preserve server-side authorization, validation, lineage, concurrency and spending checks.
