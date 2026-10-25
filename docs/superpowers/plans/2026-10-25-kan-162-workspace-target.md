# KAN-162 Workspace Target Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reset or load demo data only when the authenticated selected workspace matches the workspace the person confirmed.

**Architecture:** Keep the existing selected-workspace API and owner authorization. Require `expected_workspace_id` for authenticated `reset` and `load_demo` requests, captured from the confirmation target. Reject a changed selection before destructive processing. Keep non-current Settings cards working through their existing select-then-action flow, with the new check protecting the gap between requests.

**Tech Stack:** Next.js 16.3.8, TypeScript, React 19, Vitest, Playwright, PostgreSQL.

**Spec:** https://synapse21.atlassian.net/browse/KAN-162 (fetched 2026-10-25). Acceptance: deterministic selection-change regression; mismatch performs no writes and preserves confirmation data; current and non-current Settings actions work; owner checks and audit attribution remain; API and two-tab browser tests.

## Global Constraints

- Target mismatch performs no writes, returns a clear error, and preserves confirmation data.
- Authorized reset/load-demo still works for current and non-current cards.
- Existing owner checks and audit attribution remain.
- Add API-level tests plus a two-tab browser regression.
- No live or developer workspace data is used for destructive verification; browser tests use the isolated E2E database.
- No new dependency, database migration, change to `clear_ingested_files`, or unrelated refactor.
- Read the installed Next.js route-handler and cookies guides before editing server code.

## Decision and alternatives

The proposed change is an expected-target check on the existing endpoint. A new explicitly targeted endpoint could avoid selection entirely, but would introduce a second authorization and database-scoping path for this repair. Unconditionally selecting before every destructive action still leaves the same race between requests. The expected-target check is the smallest repair that closes that race while preserving existing behavior.

Missing, empty, and non-string expected IDs return HTTP 400 with `code: invalid_request`. A different ID returns HTTP 409 with `code: workspace_mismatch` and this message: `The selected workspace changed. Reopen the intended workspace and try again. No contents were changed.` Neither error closes the confirmation or navigates away. An old authenticated client without the new field fails safely and must reload.

The existing explicit anonymous Vitest path has no authenticated workspace identity. Keep its existing behavior behind `identity.anonymous_test`; never bypass target validation for authenticated sessions, even when test environment flags are enabled.

## Review Focus

- Cookie changes after a non-current card's select succeeds: reject and keep both workspaces unchanged.
- Malformed/missing IDs from old or hand-written clients: fail safely without coercion or fallback.
- A component receives another workspace while a dialog is open: do not silently replace the confirmed target.
- A matching ID supplied by a member or a role without reset capability: retain rejection and authenticated attribution.
- Shared test helpers and direct authenticated API calls: supply explicit target IDs rather than weakening production validation.

---

### Task 1: Bind the API and both confirmation surfaces to a fixed workspace

**Files:**
- Modify: `src/app/api/iegp/route.ts` (authorization and replacement dispatch).
- Modify: `src/modules/auth/api-guard.ts` only if the shared error-code type needs `workspace_mismatch`.
- Modify: `src/components/workspaces/workspace-contents.tsx` and `src/components/workspaces/demo-reset-bar.tsx`.
- Create: `tests/kan-162-workspace-target.test.ts` for authenticated API regression cases, using the cookie-jar/session patterns in `tests/kan-26-blank-and-demo.test.ts`.
- Create: `tests/kan-162-workspace-contents.test.ts` for Settings confirmation behavior.
- Modify: `tests/kan-127-demo-reset-bar.test.ts` and existing authenticated reset/load-demo tests to use the new API contract.

**Interfaces:**
- Consumes: `requireCustomerContext`, `requireCapability`, existing workspace owner check, `replaceContents(workspaceId, contents, actor)`, `sendJson`.
- Produces: authenticated `/api/iegp` `reset`/`load_demo` requests require `{ action, expected_workspace_id: string }`; optional existing fields such as `scope` remain supported.

