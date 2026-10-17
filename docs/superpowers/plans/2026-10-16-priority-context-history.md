# Priority context and record history implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute sequentially, one fresh implementer and task review at a time.

**Goal:** Implement the approved KAN-120/KAN-124 backlog without changing prioritisation scoring or tactic eligibility meanings.

**Architecture:** Extend existing S8 placement, workspace transactions, entity history, record loaders and Sheet panels. Preserve one priority per gap and one tactic with separate gap relationships. Reuse the responsible persistence layer for atomic writes, permissions and concurrency checks.

**Tech Stack:** Next.js 16.3.8, TypeScript, React 19, Drizzle/Postgres, Vitest, Playwright.

**Spec:** docs/design/kan-120-spec.md and docs/design/kan-124-spec.md. These approved specs outrank implementation choices in this plan.

## Global Constraints

- Existing human priorities remain confirmed at launch. Never infer dates or fabricate history.
- Manual saved changes require meaningful reasons; supporting references are mandatory for model judgements. Manual date edits need a reason without a reference.
- Current permission/workspace boundaries remain server enforced. Change and history save together or not at all; reject stale writes and retain input after errors.
- New AI ideation remains confirmed High/Open only; existing work and unlocked navigation remain reachable.
- Reuse installed components and current layout conventions. No duplicate audit store, scoring engine, tactic entities or gap question.
- Trace existing behavior and invariants before editing. Read relevant local Next.js guides before code and relevant frontend skills when touching UI.
- Write behavioral tests first, show the expected failure, implement and run the smallest sufficient proof. Deterministic model fixtures only; no paid model calls. Use this TypeScript project's Vitest and Playwright tooling.
- Workers own only their task scope. They are not alone: preserve other changes. No nested subagents, Jira writes, pushes or PR operations. Controller owns git commits/publication and lifecycle actions.
- Record status, changed files, invariants, verification commands/exit codes, limitations and self-review in the requested report. Never mark a task complete merely because code looks done.

## Review Focus

- Optional or missing objective context remains visible and nonblocking (Task 1 browser assertions).
- Concurrent context edits and gap reassignment cannot leave the wrong Open gaps confirmed (Tasks 3 and 4 persistence assertions).
- Old unsupported model records and inaccessible support cannot be accepted as supported AI decisions (Task 5 validation assertions).
- Closing a panel with unsaved input never silently loses work; keyboard focus returns to its invoker (Tasks 6 and 7 browser assertions).
- Changing eligibility never erases existing alternatives or relationships (Tasks 8–10 retained-record browser assertions).

## Execution and interfaces

Draft order is execution order. Native Jira blockers are authoritative for eligibility. Each task brief includes its approved ticket body; later tasks inspect integrated interfaces rather than inventing parallel ones. File lists identify responsible starting points, not permission to change unrelated code. Exact helper names are selected by tracing current ownership; record introduced interfaces in the report for downstream use. Approved Jira scope is unchanged.

### Task 1: KAN-128 — Show evidence needed, decision context and priority next actions

