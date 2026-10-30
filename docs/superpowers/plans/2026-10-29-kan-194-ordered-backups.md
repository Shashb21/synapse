# KAN-194 Ordered Backup Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let the owner configure ordered backups without internal IDs, understand advanced settings, and identify business stages.
**Architecture:** Extend RoutingPanel on current main. Retain its native details/select/button controls, persisted-value draft comparison, API request shape and server validation. Keep fallbacks as ordered IDs in local state and serialize through the accepted array API. Surface invalid saved values without mutating them. No new dependency or policy system.
**Tech Stack:** Next 16, React 19, TypeScript, Vitest/jsdom, Playwright.
**Spec:** Jira KAN-194, fetched 2026-10-29; full description in this plan's SDD workspace ticket.md.

## Global Constraints
- Preserve KAN-109 draft preservation, errors/retry, permission gating and pending locks; preserve KAN-192 nullable/unavailable configuration safeguards on current main.
- Keep current advanced disclosure and native controls. Ordered backups use add, remove, move up/down with visible keyboard-operable controls. No drag-and-drop.
- Reuse existing provider catalog and applicable policy. Do not expand permitted destinations or silently replace saved disallowed choices.
- Empty guidance: “No backup provider; the stage fails if the chosen provider cannot run”. Save [] as empty without restoring defaults.
- Preserve unknown, stale, duplicate, primary-as-backup and disallowed saved entries until explicitly corrected; display warning and correction path. Opening form must not mutate values.
- Explain temperature as answer variation; maximum response tokens as output limit; tokens are small pieces of text, not words. Match server bounds and actual adapter support; do not claim universal support.
- Lead cards with business stage name, retain stage code as supporting information, remove misleading/duplicated metadata on non-model stages, retain AI traceability.
- Preserve owner authorization, server validation and API-key secrecy. KAN-94/95 are design boundaries, not authorization to implement gateway/profile policy.
- Work only in isolated KAN-194 worktree; preserve original checkout's uncommitted work. Parent owns commits, pushes and PRs.

## Review Focus
- Invalid stored primary/model/fallback values remain visible and require explicit correction.
- Unavailable configuration refresh preserves backups and drafts.
- Primary-provider change never silently filters the backup chain.
- Every backup control locks during save and remains usable by keyboard.
- Narrow viewport renders long provider names and controls without horizontal overflow.

### Task 1: Ordered routing controls and focused coverage

**Files:** Modify src/components/platform/routing-panel.tsx; tests/kan-109-control-panel.test.ts; e2e/features/control-panel-provider-keys.spec.ts. If necessary extend ProviderOption/page loader with minimal catalog metadata; investigate first.
**Interfaces:** Consume StageRouteView/ProviderOption and existing POST /api/control set_route with fallbacks string[]; output same public panel API and persisted route shape.

- [ ] Read relevant Next installed docs, incumbent RoutingPanel, kernel/routing validation, provider catalog/adapter support, control loader and existing KAN-192 tests before editing. Trace raw saved route through loader; fix only ticket-relevant silent normalization if present without weakening validation.
- [ ] Extend focused Vitest/jsdom coverage first. Assert ordered add/move/remove request round-trip, empty [], invalid stored primary/model/backup warnings without implicit mutation, duplicate/primary/disallowed routes, server failure/retry and unchanged/unavailable refresh draft preservation, pending/read-only locks, business-first labels and non-model metadata. Use existing tests as baseline; update old text-field assertion to ordered-control semantics.
- [ ] Run focused tests and record expected failures before implementation.
- [ ] Implement backup choice controls using catalog names, explicit order, meaningful accessible labels and visible move/remove buttons. Keep invalid entries visible and correctable; prevent invalid save or retain server rejection; never drop entries automatically. Use existing policy filtering and bounds from appropriate owner, avoid server-only imports into client.
- [ ] Add concise adjacent help for settings grounded in provider adapter behavior; business-first headings with supporting codes; non-model cards omit route authorship and misleading module metadata while retaining actual recovery guidance.
- [ ] Extend existing Control Panel Playwright coverage for keyboard add/order/remove, persisted empty/order after reload, pending locks where appropriate, desktop/narrow layout. Existing isolated database config must be honored; no development database writes.
- [ ] Run focused component/kernel/API tests, eslint on changed TS/TSX, npm run typecheck, and focused Control Panel Playwright specs when isolated database is available. Record exact commands, results, limitations and screenshot locations; parent handles infrastructure escalation and CI.
- [ ] Self-review; write task-1-report.md with status, changed files, Verification (command and exit code), concerns. Do not commit or push; parent commits reviewed changes and publishes to both remotes.