- [ ] Write failing API tests for both actions: selected B/expected A, malformed IDs (missing, null, number, empty string, array, object), matching owner success, member and capability rejection, and authenticated actor attribution. Assert A and B contents, demo flags, and audit records do not change on mismatch. Ensure the changed-cookie case starts with real authenticated context, not the anonymous bypass.
- [ ] Write failing UI tests proving both surfaces send the confirmed ID; the Settings card works when current and when non-current; a failed select prevents replacement; mismatch keeps the dialog/target intact and shows the recovery message; changing props while open cannot silently retarget confirmation.
- [ ] Run the new focused tests before implementation and record the expected failures. Tests use Arrange (prepare workspaces/cookies), Act (send action), Assert (check response and preserved state).
- [ ] Add replacement-target validation at the API boundary before any write, including denial audits and lazy schema initialization. Trace `POST` transaction setup: it currently resolves `currentSchemaName()` before `handleAction`. Perform replacement preflight before that resolution, retain the verified identity/body for execution, and avoid re-reading/re-targeting the request later. Preserve the existing transaction and authorization behavior for other actions.
- [ ] Capture the target at dialog opening in each UI, send `expected_workspace_id` on confirm, and retain the existing select request for non-current cards. Preserve target/dialog on failure, and clear success state only after the action succeeds. Use existing alert styling and error handling.
- [ ] Update existing authenticated Vitest call sites to pass their explicit workspace ID. Do not relax target requirements to accommodate fixtures.
- [ ] Run `npx vitest run tests/kan-162-workspace-target.test.ts tests/kan-162-workspace-contents.test.ts tests/kan-127-demo-reset-bar.test.ts tests/kan-26-blank-and-demo.test.ts tests/kan-89-audit-config-workspace.test.ts tests/kan-138-demo-mode.test.ts`, plus any other directly changed test file. Run `npm run typecheck` and ESLint on changed TypeScript files. Record commands and exit codes; separate pre-existing failures from regressions.
- [ ] Self-review and report changed files, RED/GREEN evidence, and limitations. The controller handles commit/push so both remotes receive the same branch.

### Task 2: Prove the cross-tab race and migrate browser fixtures

**Files:**
- Create: `e2e/features/kan-162-workspace-target.spec.ts`.
- Modify: `e2e/support/synapse.ts` and direct authenticated reset/load-demo calls under `e2e/` as required by Task 1's contract.

**Interfaces:**
- Consumes: Task 1's `expected_workspace_id` field, HTTP 400/409 responses, retained confirmation state, existing workspace selection API.
- Produces: shared browser fixtures supply the intended ID; two-tab regression exercises real shared browser cookies.

- [ ] Update shared fixture helpers to resolve the selected ID from authenticated `GET /api/workspaces` and send it explicitly for replacement actions. Preserve explicitly supplied expected IDs so negative tests can exercise mismatches. Update direct callers as well; use an explicit workspace ID already known by the fixture where available.
- [ ] Add a deterministic real-browser test with two pages in one context and fresh owned workspaces A/B. Open a confirmation for A in tab A; select B in tab B; confirm in A. Assert HTTP 409, visible recovery message, retained dialog, and unchanged contents/demo flags in both A/B. Parameterize reset and load-demo. Check persisted state through APIs after selection, not just stale page text.
- [ ] Add a non-current-card race test: pause/intercept the destructive request after A's select completes, select B in the second tab, then release it. Assert the same protection. Avoid timing sleeps; control request order explicitly.
- [ ] Cover the demo reset bar's stale-selection failure and the normal matching selection success; ensure it does not navigate on rejection. Exercise successful current/non-current Settings flows using the existing KAN-26 suite.
- [ ] Run `npx playwright test e2e/features/kan-162-workspace-target.spec.ts e2e/features/kan-26-blank-and-demo.spec.ts` against the configured isolated E2E database. Run `npm run typecheck` after fixture migration. If local infrastructure is unavailable, record the exact blocker and leave Jira open.
- [ ] Self-review and report commands, exit codes, files, and limitations. The controller handles commit/push.

## Completion

Each task gets an independent spec-and-quality review. After both pass, run the skill's whole-branch review, resolve material findings, publish the same feature branch to origin and github, record evidence in Jira, and transition to Done only after successful verification and Jira comment. Follow the repository's next-issue handoff rule after Done. Do not merge or deploy without authorization.
