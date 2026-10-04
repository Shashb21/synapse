# Requirements compliance check — 4 Oct 2026

This checks [the requirements (v2.1)](01-requirements.md) against the code at `main` @ `b2a4a34` (after KAN-68). It replaces the 26 Sep check at `c97344f`. Evidence is file and test references read from the code; the suites were not all re-run for this check, and no browser walkthrough was done. `AUD-…` ids refer to the [application audit](../audit/2026-09-26-application-audit.md).

Jira: [KAN-7](https://synapse21.atlassian.net/browse/KAN-7). Each gap links to its follow-up issue.

**Met** means the behaviour exists in the code, with tests where cited. **Partial** means it exists with a known gap. **Missing** means it is not built. **Off** means the code exists but the feature is switched off in the app by an owner decision; requirement priorities are unchanged. **Dropped** means the owner withdrew the requirement; it is listed for traceability and not counted.

## Summary

| Area | Met | Partial | Missing | Off |
|---|---|---|---|---|
| Accounts, login, roles | 9 | 0 | 0 | 0 |
| Workspaces | 7 | 0 | 1 | 0 |
| Setup and walkthrough | 4 | 0 | 0 | 0 |
| Sources and parsing | 4 | 1 | 0 | 0 |
| Needs and gaps | 6 | 0 | 0 | 0 |
| Tactics and mapping | 5 | 0 | 0 | 0 |
| Prioritization, ideation, timeline | 5 | 4 | 0 | 0 |
| AI governance | 5 | 0 | 0 | 0 |
| Manual control and audit | 2 | 1 | 0 | 0 |
| Room | 0 | 0 | 0 | 4 |
| Owner tool | 2 | 0 | 0 | 0 |
| User experience | 2 | 7 | 1 | 0 |
| Quality and operations | 1 | 3 | 2 | 0 |
| **Total (76; REQ-AI-006 dropped)** | **52** | **16** | **4** | **4** |

Since 26 Sep: the security items (KAN-10, KAN-11, KAN-12), workspace-scoped tables (KAN-13), restore paths and manual start (KAN-16), dead-code removal (KAN-21), seats (KAN-28), per-section AI switches (KAN-53), env-only provider keys (KAN-65) and the upload limit (KAN-68) landed. The five v2.1 rows (REQ-AUTH-008, REQ-AUTH-009, REQ-WS-008, REQ-AI-006, REQ-TIM-004) are checked here for the first time.

## Detail

### 1. Accounts, login and roles

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-AUTH-001 | Met | SSO for Google, Microsoft and GitHub (`src/modules/auth/idp.ts`); the callback signs in only a seat holder (`session.ts` `completeLogin` → `seatAllowsSignIn`, `NoSeatError`); no sign-up path. `tests/kan-28-seats-sso.test.ts`, e2e `login-workspaces.spec.ts`. | — |
| REQ-AUTH-002 | Met | `demoSignInAllowed()` is false when `NODE_ENV=production` (`idp.ts`) and the demo sign-in throws there (`session.ts`); the login page offers none. `tests/kan-11-12-auth-hardening.test.ts`. | — |
| REQ-AUTH-003 | Met | `resolveIdentity` (`idp.ts`) keeps only a verified email (Google `email_verified`; Microsoft `email_verified`/`xms_edov`, never `preferred_username`; GitHub primary and verified); otherwise the person is `provider:subject`. `tests/kan-11-12-auth-hardening.test.ts`. | — |
| REQ-AUTH-004 | Met | `requireCustomerContext` (`src/modules/auth/api-guard.ts`) needs a live `auth_sessions` row, a workspace and membership on every customer API; `currentSession` re-checks the seat; pages redirect (`app-shell.tsx`). `tests/kan-10-api-guard.test.ts`. | — |
| REQ-AUTH-005 | Met | `/api/iegp` takes the actor from the session, never the body (`src/app/api/iegp/route.ts` ~l.201, "REQ-AUTH-005"). `tests/kan-10-api-guard.test.ts` ("records the signed-in person as the actor, whatever the body says"). Only the Vitest-only `SYNAPSE_TEST_ANON_API` path and owner-gated routes in demo mode read a typed name (`src/modules/auth/request.ts`). | — |
| REQ-AUTH-006 | Met | Capability matrix in `roles.ts` (only Medical Affairs has `save_final`); `/api/iegp` runs `requireCapability` per action; `/api/sources/blocks` needs `upload`. `tests/kan-10-api-guard.test.ts`. Minor: viewer holds `configure_routing`, used only by an owner-gated route. | — |
| REQ-AUTH-007 | Met | `sessionSecret` (`src/modules/auth/secret.ts`) throws in production when `SESSION_SECRET` is missing, the dev default, or under 32 characters; `instrumentation.ts` checks at startup. `tests/kan-11-12-auth-hardening.test.ts`. | — |
| REQ-AUTH-008 | Met | `src/modules/auth/customers.ts`: assignments never exceed seats sold, one seat per email across customers, `revokeSeatSessions` on unassign or deactivation; `/admin/customers`. `tests/kan-28-seats-sso.test.ts`, e2e `admin-customers.spec.ts`. | — |
| REQ-AUTH-009 | Met | `npm run create-admin`, `/admin/users`, `accounts.ts`, `password-login.ts`. `tests/kan-22-password-accounts.test.ts`, `tests/kan-22-password-policy.test.ts`, e2e `admin-users.spec.ts`. One deliberate exception: the KAN-59 test customer account, restricted to test-only email domains (`tests/kan-59-test-customer.test.ts`). | — |

### 2. Workspaces

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-WS-001 | Met | One schema per workspace (`ws_<id>`, `src/modules/workspaces/store.ts`), per-query `search_path` (`src/lib/iegp/db.ts`); module side tables are per schema too (KAN-13). `tests/workspaces.test.ts`, `tests/kan-13-workspace-tables.test.ts`. | — |
| REQ-WS-002 | Met | `workspaces-view.tsx` shows the ask-or-create state; creation redirects to `/setup?new=1` (`src/app/api/workspaces/_shared.ts`). e2e `login-workspaces.spec.ts`. | — |
| REQ-WS-003 | Met | `listWorkspacesFor`, `/api/workspaces/select` checks membership. `tests/workspaces.test.ts`, `tests/workspaces-ui.test.ts`. | — |
| REQ-WS-004 | Met | Workspace tag in the sidebar (`workspace-tag.tsx`, `workspace-tag-data.ts`). | — |
| REQ-WS-005 | Met | Invite, rename and remove in `store.ts`; membership is re-checked on every request, so a removed member loses access at once. `tests/kan-10-api-guard.test.ts`, `tests/workspaces.test.ts`. | — |
| REQ-WS-006 | Met | `claimDefaultWorkspace` is an atomic CTE; `mayClaimDefault` limits who may claim. `tests/kan-11-12-auth-hardening.test.ts` (concurrent claim), `tests/kan-28-seats-sso.test.ts`. Edge case: any password session, including the KAN-59 test customer, may claim Default on a fresh deployment. | — |
| REQ-WS-007 | **Missing** | `POST /api/workspaces` → `createWorkspace` has no rate limit or per-person cap. | [KAN-20](https://synapse21.atlassian.net/browse/KAN-20) |
| REQ-WS-008 | Met | Blank by default, demo on request with a Demo badge, load demo / reset to blank per workspace (`src/modules/workspaces/contents.ts`). `tests/kan-26-blank-and-demo.test.ts`, e2e `kan-26-blank-and-demo.spec.ts`. | — |

### 3. Setup and walkthrough

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-SET-001 | Met | `setup-steps.tsx` covers every listed section. `tests/setup-wizard-store.test.ts`, `tests/setup-wizard-render.test.ts`, e2e `setup-wizard.spec.ts`. | — |
| REQ-SET-002 | Met | Drafts, resume and edits after completion (`setup-wizard.tsx`). Same tests. | — |
| REQ-SET-003 | Met | `prioritizationContextFromState` (`src/lib/iegp/planning-context.ts`) feeds S8, S9 and S10. `tests/planning-context.test.ts`. | — |
| REQ-SET-004 | Met | Progress per person and workspace (`src/lib/iegp/walkthrough.ts`); hidden on `/login` and `/workspaces` (`walkthrough-client.ts`). `tests/walkthrough-applies.test.ts`. "Never inside presented slides" holds only because Room is off: the walkthrough does not check present mode, so the old gap returns if Room is switched back on. | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |

### 4. Sources and parsing

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-SRC-001 | Met | Ingest refuses with the ingestion section off (`src/app/api/iegp/ingest-pipeline.ts`); format checks in `src/lib/ingest/upload-formats.ts`. `tests/kan-68-upload-formats.test.ts`, `tests/ai-switch.test.ts`, e2e `kan-52-add-source.spec.ts`. | — |
| REQ-SRC-002 | Met | `structureWithLlm` (`src/lib/ingest/llm-structure.ts`); S1 `requireLlm`, local parse only under the test stub; LlamaParse removed. `tests/llm-parse.test.ts`. | — |
| REQ-SRC-003 | Met | Verbatim-span check and mandatory `dropped_reason`; model stakeholder classification. `tests/llm-parse.test.ts`. | — |
| REQ-SRC-004 | Met | Block editor actions in `src/app/api/sources/blocks/route.ts`; side tables per schema (KAN-13); re-parse keeps human blocks. `tests/manual-blocks-iegp.test.ts`, `tests/kan-13-workspace-tables.test.ts`. | — |
| REQ-SRC-005 | **Partial** | Uploads are capped at 3 MB (`MAX_UPLOAD_BYTES`, enforced in `/api/iegp` and `add-source-form.tsx`; `tests/kan-68-upload-formats.test.ts`). Parse volume is not capped (pieces, units or model calls per file or workspace), and `POST /api/modules` may reach S0 without the 3 MB check (not verified). The accuracy lab allows 40 MB. | [KAN-20](https://synapse21.atlassian.net/browse/KAN-20) |

### 5. Needs and gaps

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-GAP-001 | Met | Needs with verbatim quotes. `tests/iegp-store.test.ts`, `tests/manual-gaps-tactics-needs.test.ts`. | — |
| REQ-GAP-002 | Met | S2 model proposer, critic and judge. `tests/s2-llm.test.ts`, e2e `s2-gap-extract.spec.ts`. | — |
| REQ-GAP-003 | Met | Excluded gaps can be restored with a rationale (`restoreExcludedGap`, `src/lib/iegp/restore.ts`; `restore_gap` in `/api/iegp`; `restore-actions.tsx`). `tests/kan-16-restore.test.ts`, e2e `kan-16-manual-and-gates.spec.ts`. | — |
| REQ-GAP-004 | Met | Override with a reason; stale overrides shown (`displayedGapStatus`, `engine.ts`). `tests/manual-mapping.test.ts`. | — |
| REQ-GAP-005 | Met | Split and rewrite (`split-gap-dialog.tsx`; S6 suggests, a person decides). `tests/s6-llm.test.ts`, e2e `s6-partial-split.spec.ts`. | — |
| REQ-GAP-006 | Met | Promote on `/needs` (in the secondary nav) and `/tactics`. `tests/manual-gaps-tactics-needs.test.ts`. `/tactics` itself is still little-linked (low). | — |

### 6. Tactics and mapping

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-TAC-001 | Met | Fields and S3 extraction. `tests/s3-llm.test.ts`, `tests/manual-gaps-tactics-needs.test.ts`. | — |
| REQ-TAC-002 | Met | Rejected tactics are listed with Restore (`RejectedTactics`, `restoreRejectedTactic`); forms say "Choose a type" (no hidden "Phase III trial" default). `tests/kan-16-no-hidden-defaults.test.ts`, `tests/kan-16-restore.test.ts`. | — |
| REQ-MAP-001 | Met | S4 LLM mapping table with critic and judge; no rule fallback. `tests/s4-llm.test.ts`, e2e `s4-kg-mapping.spec.ts`. | — |
| REQ-MAP-002 | Met | Mapping table rows fixed (`src/lib/iegp/mapping-table.ts`: eligible, non-retired gaps; the person's row beats S4); rejected mappings restorable. `tests/manual-mapping.test.ts`, `tests/kan-68-errors-and-remap.test.ts`. Unconfirmed: `MappingRowEditor` is keyed by gap only and may keep old values after a re-run. | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |
| REQ-MAP-003 | Met | Rejected and locked pairs respected; validation survives with a stale flag. `tests/manual-mapping.test.ts`. | — |

### 7. Prioritization, ideation, timeline

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-PRI-001 | **Partial** | The S8 matrix is the main system (`validatePlacement`), but the legacy four-band `priorities` table still runs beside it: S8 mirrors into it (`mirrorLegacyBand`, skipping Defer), and `/residuals` sets a four-band band (including Critical) through `lock_priority` that never reaches the matrix. | [KAN-17](https://synapse21.atlassian.net/browse/KAN-17) |
| REQ-PRI-002 | Met | `set_placement` / `validate_band` (`/api/plan`); human axes and bands survive re-runs. `tests/place-by-hand.test.ts`, `tests/manual-plan-prioritize-ideate.test.ts`, `tests/prioritize-matrix.test.ts`. | — |
| REQ-PRI-003 | **Partial** | The PowerPoint export is gone; ideation, the timeline and the Gaps chips use the matrix band. `buildPlanBoard` and the open-gap card band (`engine.ts`) still read the legacy table. | [KAN-17](https://synapse21.atlassian.net/browse/KAN-17) |
| REQ-IDE-001 | Met | S9 only for gaps validated High (`ideationBandOrder`), critic, judge, per-gap cap. `tests/s9-llm.test.ts`, e2e `s9-ideation.spec.ts`. | — |
| REQ-IDE-002 | **Partial** | The server accepts a manual idea for any Open gap, but the UI shows "Add idea" only for validated-High gaps or gaps that already have proposals (`src/app/ideation/page.tsx`, `tactic-ideation/data.ts`). | [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) |
| REQ-TIM-001 | Met | Human, then design, then model dates; "Not yet prioritized" lane (`s10-timeline/build.ts`). `tests/s10-llm.test.ts`, e2e `s10-timeline.spec.ts`. | — |
| REQ-TIM-002 | Met | Date, add, remove, dependencies and lane without AI. `tests/manual-timeline.test.ts`, `tests/kan-25-manual-timeline.test.ts`. | — |
| REQ-TIM-003 | **Partial** | Only Medical Affairs saves final and undated activities block it, but an empty plan can still be saved as final, and "changed since last save" compares activity counts only (`timeline-board.tsx`, `plan.activities !== model.activities.length`). | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |
| REQ-TIM-004 | Met | Built entirely by hand through `/api/plan` with no stage run; broken dependencies warned; viewers refused; PNG export, no PowerPoint. `tests/kan-25-manual-timeline.test.ts`, `tests/kan-25-viewer-readonly.test.ts`, e2e `kan-25-manual-timeline.spec.ts`. | — |

### 8. AI governance

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-AI-001 | Met | No rule path runs in production: `isTestStub()` throws in a production build (`src/modules/kernel/llm.ts`); S4 has no rule fallback; dead code removed (KAN-21). | — |
| REQ-AI-002 | Met | `requireLlm`, `NoRouteError`, customer vs owner wording (`no-llm.ts`). `tests/*-llm.test.ts`, `tests/no-llm-message.test.ts`. | — |
| REQ-AI-003 | Met | `completeAll` re-asks, then throws `IncompleteAnswerError`. `tests/llm-parse.test.ts`. | — |
| REQ-AI-004 | Met | Master switch plus per-section switches (`ai-switch.ts`, `ai-sections.ts`); the kernel refuses; the UI read now fails closed (`src/app/layout.tsx`). `tests/ai-switch.test.ts`, `tests/kan-53-ai-sections.test.ts`, e2e `ai-off.spec.ts`, `ai-toggle-settings.spec.ts`. | — |
| REQ-AI-005 | Met | With AI on, gaps and tactics can be added by hand before anything is ingested (`src/app/page.tsx`). `tests/kan-16-manual-start.test.ts`. | — |
| REQ-AI-006 | Dropped | Dropped by owner decision (4 Oct 2026). There is no per-workspace AI setting: the owner controls AI in the admin panel (`/admin/control`) with the master switch and one switch per section (KAN-53, `src/modules/kernel/ai-switch.ts`). Not counted in the summary. | [KAN-53](https://synapse21.atlassian.net/browse/KAN-53) |

### 9. Manual control and audit

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-MAN-001 | Met | Manual and restore paths for gaps, needs, tactics, mappings and ideas (`restore-actions.tsx`; `tests/kan-16-restore.test.ts`), plus manual timeline, placement and mapping. The REQ-IDE-002 UI limit is the remaining exception. | — |
| REQ-MAN-002 | Met | Human edits survive re-runs across S1, S4, S8, S9 and S10 (the `manual-*` tests, `tests/kan-25-manual-timeline.test.ts`). | — |
| REQ-MAN-003 | **Partial** | The actor is now the signed-in person (`tests/kan-10-api-guard.test.ts`). Some `/api/iegp` edits still take an optional note and fill in default text (for example clearing an override, unparking, `lock_priority` on `/residuals`), and `fileGateEdit` skips the edit record for a rationale under 3 characters and records `before: null`. | [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) |

### 10. Room

Room and Breakouts are **switched off** in code by owner decision: `ROOM_ENABLED = false` (`src/lib/room/enabled.ts`, KAN-52) and `BREAKOUTS_ENABLED = false` (`src/lib/breakouts-enabled.ts`, KAN-57). `/room`, `/room/audience`, `/presentation` and `/breakouts` redirect to the plan; e2e `room.spec.ts` is skipped and `prep-room.spec.ts` checks Room is absent. Priorities in [01-requirements.md](01-requirements.md) are unchanged.

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-ROOM-001 | Off | Presenter console still in `src/components/room/presenter-console.tsx`, slides in `src/lib/room/slides.ts`; `tests/room.test.ts`. | [KAN-52](https://synapse21.atlassian.net/browse/KAN-52) |
| REQ-ROOM-002 | Off | Audience window `src/components/room/audience-view.tsx`; `/api/room` is now session-guarded. The audience frame appears still editable (AUD-BUG-07, not browser-checked). | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |
| REQ-ROOM-003 | Off | Breakouts tab in the presenter console; `isShowableHref` keeps `/accuracy` out of slides. | [KAN-57](https://synapse21.atlassian.net/browse/KAN-57) |
| REQ-ROOM-004 | Off | Also unmet in the code: the opening slide is still `/setup`, an edit form (AUD-UX-08). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |

### 11. Owner tool

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-ADM-001 | Met | `/admin` layout gate (`requireOwnerPage`), owner rules in `src/modules/auth/owner.ts`, old-URL redirects in `next.config.ts`; AI switches, key status and routing on `/admin/control`. `tests/owner-gate.test.ts`, e2e `admin/owner-console.spec.ts`. | — |
| REQ-ADM-002 | Met | The only customer-side `/admin` links are shown to owners only (`workspace-tag.tsx`, `src/app/account/page.tsx`). | — |

### 12. User experience

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-UX-001 | **Partial** | Only the readiness strip (`plan-chrome.tsx`); no Summary view with counts by band, attention list or upcoming decisions. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-002 | **Partial** | Evidence Inventory list with search, filters, sortable headers and expanding rows (`gaps-workbench.tsx`); no group-by, bulk actions or tactic table. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-003 | **Partial** | The Prioritization Matrix (drag onto quadrants) is the nearest thing; no Board view by status or band. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-004 | Met | Gantt timeline with dependencies (`src/components/timeline/`), restyled in KAN-8. Keyboard access not verified. | — |
| REQ-UX-005 | **Missing** | No Calendar view; readouts show only as Gantt markers. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-006 | **Partial** | Shared `ActionDialog` in most places, but several components still use the raw dialog or sheets; several status vocabularies and raw palette classes remain. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-007 | **Partial** | Nav is the six places plus Needs, Residuals and Roadmap; `/matrix` redirects. Still: `/gaps` beside `/?place=gaps`, `/roadmap` beside `/timeline`, `/mappings` unlinked (hidden by KAN-56), `/ideation` reached only from an inline link. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8), [KAN-17](https://synapse21.atlassian.net/browse/KAN-17) |
| REQ-UX-008 | **Partial** | KAN-68 copy fixes removed stage jargon from customer text as far as the source shows; not browser-checked. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-009 | **Partial** | Focus styles, `aria-sort`, announced dialog errors, keyboard-opened rail (e2e `rail-focus.spec.ts`, `dialog-viewport.spec.ts`); no a11y lint or axe/contrast checks; some colour-only status. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-010 | Met | Light by default with a dark toggle (`theme-toggle.tsx`, `THEME_SCRIPT` in `src/app/layout.tsx`); responsive breakpoints in the chrome. Tablet not browser-tested. | — |

### 13. Quality, performance and operations

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-OPS-001 | **Partial** | Commits are KAN-keyed through KAN-68. Whether each issue records browser QA lives in Jira and is not checked here. | — |
| REQ-OPS-002 | **Partial** | `.github/workflows/ci.yml` runs typecheck, lint, Vitest and Playwright ([13-testing.md](13-testing.md)). Not confirmed green on `main` for this check, and the Room and Breakouts specs are skipped. | [KAN-19](https://synapse21.atlassian.net/browse/KAN-19) |
| REQ-OPS-003 | **Missing** | Platform and workspace DDL run once per process or schema, but `loadState()` calls `ensureSchema()` on every call and reads the whole workspace; pages write while rendering (blank-workspace persist and gap renumbering in `loadState`, `ensureAllLiveGapsHaveNeeds` on `/` and `/gaps`). | [KAN-14](https://synapse21.atlassian.net/browse/KAN-14) |
| REQ-OPS-004 | **Missing** | No transactions in `src/lib/iegp/store.ts` (only in auth `customers.ts` / `accounts.ts`); `nextId` is max + 1, so ids can be reused after the highest row is deleted. | [KAN-15](https://synapse21.atlassian.net/browse/KAN-15) |
| REQ-OPS-005 | Met | README, deploy docs and the product docs were re-checked against the code on 4 Oct 2026 (branch `KAN-docs-refresh`). | — |
| REQ-OPS-006 | **Partial** | `xlsx` 0.18.5 (known high-severity advisories, no fix on npm) now parses user uploads (`local-parse.ts`) with only the 3 MB cap as mitigation. `npm audit` was not re-run for this check. | [KAN-20](https://synapse21.atlassian.net/browse/KAN-20) |

## Recommended order

1. **Data correctness and performance:** [KAN-15](https://synapse21.atlassian.net/browse/KAN-15) (transactions, id reuse), [KAN-17](https://synapse21.atlassian.net/browse/KAN-17) (retire the legacy band system), [KAN-14](https://synapse21.atlassian.net/browse/KAN-14).
2. **Abuse limits:** [KAN-20](https://synapse21.atlassian.net/browse/KAN-20) (workspace creation, parse volume, `xlsx`).
3. **Remaining manual-control gaps:** [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) (rationale on every edit, manual ideas for any Open gap), [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) (save-as-final checks).
4. **Views:** [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) (Summary, List bulk actions, Board, Calendar, consistency).
5. **Owner decisions:** decide when Room and Breakouts come back. (REQ-AI-006 was dropped on 4 Oct 2026; AI is controlled in the admin panel.)
