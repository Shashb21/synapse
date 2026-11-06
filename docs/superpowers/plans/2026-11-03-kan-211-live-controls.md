# KAN-211 Live Control Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Verify existing live control ownership and prevent Accuracy/Development settings from changing customer routing.
**Architecture:** Reuse platform routing_config and existing AI & routing UI/API without migration. Add only behavioral boundary tests and an evidence-based inventory; change production code only if tests expose a confirmed ticket gap.
**Tech Stack:** Next.js, TypeScript, Vitest, Playwright, PostgreSQL.
**Spec:** docs/superpowers/specs/2026-11-03-kan-211-live-controls.md

## Global Constraints

- Preserve current effective live values, defaults, parameter validation, provider availability/error handling, AI-off enforcement, authorization and existing change-history protections.
- Do not automatically copy Accuracy's separate legacy routing values into customer-stage routing or apply experimental selections to live execution.
- Shared provider/key status and cost semantics remain consistent across Development and AI & routing; secrets never appear in responses/logs.
- Development configuration changes cannot modify live routing/control records.
- No speculative spending-control system or new configuration surface is added without an identified existing capability or confirmed gap.
- Retain historical tables and artifacts; no data migration/deletion. Work only in /private/tmp/synapse-kan211, preserve other agents' changes. Parent owns git commits, pushes, PR and Jira.

## Review Focus

- A conflicting Accuracy route must not override customer routing.
- Live edits must affect the intended stage and preserve unrelated routes.
- Invalid and unauthorized changes must leave saved values unchanged.
- Missing credentials must fail safely or use explicitly configured backups.
- Development Standard and Single pass settings must preserve both routing stores, AI switches and live module activation records.

### Task 1: Inventory and verify ownership boundaries

**Files:** Create specs/design/kan-211-control-ownership.md and tests/kan-211-live-control-ownership.test.ts; extend tests/kan-202-execution.test.ts only as needed. Existing production code is reference, not a change target unless a confirmed gap is found.
**Interfaces:** Use real POST /api/control, platform routeConfig/resolveRouteForRun/completionFor, scripted provider adapters, and explicit Development execution config. Existing integration test at tests/kan-202-execution.test.ts near line 298 already proves role route settings without routing_config writes; strengthen it to snapshot other live control records and accuracy_routing_config.

- [ ] Record a setting-by-setting inventory with concrete writer, storage, readers, classification (experiment/live/shared/retiring), explicit destination or retirement, and evidence. Cover Accuracy routing/default provider, module activation, workspace/context/UI selection, benchmark inputs and budgets, AI master/sections, shared credentials/workspace/timeout/test env, pricing/cost display, prompt identities and historical artifacts. Explain shared helpers already relocated by KAN-209. Document no confirmed missing live controls and no existing live budget control; experimental budgets stay Development. Do not retire endpoints/data in this ticket.
- [ ] Add focused behavior tests with disposable PostgreSQL and network blocked. Save a stage route via actual control POST, reload persisted route through customer execution path, observe provider/model/temperature/max_tokens in scripted completion. Seed a conflicting Accuracy route and prove it is ignored; compare unrelated stages and prior records. Assert real audit before/after attribution.
- [ ] Cover invalid numeric/fallback/provider edits, unavailable credentials and unauthorized edits preserving configuration; reuse existing tests where they prove the exact boundary, naming evidence in inventory.
- [ ] Strengthen real Development generation test (Standard and Single pass) to compare platform routes/control records AND legacy Accuracy routes before/after explicit experiment changes/execution. Seed rows so comparisons cannot pass vacuously. Keep existing scripted send assertions.
- [ ] Run targeted new tests first; existing behavior may already pass, so record this as characterization proof instead of inventing a product change for a RED result. Explain Arrange/Act/Assert in module comment (prepare state, perform operation, check result). No paid provider requests.
- [ ] Verify using DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55431/synapse_kan211_test npx vitest run tests/kan-211-live-control-ownership.test.ts tests/kan-202-execution.test.ts tests/kan-63-admin-validation.test.ts tests/kan-89-audit-config-workspace.test.ts tests/kan-193-runtime-route.test.ts tests/kan-53-ai-sections.test.ts tests/llm-cost.test.ts tests/kan-206-costs.test.ts tests/kan-109-control-panel.test.ts tests/kan-192-control-panel-load.test.ts tests/kan-192-control-panel-recovery.test.ts. Run npx tsc --noEmit. Parent handles browser checks and CI.
- [ ] Self-review and write detailed report to task-1-report.md in the SDD workspace: files, proof commands/results, concerns, and remaining verification. Do not commit, push, spawn agents, or modify unrelated files.
