# Requirements — Synapse IEGP

Status: **v2, 26 Sep 2026** (replaces the v1 "Velmara Insights Engine" requirements, archived in [archive-01-requirements-insights-engine.md](archive-01-requirements-insights-engine.md)).

IDs are stable: tests, the audit and the [compliance check](requirements-compliance.md) cite them. Priorities are **Must**, **Should** and **Could**.

Jira: [KAN-7](https://synapse21.atlassian.net/browse/KAN-7).

## Product intent

Synapse is where a Medical Affairs consultant and their pharma client team build an **Integrated Evidence Generation Plan (IEGP)** for one asset. The work runs in this order:
1. Capture the plan's context.
2. Turn source documents, or hand entry, into named **evidence gaps**.
3. Map existing **tactics** to those gaps and record how fully each one covers them.
4. Resolve partially addressed gaps.
5. **Prioritize** the open gaps.
6. **Ideate** new tactics.
7. Lay the plan out on a **timeline**.
8. Present and decide in the **Room**.

AI drafts; people decide. Everything the AI does, a person can do by hand, and a person's decision is never overwritten by the AI. The owner runs a separate, owner-only tool for testing and operations.

## 1. Accounts, login and roles

| ID | Requirement | Pri |
|---|---|---|
| REQ-AUTH-001 | People sign in with SSO (Google, Microsoft, GitHub) on a `/login` page. | Must |
| REQ-AUTH-002 | Demo sign-in exists only outside production and is never offered to customers. | Must |
| REQ-AUTH-003 | A signed-in identity is trusted only when verified. It is keyed on a stable subject or a verified email, never on an unverified, user-editable claim. | Must |
| REQ-AUTH-004 | Every customer page and API requires a valid, unexpired session. Signing out ends access immediately. | Must |
| REQ-AUTH-005 | The name recorded on every edit, lock and audit row is the signed-in person's. It is never taken from the request body. | Must |
| REQ-AUTH-006 | Roles govern what a person may do: Medical Affairs (owns the plan, can save final), Contributor (edits, cannot save final), Viewer (read and export only). Every mutating API enforces them server-side. | Must |
| REQ-AUTH-007 | Secrets needed for security (the session/workspace signing secret) are required in production; the app refuses to start without them. | Must |

## 2. Workspaces

| ID | Requirement | Pri |
|---|---|---|
| REQ-WS-001 | Each workspace holds exactly one IEGP. Its data is isolated from every other workspace. | Must |
| REQ-WS-002 | After sign-in a person with no workspace is prompted to create one. The workspace is saved and they land in its setup. | Must |
| REQ-WS-003 | A person's existing workspaces are listed, and they can open any of them. | Must |
| REQ-WS-004 | A visible workspace tag switches between workspaces from anywhere in the app. | Must |
| REQ-WS-005 | Workspaces are shared by invitation by email. The owner can rename the workspace and remove members. A removed member loses all access at once. | Must |
| REQ-WS-006 | The data that existed before workspaces becomes the Default workspace, owned by the first person to sign in. | Must |
| REQ-WS-007 | Workspace creation is rate-limited, and each person's number of workspaces is capped. | Should |

## 3. Setup wizard and walkthrough

| ID | Requirement | Pri |
|---|---|---|
| REQ-SET-001 | A setup wizard captures the IEGP context per workspace:<br>• asset (name, INN, mechanism, modality, therapeutic area, indications, lifecycle stage, markets)<br>• company and plan (situation, owner, sponsoring function, horizon, cycle)<br>• objectives and key decisions with dates<br>• evidence landscape (competitors, standard of care, comparators, payer/HTA bodies, regulatory milestones, launch timeline)<br>• stakeholders<br>• treatment settings | Must |
| REQ-SET-002 | The wizard can be saved as a draft, revisited and edited at any time. | Must |
| REQ-SET-003 | The stages use the captured context: S8 prioritization, S9 ideation, S10 decision dates, and setting tags. | Must |
| REQ-SET-004 | A guided walkthrough tours the main places, with progress kept per person per workspace. It can be restarted. It never appears on login or workspace screens, or inside presented slides. | Must |

## 4. Sources and parsing

| ID | Requirement | Pri |
|---|---|---|
| REQ-SRC-001 | Upload PDF, PPTX, DOCX, XLSX and text files (only while AI is on). | Must |
| REQ-SRC-002 | Parsing is done by the chosen LLM. Text is extracted mechanically, then the model decides blocks, kinds and headings. LlamaParse is disabled. | Must |
| REQ-SRC-003 | Every block is a verbatim span of the source. Noise dropped by the model carries a reason. The stakeholder function is classified by the model, not guessed from the filename. | Must |
| REQ-SRC-004 | A person can edit, split, merge, add, delete and restore blocks, and override the stakeholder function. Human blocks survive a re-parse. Edits that would orphan a cited quote are refused. | Must |
| REQ-SRC-005 | Upload size and parse volume are capped. | Should |

## 5. Needs and gaps

| ID | Requirement | Pri |
|---|---|---|
| REQ-GAP-001 | A gap is a named decision object with a statement, domain, treatment-setting tags and at least one constituent need that carries a verbatim source quote. | Must |
| REQ-GAP-002 | The LLM extracts gaps (S2): a model proposer, a model critic and a model judge decide which gaps to keep and what each duplicates. No keyword or similarity rules are used. | Must |
| REQ-GAP-003 | A person can create, edit (name, statement, domain), park, exclude and **restore** gaps, and add, edit, move and unlink needs. Moving a need is how an AI merge is corrected. | Must |
| REQ-GAP-004 | Gap status is one of Open, Partially Addressed or Addressed. It is derived only from recorded coverage verdicts (proposed tactics do not count), or set by a person's override with a required reason. Overrides show when they go stale. | Must |
| REQ-GAP-005 | A Partially Addressed gap must be resolved by a split (an Addressed part plus an Open leftover) or a rewrite. The model can suggest the split; a person decides. | Must |
| REQ-GAP-006 | Candidates the AI rejected can be reviewed and promoted by hand. | Should |

## 6. Tactics and mapping

| ID | Requirement | Pri |
|---|---|---|
| REQ-TAC-001 | A tactic has a name, type, status (completed/ongoing/planned/proposed/cancelled), evidence question, PICO, study design, data source, dates and a source quote. The LLM extracts them from sources (S3). | Must |
| REQ-TAC-002 | A person can create and edit every tactic field, accept or reject a tactic, and restore a rejected one. No hidden defaults are filled in. | Must |
| REQ-MAP-001 | The LLM maps gaps to tactics (S4). For each pair it records overall coverage and ten dimensions, with a critic and a judge. | Must |
| REQ-MAP-002 | A person can map a tactic with coverage in one step, remove a mapping, set every dimension and the overall verdict with their own rationale, and accept or reject AI proposals. | Must |
| REQ-MAP-003 | AI re-runs never re-map a pair a person rejected or removed, and never touch a coverage a person locked. They never un-validate a gap a person validated; a change is flagged for review instead. | Must |

## 7. Prioritization, ideation, timeline

| ID | Requirement | Pri |
|---|---|---|
| REQ-PRI-001 | There is one prioritization system. Open gaps sit on a two-axis matrix per treatment setting, and the band (High, Medium or Low) is the quadrant. The model suggests the scores; a person validates the band. | Must |
| REQ-PRI-002 | A person can place, score and validate any gap by hand without an AI run. Drags and hand-set values survive re-runs. | Must |
| REQ-PRI-003 | Every view, export and downstream stage (Tactics, Room, PPTX) uses the same validated band. | Must |
| REQ-IDE-001 | The model proposes new tactics (S9) with full designs and timing for validated High gaps, with a critic and a judge. | Must |
| REQ-IDE-002 | A person can add ideas by hand for any open gap, and edit any idea before accepting it. Edited or decided ideas are never replaced. | Must |
| REQ-TIM-001 | The timeline (S10) lays activities out from human dates first, then designed dates, then model estimates. Dependencies are inferred by the model. Unvalidated gaps sit in a "Not yet prioritized" lane. | Must |
| REQ-TIM-002 | A person can date, add, remove and restore activities, and set dependencies, lanes and reasons, all without AI. Human values survive rebuilds. | Must |
| REQ-TIM-003 | The plan is saved as final only by Medical Affairs, and only when every activity is dated. Changes since the last save are flagged accurately. | Must |

## 8. AI governance

| ID | Requirement | Pri |
|---|---|---|
| REQ-AI-001 | Every judgement is made by an LLM, never by hard-coded rules (keywords, thresholds, similarity, defaults). | Must |
| REQ-AI-002 | If no LLM is connected, an AI stage fails with a clear error. It never falls back to rules. | Must |
| REQ-AI-003 | Incomplete or invalid model output is re-asked, then fails. Nothing is filled in by rule. | Must |
| REQ-AI-004 | An admin can switch AI on or off with one click, with no reason required. With AI off:<br>• no model is called and no automatic AI step runs;<br>• AI controls are hidden;<br>• there is no upload or parsing, and the first screen is Add gaps and Add tactics;<br>• everything else still works by hand. | Must |
| REQ-AI-005 | With AI **on**, every manual path is still available. A person can start by adding gaps and tactics by hand without ingesting anything. | Must |

## 9. Manual control and audit

| ID | Requirement | Pri |
|---|---|---|
| REQ-MAN-001 | Every AI output has a manual create path and a manual edit/override path in the UI. | Must |
| REQ-MAN-002 | A person's edit is never overwritten or undone by a later AI run. The AI may only add new suggestions. | Must |
| REQ-MAN-003 | Every edit requires a short rationale (except the AI switch) and is recorded with before and after values and the signed-in person. | Must |

## 10. Room (presenting and workshops)

| ID | Requirement | Pri |
|---|---|---|
| REQ-ROOM-001 | Room is a PowerPoint-style presenter view whose slides are the real app pages. The consultant's window shows the current slide (editable), a preview of the next slide, notes, a timer and a slide list, with keyboard and clicker control. | Must |
| REQ-ROOM-002 | An audience window follows the presenter in real time, including on another machine, and shows no app chrome. | Must |
| REQ-ROOM-003 | Breakout groups are reachable from Room. Room never shows the owner's accuracy tool. | Must |
| REQ-ROOM-004 | The opening slide is a readable plan summary, not an edit form. | Should |

## 11. Owner tool

| ID | Requirement | Pri |
|---|---|---|
| REQ-ADM-001 | A separate `/admin` console holds the AI switch, model routing and provider logins, the accuracy lab, pipeline, runs, evals, catalog, module versions and docs. It is reachable only by the owner (the operator role or `OWNER_EMAILS`). | Must |
| REQ-ADM-002 | The customer app never links to or shows owner surfaces. | Must |

## 12. User experience (Jira-inspired)

| ID | Requirement | Pri |
|---|---|---|
| REQ-UX-001 | A Summary view shows plan health: counts by status and band, what needs attention, and upcoming decisions and readouts. | Must |
| REQ-UX-002 | A List view presents gaps and tactics in a table with sort, filter, group, text search, inline edit and bulk actions. | Must |
| REQ-UX-003 | A Board view shows columns by status or band, with drag to change (with rationale). | Should |
| REQ-UX-004 | A Timeline view shows the roadmap Gantt with dependencies (see REQ-TIM). | Must |
| REQ-UX-005 | A Calendar view shows key decisions, readouts and milestones. | Should |
| REQ-UX-006 | One consistent detail panel is used for any item, and one dialog pattern for edits. The app has one status vocabulary and one set of design tokens. | Must |
| REQ-UX-007 | There are no duplicate pages, orphans or dead ends. Every place is reachable from the nav. | Must |
| REQ-UX-008 | Customer copy is plain language: no internal jargon (stage numbers, "hillclimb", capability names). | Must |
| REQ-UX-009 | Accessibility: every control has a label; everything is keyboard reachable with visible focus; contrast meets WCAG AA; nothing is conveyed by colour alone. | Must |
| REQ-UX-010 | A light theme with dark mode, and a responsive layout down to tablet. | Should |

## 13. Quality, performance and operations

| ID | Requirement | Pri |
|---|---|---|
| REQ-OPS-001 | Work is tracked in Jira (KAN). An issue is Done only after browser QA of the running app with Playwright MCP and Claude in Chrome, recorded on the issue. | Must |
| REQ-OPS-002 | CI runs unit tests, typecheck, lint and the e2e suite, and every test passes on `main`. | Must |
| REQ-OPS-003 | Pages respond quickly: no full-workspace load or DDL on every request, and no writes during page render. | Must |
| REQ-OPS-004 | Multi-row writes are transactional. IDs are never reused. | Must |
| REQ-OPS-005 | Docs (README, deploy, environment variables) match the product. | Should |
| REQ-OPS-006 | There are no known high-severity dependency vulnerabilities without a mitigation. | Should |

## Retired requirements

v1 IDs `REQ-ING-*`, `REQ-EXT-*`, `REQ-CLU-*`, `REQ-KNO-*`, `REQ-GRF-*`, `REQ-EVA-*` and `REQ-REG-*` described the retired insights/theme engine. They are superseded by this document. Their eval and hill-climb intent survives only in the owner tool.