**Files / ownership starting points:** src/components/prioritize/prioritize-place.tsx; src/components/prioritize/prioritize-matrix.tsx; src/components/gap-record-sections.tsx; src/app/gaps/[id]/page.tsx; e2e/features/s8-prioritization.spec.ts. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-120](https://synapse21.atlassian.net/browse/KAN-120)

## What to build

Make the existing prioritisation view explain what evidence is missing, which decision it informs, the current judgement and what the planner should do next. Deliver this first through existing detail/full-record surfaces; the shared panel will reuse the same content. Reuse current read models, scoring and authorised actions.

## Acceptance criteria

- [ ] Show the existing gap statement as **Evidence needed**, objective, affected decision, decision date, band, scores and rationale. Show **Evidence needed by** separately when available and explicit unknowns otherwise. Do not introduce another gap-question field or infer dates. A tactic's evidence question remains separate.
- [ ] Keep the matrix compact. Grouped rows show priority band, evidence deadline or unknown, and next action. Explain **Priority applies across all settings**.
- [ ] Use **Set priority**, **Review and confirm priority**, **Review changed context and reconfirm**, and **Continue to tactics** for the applicable states. Otherwise show **Priority confirmed** with a route to remaining plan-wide work or review/change. The changed-context action becomes active when the context-edit slices introduce that state.
- [ ] Distinguish priority confirmation from human review of evidence coverage and from Open/Partial/Addressed evidence status. Distinguish progress in the selected setting from remaining plan-wide work.
- [ ] Unknown context is visible and nonblocking. Preserve Decision impact × Time pressure defaults, configurable axes, manual overrides, existing High/Open eligibility and initial/retained Tactics access.
- [ ] Keep AI-off/manual operation, keyboard controls, narrow-screen readability and accessible loading/error feedback working. Reads enforce existing permissions and workspace boundaries.
- [ ] Extend existing browser planning scenarios to verify visible context, unknowns, next actions for available states, settings-wide priority and retained human values after refresh. No live paid model calls are needed.

## Blocked by

None (can start immediately).

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent specification and inspect current integrated code before implementation. KAN-124 owns the shared panel; this ticket owns reusable priority content and action wording. The objective-deadline ticket supplies editing and persistence of the new optional deadline. Do not recreate KAN-113/KAN-118 readiness/access work or KAN-123 progress metrics.

#### Implementation sequence for KAN-128

- [ ] Re-fetch KAN-128 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 2: KAN-129 — Require and preserve reasons for manual priority decisions

**Files / ownership starting points:** src/modules/stages/s8-prioritization/module.ts; src/app/api/plan/route.ts; src/components/prioritize/prioritize-matrix.tsx; src/lib/iegp/entity-history.ts; tests/prioritize-matrix.test.ts. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-120](https://synapse21.atlassian.net/browse/KAN-120)

## What to build

Let authorised reviewers assign, change, confirm and reconfirm a priority with a recorded reason, consistently across every existing priority entry point. Readers can inspect who made the decision, when, what changed and why in the existing record history. Extend the current write and history mechanisms rather than introducing another audit store.

## Acceptance criteria

- [ ] Require a meaningful reason for new score/band changes, manual overrides, matrix drags and explicit confirmation/reconfirmation. Validate on the server as well as in the form; a drag cannot silently bypass the reason step.
- [ ] Keep priority rationale distinct from the reason for a later change. Preserve previous band, scores, rationale and confirmation history. Manual judgement requires a reason but no mandatory supporting reference.
- [ ] Save the decision and attributable history together. Include actor, time, previous/new values and reason; consequential system events retain their connection to the initiating decision. Exclude filters, selection, cancellation and unchanged saves from substantive change events.
- [ ] Reconfirmation is an intentional recorded decision even when band and scores are retained. Only users with prioritisation permission may assign or confirm priorities; retain workspace isolation.
- [ ] Reject stale or forbidden writes without silently overwriting a newer judgement. Failed saves preserve entered values/reason and explain how to retry; neither history nor current values may claim a partial success.
- [ ] Existing human-confirmed priorities remain confirmed at launch. Show **Reason not recorded** for older missing reasons; never invent them. Preserve scoring/configurable axes, manual/AI-off operation and human values on reruns.
- [ ] Browser tests exercise a manual change, matrix drag, confirmation and retained history after refresh. Focused route/persistence checks prove reason enforcement, permissions, no-op behaviour, concurrent edits and save/audit failure consistency using existing patterns.

## Blocked by

None (can start immediately).

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent specification before editing. This supplies the reasoned reconfirmation path used by context-change tickets. KAN-124 owns the shared History presentation; current full-record history must make this slice independently usable.

#### Implementation sequence for KAN-129

- [ ] Re-fetch KAN-129 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 3: KAN-130 — Edit objective deadlines and decision context with priority review

**Files / ownership starting points:** src/components/setup/setup-wizard.tsx; src/components/setup/setup-steps.tsx; src/lib/iegp/types.ts; src/lib/iegp/schema.ts; src/lib/iegp/workspace-tables.ts; src/lib/iegp/store.ts; responsible Setup write route; S8 review state. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-120](https://synapse21.atlassian.net/browse/KAN-120)

## What to build

An authorised objective editor can change the affected decision, decision date or a distinct optional **Evidence needed by** date in Setup, see the shared impact, and save a reason. Affected Open gaps then need priority review while retaining their previous judgement. Deliver the complete edit, readback, audit and reconfirmation journey through existing surfaces.

## Acceptance criteria

- [ ] The objective owns the optional evidence deadline shared by linked gaps. Existing evidence deadlines begin unknown; historical decision dates retain their meaning. No generated dates, copying from decision dates or per-gap deadline override.
- [ ] Explain that evidence may be needed before a decision, for example papers due 10 June for a meeting on 30 June. Show both dates distinctly in relevant current details after save/refresh, including shared-panel content if already present.
- [ ] Require a meaningful reason for saved objective field changes. A manual date edit never requires a supporting reference. Record objective-level actor/time/old-new values/reason in existing history rather than relying only on aggregate Setup audit.
- [ ] Preview the impact on linked gaps before save. At save time, the server recomputes affected Open gaps across settings, including those hidden by current filters. Actual changes to decision or either date require their priorities to be reviewed again; preserve band, scores, prior rationale and history. Non-Open/unrelated gaps are unaffected.
- [ ] Name-only changes are audited without invalidating priority confirmation; note/reference-only changes do not trigger review. Unchanged or cancelled edits do not create a substantive change.
- [ ] Context editors may save with their existing permission even without prioritisation permission. Only priority reviewers may reconfirm. Needs-review High gaps cannot start new ideation until reconfirmed High/Open; existing tactics and unlocked navigation remain available.
- [ ] Reject invalid calendar dates. Show **Evidence deadline passed** for past deadlines. Warn if the evidence deadline follows the decision date but allow a valid save with a reason. Do not automatically change priority bands or evidence status.
- [ ] Context, objective audit and consequential gap-review transitions save together or all remain unchanged. Retain the initiating reason and label linked-objective history as shared context in gap readback. Recheck permissions/context and prevent silent overwrites, including concurrent objective/gap reassignment changes; retain entered input on failure.
- [ ] Extend the responsible existing context-save/priority-review mechanism so the gap-context slice can reuse the same consistency rules; do not build a speculative service or separate audit store.
- [ ] Browser tests cover multiple gaps sharing an objective, a filtered-out gap, unknown/valid/unusual dates, manual changes without references and the edit → needs-review → reconfirm journey. Focused server/persistence checks cover invalid dates, permissions, unrelated states, concurrent edits and failure rollback.

## Blocked by

- **02: Require and preserve reasons for manual priority decisions** — supplies audited reconfirmation and protection of the previous judgement.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Follow the agreed objective-date and changed-context review decisions; re-fetch the parent and inspect current integrated code. Reuse current Setup editing, history and priority permissions. KAN-124 consumes the resulting context/history rather than owning these transitions.

#### Implementation sequence for KAN-130

- [ ] Re-fetch KAN-130 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 4: KAN-131 — Audit gap edits and review priorities after meaning changes

**Files / ownership starting points:** src/app/api/iegp/route.ts and existing gap action handlers; src/components/gap-record-sections.tsx; src/components/gap-metadata.tsx; src/app/gaps/[id]/page.tsx; context review persistence from Task 3. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-120](https://synapse21.atlassian.net/browse/KAN-120)

## What to build

Let authorised gap editors update Evidence needed or objective assignment with a reason and a clear effect on priority confirmation. Reuse the context-change consistency behaviour established for objective editing. Cover the remaining direct gap-field edit paths so every new saved edit is attributable.

## Acceptance criteria

- [ ] Actual changes to the existing Evidence needed statement or linked objective require priority review for the affected Open gap. Show the impact before saving and recalculate it server-side. Preserve band, scores, prior rationale and history.
- [ ] Display-name-only changes retain priority confirmation while recording a reason/history. Note/reference-only changes do not trigger review; unchanged/cancelled saves do not create substantive domain-change entries.
- [ ] Require meaningful reasons across covered direct gap-field entry points, enforce existing gap-edit permissions and workspace boundaries, and record actor/time/old-new values/reason. Manual edits do not acquire a blanket reference requirement.
- [ ] Authorised context editors can cause the review transition without prioritisation permission. Only authorised priority users can assign/reconfirm a replacement judgement.
- [ ] New ideation for an affected High gap requires reconfirmed High/Open eligibility. Existing tactics, previous decisions and already-unlocked access remain reachable.
- [ ] Save gap changes, audit and review transitions together or leave all unchanged. Detect stale writes and simultaneous linked-objective changes; retain values/reason on failure with accessible feedback.
- [ ] Current details and existing history show the revised statement/objective, review need and original judgement after refresh. Reuse shared detail/history content if already integrated.
- [ ] Browser tests prove statement and objective changes versus name-only/note-only changes, retained previous judgement and reconfirmation. Focused application-route/persistence checks prove permissions, cross-workspace rejection, concurrency and no partial success.

## Blocked by

- **03: Edit objective deadlines and decision context with priority review** — establishes the responsible context-change/review persistence behaviour reused by gap editing. Ticket 02 is already a transitive prerequisite.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect current integrated gap editing. This ticket owns direct gap-field saves; relationship/link/coverage saves belong to ticket 08. Do not confuse priority confirmation with review of the gap's evidence assessment.

#### Implementation sequence for KAN-131

- [ ] Re-fetch KAN-131 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 5: KAN-132 — Make AI priority suggestions inspectable and safe to accept

**Files / ownership starting points:** src/modules/stages/s8-prioritization/module.ts; src/lib/iegp/entity-history.ts; src/components/prioritize/prioritize-matrix.tsx; src/app/api/plan/route.ts; tests/prioritize-llm.test.ts. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-120](https://synapse21.atlassian.net/browse/KAN-120)

## What to build

An AI priority suggestion includes readable reasoning and inspectable supporting references to supplied records. A reviewer can inspect its basis before acceptance, regenerate an unsupported suggestion, or make an explicit manual judgement with a reason. Extend existing S8 contracts, storage and history/reference handling as one complete behaviour.

## Acceptance criteria

- [ ] Carry references and the reasoning they support from supplied gap/objective/source context through model input/output validation, persisted suggestion details and review UI. Use real supplied record identifiers; do not manufacture support after generation.
- [ ] Validate targets exist, belong to authorised workspace context and are inspectable by the reviewing user. Missing, malformed, inaccessible or unrelated references cannot count as supported judgements. Confidence and administrator-only run traces are insufficient.
- [ ] Keep suggestions advisory. Unsupported output remains explicitly unsupported and cannot be accepted as a supported AI judgement. Offer regeneration or an explicit manual judgement with a reason; manual judgement does not require a supporting reference.
- [ ] Persist applicable inspectable references with the reasoned decision/history through the existing audit mechanism. Extend that mechanism's reference validation/readback so other covered model judgements can reuse it; do not create a second audit store.
- [ ] Show **Supporting references not recorded for this suggestion** on older unsupported suggestions. An unconfirmed older suggestion needs regeneration with valid support or explicit manual judgement before acceptance. Show **Reason not recorded** for older missing reasons without fabricating either.
- [ ] Preserve existing human-confirmed priorities at launch and human-entered scores/bands/rationale on reruns. Generate neither decision dates nor evidence deadlines. Retain AI-off/manual operation and existing eligibility/permissions.
- [ ] Model/save/reference-load failures produce accessible feedback, retain human input and do not partially save a decision or its history. Server-side requests cannot bypass the support checks.
- [ ] Browser tests with deterministic model responses prove inspection, supported acceptance, unsupported/manual alternatives, older records and rerun preservation. Focused S8/route/persistence checks cover invalid/inaccessible targets, incomplete output, workspace isolation and save/audit failure consistency. No paid AI calls.

## Blocked by

- **02: Require and preserve reasons for manual priority decisions** — supplies the audited acceptance/manual-decision path extended with supporting references.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect current S8 contracts. Existing suggestions do not yet carry citation fields; this is a data and behaviour change as well as presentation. KAN-124 reuses the resulting history/reference readback.

#### Implementation sequence for KAN-132

- [ ] Re-fetch KAN-132 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 6: KAN-133 — Open gap details with expandable history without losing workspace context

**Files / ownership starting points:** src/components/ui/sheet.tsx; src/app/api/gaps/[id]/route.ts; src/lib/iegp/gap-record.ts; src/components/gap-record-sections.tsx; src/components/entity-history.tsx; Inventory/Prioritisation/Tactics gap entry points. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

Clicking a gap in relevant Inventory, Prioritisation and Tactics views opens a consistent detail panel over the workspace. Current context and authorised next actions appear first; History is an expandable section, closed by default. Reuse existing full-record content, history and the installed side-panel pattern, establishing the common interaction later used for tactics.

## Acceptance criteria

- [ ] Replace competing selected-gap detail presentations at relevant entry points with a shared panel, full-screen on narrow screens, with **Open full record**. Keep authorised editing routes available and full-record/panel content aligned.
- [ ] Closing returns to the same filters and position and restores keyboard focus to the invoking control. Support keyboard opening, labelled close/expansion controls, focus containment/return and Escape without discarding a dirty edit silently.
- [ ] Show current gap context and next action ahead of a labelled **History** section collapsed by default. History is read-only and newest first; corrections go through authorised editors and append changes.
- [ ] Render recorded event type, affected entity/relationship, actor, time, old/new values, reason and applicable inspectable references. Handle linked-objective events as shared context when supplied; do not present them as statement edits. Reuse the same underlying data as the full record.
- [ ] Use **Reason not recorded** and applicable **Supporting references not recorded for this suggestion** fallbacks for incomplete historical records. Never invent history. Respect existing bounded retrieval and clearly disclose a limit/continuation.
- [ ] Enforce workspace/read permissions for details, history and references on the server. Loading, empty, missing/forbidden and retryable error states do not lose current selection or the underlying workspace.
- [ ] Current priority/context data remains usable through existing records while KAN-120 evolves; render its new fields/events through this common content when available, without duplicating priority calculations or audit stores.
- [ ] Extend browser panel/planning scenarios to cover all relevant gap entry points, expansion, full record, keyboard/focus return, retained filters/position, narrow screens and load-error retry. Focused route tests cover isolation/forbidden history and bounded older records where browser checks are insufficient.

## Blocked by

None (can start immediately using existing full gap records and history).

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect integrated Inventory/readiness work before editing. Extend the current side-panel pattern and full-record/history foundations. KAN-120 owns priority calculations, context edits, support validation and review transitions; consume their readback rather than reimplementing them.

#### Implementation sequence for KAN-133

- [ ] Re-fetch KAN-133 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 7: KAN-134 — Unify tactic details and editing with the shared history panel

**Files / ownership starting points:** src/components/tactic-ideation/tactic-panel.tsx; src/components/tactic-ideation/ideation-board.tsx; src/components/ideation/gap-proposal-group.tsx; src/app/tactics/[id]/page.tsx; common panel from Task 6. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

Extend the existing editable tactic panel to use the common gap/tactic detail interaction, with current information first and expandable History inside. A planner can inspect one tactic and its distinct linked-gap relationships from relevant Tactics, library and linked-record entry points, without losing their place or existing editing capabilities.

## Acceptance criteria

- [ ] Consolidate the existing tactic edit panel into the shared interaction rather than creating a competing panel. Preserve authorised field/lifecycle editors, current reason-required saving and the tactic's separate evidence question.
- [ ] Provide **Open full record**, full-screen presentation on narrow screens, reliable keyboard controls/Escape, safe handling of dirty edits and return of filters, position and focus on close.
- [ ] Keep current tactic details/actions before **History**, collapsed by default. Render field/lifecycle and supplied relationship/coverage/decision events newest first, with actor/time/old-new values/reason and applicable inspectable references. Identify the counterpart gap for relationship events.
- [ ] Reused tactics remain one entity with distinct gap relationships; do not create duplicate tactics/history stores. History is read-only; authorised corrections append new events.
- [ ] Align full-record and panel content, honest missing-reason/reference labels and bounded-history disclosure with the gap panel. Reuse supplied events as other tickets add audit coverage.
- [ ] Preserve read/write permissions and workspace isolation. Retain selection and unsaved input on load/save failure, with accessible feedback and retry where appropriate.
- [ ] Extend existing tactic-panel browser scenarios to exercise linked-tactic/library entry points, history expansion, existing edits, narrow screens, keyboard/focus restoration and failure recovery. Focused route checks prove forbidden or cross-workspace history cannot leak.

## Blocked by

- **06: Open gap details with expandable history without losing workspace context** — establishes the common panel/history interaction to consolidate into the existing tactic panel.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent before editing. Existing editable tactic panels and full tactic history are the starting point. Audit completeness for lifecycle/proposal decisions is ticket 09; link/coverage history is ticket 08. This slice remains usable with current events.

#### Implementation sequence for KAN-134

- [ ] Re-fetch KAN-134 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 8: KAN-135 — Audit gap–tactic links and coverage from both records

**Files / ownership starting points:** existing gap-tactic action handlers in src/app/api/iegp; src/lib/iegp/entity-history.ts; src/components/assign-tactic-with-coverage.tsx; src/components/gap-tactic-actions.tsx; model support from Task 5. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

When a gap–tactic relationship or its coverage judgement changes, record the reason and show the same underlying change from both the gap and tactic. Keep separate assessments for each relationship when a tactic is reused. Extend existing write/history paths without changing the scientific meaning of coverage.

## Acceptance criteria

- [ ] Require meaningful reasons for new saved link/unlink and coverage changes across covered manual and system-assisted entry points. Record actor/time, affected endpoints, previous/new values and reason; consequential changes retain the initiating reason.
- [ ] Show one underlying relationship event in each endpoint's existing history, including shared panels when present. Identify the counterpart gap/tactic. Do not create duplicate tactics, separate decision stores or duplicate audit events for one change.
- [ ] One tactic linked to several gaps retains distinct coverage/history for each relationship. Unlinking or later status/priority changes do not erase prior relationship history.
- [ ] Covered model-generated coverage/relationship judgements require inspectable support, validated through the reference handling established for priority suggestions. Invalid/inaccessible support remains explicit; an authorised manual judgement with a reason remains available. Preserve older records honestly without fabricating support or reasons.
- [ ] Preserve existing coverage calculations, evidence statuses, fit semantics and permissions. A reason alone cannot authorise an otherwise forbidden change; validate workspace ownership and references server-side.
- [ ] Persist relationship/coverage changes and attributable history together or leave both unchanged. Reject stale conflicting writes and retain user input with accessible feedback on failure. No-op/cancelled actions create no substantive events.
- [ ] Browser tests prove reason-required changes and the same event visible from each endpoint, including a tactic reused across two gaps and retained history after unlink. Focused route/persistence checks cover isolation, invalid support, failure rollback and conflicting updates using existing history tests.

## Blocked by

- **05: Make AI priority suggestions inspectable and safe to accept** — supplies reference validation/storage/readback in the existing audit mechanism for reuse by covered model judgements. Current full-record history makes shared panels an optional presentation upgrade rather than a blocker.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect current relationship/history logic. KAN-121 owns fit/coverage product improvements; record and expose existing judgements here without taking over that redesign. Manual date changes retain their reason-only exception.

#### Implementation sequence for KAN-135

- [ ] Re-fetch KAN-135 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 9: KAN-136 — Audit tactic edits, lifecycle and option decisions consistently

**Files / ownership starting points:** existing tactic/lifecycle/option action handlers; src/modules/stages/s9-ideation/module.ts; src/components/tactic-ideation/tactic-panel.tsx; src/components/ideation/proposal-card.tsx; entity history and model support from Task 5. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

Complete reason and history coverage for existing tactic-field edits, lifecycle transitions and proposal/option decisions. A planner can explain an acceptance, rejection or later change from the tactic/gap decision record, including applicable support for model judgements, without changing option-generation or approval workflows.

## Acceptance criteria

- [ ] Reuse existing reason-required tactic editing and extend uncovered field, lifecycle and option acceptance/rejection entry points. Enforce meaningful reasons at the server; record actor/time, previous/new values, event type and reason in existing audit/decision mechanisms.
- [ ] All covered newly persisted model-generated judgements carry inspectable supporting references validated with the existing audit reference mechanism established in ticket 05. An unsupported output cannot masquerade as a supported model decision; preserve an explicit authorised manual judgement path with reason.
- [ ] Surface new events/references in existing full-record history and shared panels when available. Keep accepted, rejected and current option records and distinguish model suggestions from human decisions. Identify relevant gap context without duplicating tactic entities or decision data.
- [ ] Authorised corrections append new changes; history cannot be edited in place. Older missing reasons/support remain explicitly missing rather than fabricated. Manual date edits require a reason without a mandatory reference.
- [ ] Preserve lifecycle meanings, current permissions, AI-off/manual behaviour and existing approval boundaries. Do not introduce fit scoring, new option-generation modes or broaden High/Open AI eligibility.
- [ ] Change and reason/history save together or all remain unchanged. Retain input/selection on failure, detect conflicting updates and preserve workspace/reference access boundaries. Exclude unchanged/cancelled saves from substantive change events.
- [ ] Extend browser tactic/ideation scenarios for edits, lifecycle, accept/reject and persisted history. Focused route/persistence tests prove omitted reasons, invalid/inaccessible model support, forbidden writes, conflicting saves and audit failure consistency. Use deterministic model responses without paid calls.

## Blocked by

- **05: Make AI priority suggestions inspectable and safe to accept** — establishes reusable supporting-reference validation/storage/readback within the existing audit mechanism. Existing tactic/full-record surfaces support independent delivery before panel consolidation.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent before implementation and inspect existing required-reason paths first. Relationship/coverage writes belong to ticket 08. KAN-122 owns reuse/expansion/new-option ideation changes; KAN-84 owns approval/workshop integration. This ticket audits existing decisions without redesigning those behaviours.

#### Implementation sequence for KAN-136

- [ ] Re-fetch KAN-136 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.

### Task 10: KAN-137 — Keep tactic options and planned work discoverable as gaps progress

**Files / ownership starting points:** src/components/tactic-ideation/data.ts; src/components/tactic-ideation/ideation-board.tsx; src/components/ideation/gap-proposal-group.tsx; src/components/plan-cards.tsx; common panels from Tasks 6 and 7. Extend existing relevant tests/browser journeys; create a focused helper/component only when its invariant belongs there.

**Interfaces:** Consume existing responsible loaders/actions and earlier integrated tasks; preserve public contracts unless this ticket explicitly extends them. Report new shared contracts for later tasks.


## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

From a gap, a planner can find accepted, rejected and current tactic options and planned work even after its evidence status or priority changes. Use the common gap/tactic detail navigation and existing records to make the next step clear while preserving current eligibility and previously unlocked access.

## Acceptance criteria

- [ ] A confirmed High/Open gap can progress through accepted proposed tactic → planned tactic → Partially Addressed, with the tactic, rationale, rejected/current alternatives and decision history still discoverable from the gap.
- [ ] Retain routes to prior/planned work when a gap becomes Partially Addressed or Addressed, changes priority or needs priority review. Do not orphan or duplicate tactic/option/decision records when active eligibility changes.
- [ ] Use the shared gap/tactic panel and full-record fallback for record inspection, retaining filters/position/focus. Clearly distinguish current eligible ideation from existing options and planned work.
- [ ] Explain the manual/library route for Medium/Low gaps. New AI ideation remains restricted to confirmed High/Open gaps, including renewed confirmation after changed context when that state is available.
- [ ] Preserve initial readiness/unlocking rules and retained access from integrated KAN-113/KAN-118 work. New unresolved Inventory work does not remove otherwise eligible downstream access. Reuse existing logic; do not recreate it.
- [ ] A tactic reused across gaps remains one tactic with separate relationships. Preserve current coverage meanings, option-generation logic and permissions.
- [ ] Give accessible empty/loading/error/retry states and useful permitted routes if a record is unavailable. Server reads obey workspace boundaries; failed navigation does not lose the underlying workspace.
- [ ] Extend existing browser planning/ideation journeys to prove High → accepted → planned → Partial, changed priorities, Medium/Low manual routes, retained access after new Inventory work, and reuse without duplicate tactics. Use persisted readback and deterministic model fixtures; add focused route checks only where access cannot be proved through the browser.

## Blocked by

- **07: Unify tactic details and editing with the shared history panel** — completes both record-panel targets used by this discovery/navigation journey; ticket 06 is a transitive prerequisite. Existing decision records and eligibility mechanisms are reused rather than waiting for new audit coverage.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect integrated access changes first. This delivers original KAN-124 discoverability scope alongside the approved panel design. Do not take over KAN-121 fit, KAN-122 option-generation, KAN-123 progress metrics, KAN-125 ingestion clearing, or KAN-84 approval/workshops.

#### Implementation sequence for KAN-137

- [ ] Re-fetch KAN-137 and its parent, inspect the owned paths and relevant docs, and record the current invariant before modifying it.
- [ ] Extend the existing test boundary with the acceptance outcomes above; run the focused test and record the expected initial failure.
- [ ] Implement the smallest complete change through the existing responsible layers, retaining permissions, concurrency, error recovery and accessibility.
- [ ] Run focused Vitest/browser verification, `npm run typecheck`, and lint for changed files. Record commands, exit codes and any environmental limitation honestly.
- [ ] Self-review the diff against this brief. Write the requested report with actual verification evidence. Leave git publication and Jira lifecycle updates to the controller.
