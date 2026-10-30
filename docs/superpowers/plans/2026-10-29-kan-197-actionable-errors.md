# KAN-197 actionable errors implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute tasks sequentially with independent task review and final branch review.

**Goal:** Every reachable control-panel/workspace error explains the problem and permitted recovery without exposing infrastructure details or inventing save outcomes.

**Architecture:** Extend existing customerErrorMessage/ProviderError ownership and API boundaries. Explicitly classify trusted application failures; unknown exceptions never become page copy. Shared browser requests distinguish rejected requests from unconfirmed outcomes. Existing alerts and recovery controls remain the presentation layer.

**Tech Stack:** Next 16.3.8, TypeScript, React, Vitest and Playwright (existing repository tools; pytest is not appropriate for this TypeScript application).

**Spec:** docs/verification/kan-197-spec.md (current authenticated Jira requirements).

## Global Constraints

- Preserve authorization, scientific terminology/meaning, routing policy, audit rules and existing uncommitted KAN-109 improvements.
- Existing customerErrorMessage/ProviderError handling (KAN-68/KAN-70) already covers some AI failures: preserve and extend it rather than creating a competing translation system.
- Unknown exceptions get a safe action-specific explanation; do not render arbitrary exception.message, raw provider replies, SQL, parameters, stack traces, JSON or HTTP codes as the main message.
- Customer messages must not link to owner-only settings or tell the customer to change server credentials.
- State save/outcome truthfully. Preserve drafts and completed work, clear pending state, and prevent duplicate submissions; do not introduce automatic unsafe retries.
- Reuse existing alerts, field associations and status announcements. Errors remain near the relevant action/field and readable at normal body size; do not communicate severity through colour alone.
- Work only in /private/tmp/synapse-kan197 on fix/kan-197-actionable-errors, baseline 6c75d0d. Other agents share the filesystem; preserve their changes. No merge, deployment or next-ticket implementation.
- Controller owns commits/pushes/PR/Jira; workers edit and verify, never commit or publish. The controller will commit each reviewed task (both remotes before final delivery).

## Review Focus

- A successful non-JSON mutation response cannot imply a confirmed save.
- Partial import/AI completion must not be relabelled as no work saved or repeated blindly.
- Historical failures and owner views must not bypass the safe message boundary.
- Typed validation must retain useful correction guidance without reflecting arbitrary input/secrets.
- Permission recovery and setup links must suit the current role.

### Task 1: Safe server and browser message boundaries

**Files:** Extend src/modules/kernel/stage-errors.ts, src/modules/auth/api-guard.ts, src/modules/kernel/no-llm.ts, src/lib/post-json.ts, src/components/workspaces/model.ts; other src/app/api boundaries as identified by inventory. Add focused tests/kan-197-errors.test.ts and extend existing regression suites as required.

**Interfaces:** Preserve customerErrorMessage(error), stageFailureBody(error, owner, fallback), apiErrorResponse(error, fallback), postJson and sendJson callers. Any additional typed trusted application error or request-result metadata must be documented in the report for Task 2. Use explicit trusted error types/codes at their owning throw sites instead of arbitrary Error.message or expanding forbidden-text regexes. Prefer action-specific fallback text passed through existing functions. Status/code compatibility and field errors remain intact.

