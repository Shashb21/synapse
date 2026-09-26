# Application audit — 26 Sep 2026

Jira: [KAN-6](https://synapse21.atlassian.net/browse/KAN-6) · Epic [KAN-5](https://synapse21.atlassian.net/browse/KAN-5) · Code at `main` @ `c97344f`

The audit covered:
- a live browser walkthrough with Playwright MCP (login, workspaces, Start, Timeline, Room);
- three read-only code reviews: the customer app and UX; the server, security and permissions; and the owner tool, tests, docs and ops.

Findings carry stable IDs (`AUD-…`). [Requirements](../sdlc/01-requirements.md) and the [compliance check](../sdlc/requirements-compliance.md) cite them.

Severity scale:
- **High:** a security hole, data loss or corruption, or a core flow broken.
- **Medium:** wrong behaviour, a broken promise to the user, or a significant UX gap.
- **Low:** polish, copy, or dead code.

---

## 1. Security and permissions

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| AUD-SEC-01 | High | `/api/iegp` checks no capability and trusts `actor_name`/`actor_function` from the request body. Any member, including a `viewer`, can `reset` the workspace, validate gaps and lock priorities, and can record edits under any name. | `src/app/api/iegp/route.ts:157-168` |
| AUD-SEC-02 | High | The workspace cookie secret falls back to a hard-coded value. `SESSION_SECRET` is not documented or required, so a forged `session`/`workspace` cookie pair can open the Default workspace. | `src/modules/workspaces/context.ts:36-37` |
| AUD-SEC-03 | High | Data APIs check only the cookie HMAC, never the session row or membership. A removed member keeps API access for the cookie's 30-day life, and cookie pairs survive logout. | `context.ts:87-99`, `workspaces/session.ts:34` |
| AUD-SEC-04 | High (once Microsoft SSO is on) | An unverified email becomes the identity: Microsoft tenant `common` with `preferred_username`, and Google `email_verified` unchecked. Membership and `OWNER_EMAILS` match on email, so takeover is possible. | `src/modules/auth/idp.ts:43-53`, `session.ts:226` |
| AUD-SEC-05 | Medium | Any SSO user signs in as `medical_affairs` (with `save_final`); there is no domain allowlist. Claiming the Default workspace is non-atomic, and roles are global rather than per workspace. | `session.ts:233-238`, `workspaces/store.ts:125-134` |
| AUD-SEC-06 | Medium | `/api/control save_axes` can write the Default workspace's axes without a workspace, because the proxy leaves it open and `db()` falls back to `public`. | `api/control/route.ts`, `gate.ts:20`, `context.ts:93` |
| AUD-SEC-07 | Medium | `/api/sources/blocks` and `/api/room` have no capability check. A viewer can run S10 (it is mapped to `export`) and save draft plans. | `sources/blocks/route.ts:109`, `run.ts:113`, `roles.ts:56` |
| AUD-SEC-08 | Medium | Demo sign-in takes `role` from the body (including `operator`, which means owner). Only `NODE_ENV` guards it. With no IdP configured, unsigned callers get `medical_affairs`. | `login/route.ts:25`, `session.ts:137-145,277` |
| AUD-SEC-09 | Medium | Secrets are stored in plaintext: LLM OAuth tokens and session ids. DB TLS does not verify the certificate. | `llm/oauth.ts:226-239`, `iegp/db.ts:29` |
| AUD-SEC-10 | Medium | There are no limits on upload size (S0), LLM parse units, fetch timeouts or workspace creation. | `s0-upload/module.ts:13-22`, `llm-structure.ts:137` |
| AUD-SEC-11 | Low | Open redirect via `/\t/evil.com` in `safeNext`. | `redirect.ts:6-11` |
| AUD-SEC-12 | Low | Owner-only accuracy routes also record the actor name from the body. | `claims/validate/route.ts:37` |

## 2. Data, migration and performance

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| AUD-DAT-01 | High | Source-block side tables are created in only one schema per process. Block edits break in every other workspace. | `src/lib/iegp/source-blocks.ts:104-113` |
| AUD-DAT-02 | Medium | Bootstrapping a table depends on import order, and missing-table errors are swallowed on reset. | `registry.ts:18-24`, `kernel/db.ts:153` |
| AUD-DAT-03 | Medium | Lazy DDL caches a rejected promise forever, so one database blip at boot bricks the process. There is no migration tool. | `kernel/db.ts:119`, `ai-switch.ts:23` |
| AUD-DAT-04 | Medium | The code has no transactions at all. `persistState` wipes and then re-inserts about 20 tables, `reset` is not atomic, and ingest can half-complete. | `store.ts:262-316`, `ingest-pipeline.ts:91-93` |
| AUD-DAT-05 | Medium | IDs are max+1 and get reused after delete or reset, so edit records and signals attach to new entities. | `store.ts:333-339` |
| AUD-DAT-06 | Low | `module_runs`, `edit_records` and `source_files` stamp `workspace_id: "default"` in every schema. Customer run summaries leak into the shared `eval_runs`. | `run.ts:138,197-204` |
| AUD-DAT-07 | High (perf) | `ensureSchema()` re-runs about 42 DDL statements on every `loadState()` (107 call sites). | `iegp/db.ts:273-279` |
| AUD-DAT-08 | High (perf) | `loadState` reads the whole workspace, including full texts and audit. It runs on every page shell and in N+1 loops. | `store.ts:103-148,479-507` |
| AUD-DAT-09 | Medium | The home, `/gaps` and `/gaps/[id]` pages write to the DB just by rendering (`ensureAllLiveGapsHaveNeeds`), creating needs and a pseudo-source. | `page.tsx:98`, `store.ts:504-509` |
| AUD-DAT-10 | Medium | On Vercel the pool is `max:1`, and every workspace query costs 3 round trips. | `iegp/db.ts:28,68-77` |

## 3. Decision compliance (the owner's architecture rules)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| AUD-DEC-01 | Medium | Two priority systems coexist: the legacy 4-band `priorities`/`/residuals` and the S8 3-band placements. The Room PPTX export and `/tactics` use the legacy one, so they disagree with the matrix. | `export-pack.tsx:108-116`, `tactics/page.tsx:42-46` |
| AUD-DEC-02 | Medium | With AI **on**, nothing can be entered by hand until something is ingested: Gaps, Prioritize and Tactics are locked, and Add gaps shows only when AI is off. This contradicts "manual entry for everything". | live walkthrough, `plan-chrome.tsx:107-161` |
| AUD-DEC-03 | Low | Manual create quietly fills in defaults: the name comes from the statement, the domain defaults to `unmet_need`, and the tactic type defaults to "Phase III trial". | `store.ts:2373,2385`, `plan-cards.tsx:106` |
| AUD-DEC-04 | Low | S5 `map_tactic` does not pass `human: true`, so it is refused after a rejection. | `s5-validation/module.ts:141-147` |
| AUD-DEC-05 | Low | Dead rule-based code still ships: the legacy insights-engine code (`src/lib/store.ts`, `pipeline.ts`, `cluster/*`, `extract/*`) and the LlamaParse client. | import scan |
| AUD-DEC-06 | Low | The AI switch fails open to "on" in the UI when the read fails. | `layout.tsx`, `routing.ts previewRoute` |

## 4. Customer UX

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| AUD-UX-01 | Medium | Duplicate surfaces: `/gaps` (an orphan, which lists retired gaps) against the Gaps workbench; `/tactics` against the Tactics place; `/roadmap` against Timeline; `/residuals` against the gap-page leftovers. | page inventory |
| AUD-UX-02 | Medium | There are four ways to attach a tactic, three dialog implementations with different identity handling, and three gap-status vocabularies. | `gap-tactic-actions.tsx`, `lock-form.tsx`, `action-dialog.tsx` |
| AUD-UX-03 | Medium | Nothing has search. Gaps has no domain or setting filter, lists have no filters, and there are no bulk actions (every confirm is one dialog per item). | — |
| AUD-UX-04 | Medium | Orphan and hard-to-find pages: `/gaps`, `/sources`, `/ideation` and `/breakouts` are not in the nav. | `plan-chrome.tsx` |
| AUD-UX-05 | Medium | Dead ends: setup's "Add tactics" leads to a locked page with no add button. Tactics never unlocks when there are zero Open gaps. Excluded gaps cannot be restored. Rejected tactics disappear. | `prioritize-place.tsx:133`, `gaps/[id]/page.tsx:605` |
| AUD-UX-06 | Medium | Stale copy: the Timeline tells customers to use the owner-only Pipeline; "Present this plan" links to `/presentation`; setup mentions logging in to Grok and "the control panel"; `/residuals` refers to "Review". | `timeline-board.tsx:522`, `setup-wizard.tsx:297,333` |
| AUD-UX-07 | Low | Internal jargon shown to customers: "hillclimb", "S4 proposal", "human gate", raw capability chips such as "toggle ai", and "S10 · the truth artifact". | various |
| AUD-UX-08 | Medium | The Room "Context" slide is the setup form, not a summary. The walkthrough can render inside Room frames and the audience window. | `lib/room/slides.ts`, `walkthrough-host.tsx:16` |
| AUD-UX-09 | Medium | Accessibility: many inputs have no label; tooltips are on non-focusable spans; Gantt bars are hidden by `role="img"` and show no focus ring; text is often 10–11px. | `ingest-panel.tsx:77-108`, `iegp-badges.tsx:25`, `gantt-chart.tsx:219` |
| AUD-UX-10 | Low | Visual inconsistency: raw Tailwind colours instead of tokens, band colours that differ per surface, 60 hand-styled `<select>`s, and the app is dark-only. | `globals.css`, `iegp-badges.tsx:39-101` |
| AUD-UX-11 | Low | The login page throws two 401 console errors because the walkthrough fetches before sign-in. | live walkthrough |
| AUD-UX-12 | Low | "Save as final" is enabled with zero activities, and "changed since last save" compares only activity counts. | `timeline-board.tsx:94` |

## 5. Front-end bugs

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| AUD-BUG-01 | Medium | About 10 dialogs don't catch a failed `fetch`, so a network error or a 500 leaves the button stuck on "Saving…". | `lock-form.tsx:116`, `action-dialog.tsx:102`, … |
| AUD-BUG-02 | Low | `request.json()` sits outside `try`, so a malformed body returns 500. Every error comes back as 400, including authorization failures. | `iegp/route.ts:157`, `plan/route.ts:107` |
| AUD-BUG-03 | Medium | Prioritize matrix: a shared nudge timer drops an earlier gap's move, and the auto-S8 effect runs in every mounted matrix (including Room frames) and never retries. | `prioritize-matrix.tsx:501-518,621` |
| AUD-BUG-04 | Medium | The mapping table's row set comes from the raw `gap.status`: it excludes Addressed gaps, ignores overrides and includes parked gaps. Row editors go stale after a refresh. | `mapping-table.ts:84`, `mapping-table-workbench.tsx:191` |
| AUD-BUG-05 | Low | The Gaps filter ignores the URL on soft navigation, so the readiness-strip links do nothing. | `gaps-workbench.tsx:318` |
| AUD-BUG-06 | Low | `/residuals` crashes on a missing gap (non-null `!`). `AddGapsDialog` fails partway without refreshing. Ideation renders duplicate "Run S9" buttons that ignore the role. | `residuals/page.tsx:13`, `breakout-room.tsx:89`, `ideation/page.tsx:132-198` |
| AUD-BUG-07 | Medium | `/room` and `/room/audience` skip the AppShell auth check, and the audience iframe is fully editable. | `room/page.tsx` |

## 6. Owner tool, tests, docs, ops

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| AUD-OPS-01 | Medium | CI runs only unit tests and typecheck. It runs no e2e and no lint. | `.github/workflows/ci.yml` |
| AUD-OPS-02 | Medium | Five e2e specs fail on `main`: 4 stale assertions (s5, s8, platform, control-panel-oauth) and 1 hard-coded `/opt/cursor` screenshot path (gantt save-final). | `e2e/*` |
| AUD-OPS-03 | Medium | The e2e run uses the dev DB from `.env.local` (not `synapse_test`) and calls `reset` on the selected workspace. The AI-off spec restores AI only in `afterAll`. | `playwright.config.ts:18-26` |
| AUD-OPS-04 | Medium | Most docs are stale: `01-requirements` described the old insights engine; the README route table, deploy checklist and `iegp-model` refer to "no login", `/control` and LlamaParse. | docs audit |
| AUD-OPS-05 | Medium | `OWNER_EMAILS` and `SESSION_SECRET` are not in `.env.example` or the deploy docs. Without them, production has no owner and uses a weak cookie secret. | `.env.example` |
| AUD-OPS-06 | Medium | `npm audit` reports 8 high: `xlsx` (no fix available), `mermaid` → lodash-es, and `pptxgenjs` → `image-size`. | `package.json` |
| AUD-OPS-07 | Low | Bare `npm run lint` scans `.claude/worktrees` and reports 51k problems. On real sources: 0 errors, 4 warnings. | `eslint.config.mjs` |
| AUD-OPS-08 | Low | Two parallel stacks (the accuracy lab and the customer app) duplicate the kernel, routing, runs, plans, Gantt and workshop. This is by design for now, but it costs maintenance. | `src/accuracy/**` |
| AUD-OPS-09 | Low | The package is still named `velmara-insights-engine`, and `clsx`/`tailwind-merge` are declared but unused. | `package.json` |

## 7. What is working well

- LLM-only judgement is enforced across S1–S10: `requireLlm` and `completeAll`, and the test stub is refused in production.
- Human edits survive re-runs: S4 skips human-rejected or locked pairs, S8 keeps human axes and bands, S9 only inserts, S10 marks human values, and S1 keeps human blocks.
- The AI switch is enforced in the kernel, the accuracy runner, ingest and upload. S10 still works with AI off.
- Workspace isolation holds: one schema per workspace, a single pool with per-query `search_path`, and no fallback leaks.
- The owner gate is on every `/admin` page and owner API.
- Unit tests: 577 cases across 81 files. E2E: 134 of 139 pass.
