# Requirements compliance check — 26 Sep 2026

This checks [the requirements (v2)](01-requirements.md) against the app at `main` @ `c97344f`. The evidence comes from the [application audit](../audit/2026-09-26-application-audit.md) (`AUD-…`), the unit and e2e suites, and a live browser walkthrough.

Jira: [KAN-7](https://synapse21.atlassian.net/browse/KAN-7). Each gap links to its follow-up issue.

**Met** means the behaviour exists and was checked. **Partial** means it exists with a known gap. **Missing** means it is not built.

## Summary

| Area | Met | Partial | Missing |
|---|---|---|---|
| Accounts, login, roles | 2 | 3 | 2 |
| Workspaces | 5 | 1 | 1 |
| Setup and walkthrough | 3 | 1 | 0 |
| Sources and parsing | 3 | 1 | 1 |
| Needs and gaps | 4 | 2 | 0 |
| Tactics and mapping | 3 | 2 | 0 |
| Prioritization, ideation, timeline | 4 | 4 | 0 |
| AI governance | 4 | 1 | 0 |
| Manual control and audit | 1 | 2 | 0 |
| Room | 2 | 1 | 1 |
| Owner tool | 2 | 0 | 0 |
| User experience | 1 | 3 | 6 |
| Quality and operations | 0 | 3 | 3 |
| **Total (72)** | **34** | **24** | **14** |

## Detail

### 1. Accounts, login and roles

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-AUTH-001 | Met | `/login` offers SSO buttons for each configured IdP (`src/app/login`); e2e `login-workspaces.spec.ts`. | — |
| REQ-AUTH-002 | Met | Demo sign-in is refused when `NODE_ENV=production` (`idp.ts:96`, `session.ts:268`). Hardening is under KAN-12. | [KAN-12](https://synapse21.atlassian.net/browse/KAN-12) |
| REQ-AUTH-003 | **Missing** | The identity comes from an unverified email or `preferred_username` (AUD-SEC-04). | [KAN-12](https://synapse21.atlassian.net/browse/KAN-12) |
| REQ-AUTH-004 | **Partial** | Pages check the session, but data APIs verify only the cookie HMAC (AUD-SEC-03). | [KAN-10](https://synapse21.atlassian.net/browse/KAN-10) |
| REQ-AUTH-005 | **Missing** | `/api/iegp` takes the actor from the request body (AUD-SEC-01). | [KAN-10](https://synapse21.atlassian.net/browse/KAN-10) |
| REQ-AUTH-006 | **Partial** | Roles are enforced on `/api/plan` and in `runStage`, but not on `/api/iegp`, `/api/sources/blocks` or `/api/room` (AUD-SEC-01, AUD-SEC-07). | [KAN-10](https://synapse21.atlassian.net/browse/KAN-10) |
| REQ-AUTH-007 | **Partial** | A hard-coded fallback secret is used when none is set (AUD-SEC-02). | [KAN-11](https://synapse21.atlassian.net/browse/KAN-11) |

### 2. Workspaces

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-WS-001 | Met | One schema per workspace, with a single pool and per-query `search_path` (`tests/workspaces.test.ts` isolation). The block-table bug is tracked separately. | [KAN-13](https://synapse21.atlassian.net/browse/KAN-13) |
| REQ-WS-002 | Met | `/workspaces` shows "create first", then `/setup?new=1` (e2e). | — |
| REQ-WS-003 | Met | The list shows role and created date, with Open. Checked in the browser walkthrough. | — |
| REQ-WS-004 | Met | The workspace tag in the sidebar switches workspaces (e2e). | — |
| REQ-WS-005 | **Partial** | Invite, rename and remove exist, but a removed member keeps API access (AUD-SEC-03). | [KAN-10](https://synapse21.atlassian.net/browse/KAN-10) |
| REQ-WS-006 | Met | The first sign-in claims Default (`workspaces/store.ts`). The claim is non-atomic; see KAN-12. | [KAN-12](https://synapse21.atlassian.net/browse/KAN-12) |
| REQ-WS-007 | **Missing** | There is no limit on creating workspaces (AUD-SEC-10). | [KAN-20](https://synapse21.atlassian.net/browse/KAN-20) |

### 3. Setup and walkthrough

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-SET-001 | Met | The wizard covers every listed section (`setup-wizard.tsx`; `tests/setup-wizard-*`). | — |
| REQ-SET-002 | Met | Drafts, resume, and editing after completion (e2e `setup-wizard.spec.ts`). | — |
| REQ-SET-003 | Met | `prioritizationContextFromState` feeds S8, S9 and S10. Treatment settings become setting tags. | — |
| REQ-SET-004 | **Partial** | The walkthrough can render inside Room frames, and it throws 401s on `/login` (AUD-UX-08, AUD-UX-11). | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |

### 4. Sources and parsing

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-SRC-001 | Met | Upload works in both apps and is refused with AI off (`tests/ai-switch.test.ts`). | — |
| REQ-SRC-002 | Met | `parseWithLlm`. LlamaParse is not imported anywhere (AUD-DEC-05 notes the dead file). | [KAN-21](https://synapse21.atlassian.net/browse/KAN-21) |
| REQ-SRC-003 | Met | Verbatim check, dropped-unit reasons and LLM stakeholder classification (`tests/llm-parse.test.ts`). | — |
| REQ-SRC-004 | **Partial** | The block editor works, but its side tables exist in only one schema per process, so edits fail in other workspaces (AUD-DAT-01). | [KAN-13](https://synapse21.atlassian.net/browse/KAN-13) |
| REQ-SRC-005 | **Missing** | Upload size and parse volume are uncapped (AUD-SEC-10). | [KAN-20](https://synapse21.atlassian.net/browse/KAN-20) |

### 5. Needs and gaps

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-GAP-001 | Met | Gaps carry needs with quotes (`iegp-model`, `tests/iegp-store.test.ts`). | — |
| REQ-GAP-002 | Met | S2 uses a model proposer, critic and judge, with `duplicate_of` (`tests/s2-llm.test.ts`). | — |
| REQ-GAP-003 | **Partial** | Edit, park, needs and move all exist, but an excluded gap cannot be restored (AUD-UX-05). | [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) |
| REQ-GAP-004 | Met | Status is derived from coverage verdicts, and overrides go stale (`engine.ts:131-145`). | — |
| REQ-GAP-005 | Met | The split and rewrite dialog, where the S6 model suggests and a person decides. | — |
| REQ-GAP-006 | **Partial** | Promote works on `/needs` and `/tactics`, but those pages are hard to find (AUD-UX-04). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |

### 6. Tactics and mapping

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-TAC-001 | Met | Fields and S3 extraction (`tests/s3-llm.test.ts`). | — |
| REQ-TAC-002 | **Partial** | Edit works, but rejected tactics vanish, and the type defaults to "Phase III trial" (AUD-UX-05, AUD-DEC-03). | [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) |
| REQ-MAP-001 | Met | S4 with a model critic and judge (`tests/s4-llm.test.ts`). | — |
| REQ-MAP-002 | **Partial** | All the actions exist, but the mapping table's row set and its stale editors are wrong (AUD-BUG-04). | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |
| REQ-MAP-003 | Met | Rejected and locked pairs are respected, and validation survives with a stale flag (`tests/manual-mapping.test.ts`). | — |

### 7. Prioritization, ideation, timeline

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-PRI-001 | **Partial** | The S8 matrix exists, but the legacy 4-band system still runs alongside it (AUD-DEC-01). | [KAN-17](https://synapse21.atlassian.net/browse/KAN-17) |
| REQ-PRI-002 | Met | Place and score by hand, and human axes survive (`tests/manual-plan-prioritize-ideate.test.ts`). Matrix races are tracked separately. | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |
| REQ-PRI-003 | **Partial** | The PPTX export and `/tactics` use legacy bands (AUD-DEC-01). | [KAN-17](https://synapse21.atlassian.net/browse/KAN-17) |
| REQ-IDE-001 | Met | S9 with model critic and judge, and a per-gap cap (`tests/s9-llm.test.ts`). | — |
| REQ-IDE-002 | **Partial** | Add and edit work, but manual add is limited to validated High gaps (audit page inventory). | [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) |
| REQ-TIM-001 | Met | Human, then design, then model; a "Not yet prioritized" lane (`tests/s10-llm.test.ts`). | — |
| REQ-TIM-002 | Met | Date, add, remove, dependencies and lane all work without AI (`tests/manual-timeline.test.ts`). | — |
| REQ-TIM-003 | **Partial** | "Save final" is enabled with no activities, and the "changed since last save" check compares counts only (AUD-UX-12). | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |

### 8. AI governance

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-AI-001 | Met | No rule path runs in production; stubs are refused there (server audit §3a). Dead code remains. | [KAN-21](https://synapse21.atlassian.net/browse/KAN-21) |
| REQ-AI-002 | Met | `requireLlm` and `NoRouteError` (`tests/*-llm.test.ts`). | — |
| REQ-AI-003 | Met | `completeAll` re-asks, then fails. | — |
| REQ-AI-004 | Met | A one-click toggle, and the kernel refuses (`tests/ai-switch.test.ts`, e2e `ai-off.spec.ts`). The UI read fails open (AUD-DEC-06, Low). | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |
| REQ-AI-005 | **Partial** | With AI on, nothing can be added by hand until something is ingested (AUD-DEC-02). | [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) |

### 9. Manual control and audit

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-MAN-001 | **Partial** | Manual paths exist for every AI output, but some are hard to reach or dead-end (AUD-UX-05). | [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) |
| REQ-MAN-002 | Met | Human edits survive re-runs across S1, S4, S8, S9 and S10 (the `manual-*` tests). | — |
| REQ-MAN-003 | **Partial** | Rationale plus before and after values are recorded, but the actor name is forgeable (AUD-SEC-01). | [KAN-10](https://synapse21.atlassian.net/browse/KAN-10) |

### 10. Room

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-ROOM-001 | Met | Presenter console (e2e `room.spec.ts`; checked in the browser walkthrough). | — |
| REQ-ROOM-002 | **Partial** | The audience window follows the presenter, but Room skips the page auth check and the audience frame can be edited (AUD-BUG-07). | [KAN-18](https://synapse21.atlassian.net/browse/KAN-18) |
| REQ-ROOM-003 | Met | Breakouts tab; the accuracy app is never a slide. | — |
| REQ-ROOM-004 | **Missing** | The opening slide is the setup form (AUD-UX-08). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |

### 11. Owner tool

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-ADM-001 | Met | `/admin` with an owner gate on every page and API (`tests/owner-gate.test.ts`, e2e `owner-console.spec.ts`). | — |
| REQ-ADM-002 | Met | No `/admin` links in the customer app (e2e). | — |

### 12. User experience

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-UX-001 | **Missing** | There is no Summary view. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-002 | **Missing** | There is no List view with search, filters and bulk actions (AUD-UX-03). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-003 | **Missing** | There is no Board view. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-004 | Met | The timeline Gantt with dependencies exists. It will be restyled in KAN-8. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-005 | **Missing** | There is no Calendar view. | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-006 | **Missing** | Three dialog patterns, three status vocabularies, and raw colours (AUD-UX-02, AUD-UX-10). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-007 | **Missing** | Duplicate pages, orphans and dead ends (AUD-UX-01, AUD-UX-04, AUD-UX-05). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8), [KAN-17](https://synapse21.atlassian.net/browse/KAN-17) |
| REQ-UX-008 | **Partial** | Jargon remains in customer copy (AUD-UX-07). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-009 | **Partial** | Unlabelled inputs, a non-focusable Gantt and tooltips (AUD-UX-09). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |
| REQ-UX-010 | **Partial** | Dark-only today; responsive in part (AUD-UX-10). | [KAN-8](https://synapse21.atlassian.net/browse/KAN-8) |

### 13. Quality, performance and operations

| ID | Status | Evidence | Follow-up |
|---|---|---|---|
| REQ-OPS-001 | **Partial** | Jira workflow adopted from KAN-5 onward. Claude in Chrome is not yet connected for QA. | — |
| REQ-OPS-002 | **Missing** | CI runs no e2e or lint, and 5 e2e specs fail (AUD-OPS-01, AUD-OPS-02). | [KAN-19](https://synapse21.atlassian.net/browse/KAN-19) |
| REQ-OPS-003 | **Missing** | DDL runs on every load, the whole workspace is read, and pages write while rendering (AUD-DAT-07 to AUD-DAT-09). | [KAN-14](https://synapse21.atlassian.net/browse/KAN-14) |
| REQ-OPS-004 | **Missing** | No transactions; IDs are reused (AUD-DAT-04, AUD-DAT-05). | [KAN-15](https://synapse21.atlassian.net/browse/KAN-15) |
| REQ-OPS-005 | **Partial** | Requirements are now current. README, deploy and environment docs are stale (AUD-OPS-04, AUD-OPS-05). | [KAN-11](https://synapse21.atlassian.net/browse/KAN-11), [KAN-21](https://synapse21.atlassian.net/browse/KAN-21) |
| REQ-OPS-006 | **Partial** | 8 high-severity advisories, one of which (`xlsx`) has no fix (AUD-OPS-06). | [KAN-20](https://synapse21.atlassian.net/browse/KAN-20) |

## Recommended order

1. **Security:** [KAN-10](https://synapse21.atlassian.net/browse/KAN-10), [KAN-11](https://synapse21.atlassian.net/browse/KAN-11), [KAN-12](https://synapse21.atlassian.net/browse/KAN-12). Fix these before any customer uses the app.
2. **Data correctness:** [KAN-13](https://synapse21.atlassian.net/browse/KAN-13), [KAN-15](https://synapse21.atlassian.net/browse/KAN-15), [KAN-17](https://synapse21.atlassian.net/browse/KAN-17).
3. **The Jira-style redesign:** [KAN-8](https://synapse21.atlassian.net/browse/KAN-8), which absorbs most UX gaps, together with [KAN-16](https://synapse21.atlassian.net/browse/KAN-16) and [KAN-18](https://synapse21.atlassian.net/browse/KAN-18).
4. **Performance and CI:** [KAN-14](https://synapse21.atlassian.net/browse/KAN-14), [KAN-19](https://synapse21.atlassian.net/browse/KAN-19).
5. **Remaining items:** [KAN-20](https://synapse21.atlassian.net/browse/KAN-20), [KAN-21](https://synapse21.atlassian.net/browse/KAN-21).