- [ ] Read spec, /private/tmp/kan197-inventory-findings.md when available, relevant Next error handling/route docs in node_modules/next/dist/docs, existing typed errors, API guards, postJson/sendJson and tests. Trace invariants: completed writes can precede errors; response loss is unknown; owner does not mean raw detail permitted.
- [ ] Write focused failing behavioral tests for unknown DB/provider exception and sample secret suppression for both audiences, typed validation/session/permission/stale/missing config, daily quota versus temporary limit/outage, network and malformed/non-JSON responses including HTTP success. Tests follow Arrange (inputs), Act (operation), Assert (observable outcome).
- [ ] Extend existing ownership to return safe action-specific copy. Unknown thrown data stays out of APIs, including owner/diagnostic endpoints and partial ingestion outputs. Keep safe classification/context in authorized server logs without logging credentials/provider payloads. Preserve useful trusted validation; migrate affected expected generic throw sites to trusted typed errors as needed. No blanket middleware that destroys route-specific semantics.
- [ ] Shared requests must never report malformed/empty success as confirmed. Expose uncertain outcome where needed by callers, with check-current-state guidance and no automatic retries. Keep compatible result shapes plus minimal metadata if needed.
- [ ] Run focused Vitest suites, TypeScript check and changed-file lint; record commands/exit codes, failures and limitations in report. Do not commit. Self-review and report exact helper contracts for Task 2.

### Task 2: Apply actionable copy and truthful recovery across surfaces

**Files:** src/components/platform, src/components/workspaces, src/components/accuracy, other reachable src/components and src/app pages identified by inventory; relevant domain failure throw sites and APIs left by Task 1. Maintain docs/verification/kan-197-message-inventory.md. Add focused component/behavior tests under tests/kan-197-*.test.ts(x).

**Interfaces:** Consume Task 1 contracts as documented in its report. Preserve existing KAN-192 loading/retry and KAN-193 readiness. KAN-195 remains To Do; change safe copy/error recovery where necessary but do not add its unrelated switch success/summary behavior.

- [ ] Read spec, investigation report and Task 1 report. Inventory every currently reachable message surface with source, known cases, chosen wording, recovery, verification, and updated/already-clear status. Explicitly document route reachability, including related owner historical/diagnostic views.
- [ ] Write failing focused component tests for retained input, field associations/announced body-sized errors, pending cleared on failure, partial upload/pipeline completion and uncertain consequential mutation preventing blind duplicate submission.
- [ ] Replace raw exception/server-error and generic failed-action presentation using existing typed safe ownership. Use business task names instead of stage IDs. Keep provider quota/setup distinctions, customer/owner recovery differences, explicit missing/expired/access/stale/upload cases, and intentional warnings. Treat persisted error strings as untrusted historical data; safe summaries and useful safe metadata only. Preserve completed work and drafts, use working reload/retry/navigation actions when already available, guard duplicate submissions and require checking state after uncertain destructive responses.
- [ ] Update inventory to account for each surface. Do not claim all covered without a systematic reachable-source scan and documented evidence.
- [ ] Run focused Vitest, TypeScript and changed-file lint. Self-review, report commands/results, changed files and risks. Do not commit.

### Task 3: Browser acceptance and coverage reconciliation

**Files:** e2e/features/kan-197-actionable-errors.spec.ts, focused existing e2e specs where copy expectations changed, docs/verification/kan-197-message-inventory.md and docs/verification/kan-197-results.md; product fixes only when acceptance exposes a concrete defect.

**Interfaces:** Existing isolated test database/server, postJson safe boundary and component behavior from Tasks 1–2.

- [ ] Add behavioral browser tests for control panel and actual workspace failures, including injected raw payload suppression, role-correct action, retained form input, partial/unknown mutation outcomes and no duplicate action. Exercise desktop, 390px viewport, 200% zoom, keyboard/focus and announced errors, without weakening existing assertions.
- [ ] Run new focused tests using isolated E2E_PORT/E2E_DATABASE_URL and provider stubs. Never use the developer database. If infrastructure blocks a run, report exact error and do not claim completion.
- [ ] Reconcile inventory against all reachable errors/warnings and historical failures. Resolve missed scope; preserve useful field-specific validation and safe authorized diagnostic context.
- [ ] Run smallest sufficient regression proof and record exact commands/results, coverage, remaining risks. Do not commit. Controller runs final independent branch review, publishes both remotes, opens PR into main, monitors latest-head CI and completes Jira lifecycle only after success.
