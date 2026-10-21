# KAN-124: Shared gap and tactic details with expandable history

Specification for [KAN-124](https://synapse21.atlassian.net/browse/KAN-124), synthesised from the confirmed design interview. Product design confirmed on 16 October 2026. Testing approach presented to the owner for feedback; browser journeys and focused server checks are the selected verification plan. No application implementation performed.

## Problem Statement

People lose planning context when opening gap or tactic details, and previous tactic decisions become hard to find when a gap leaves Open. History exists but is always expanded and does not yet cover all agreed reasons, references and linked context changes. Users need a consistent way to inspect the current record, its next action and the explanation of how it reached that state.

## Solution

Open gaps and tactics in a shared side panel over the current workspace, full-screen on narrow screens, with an Open full record route. Keep History collapsed by default inside the panel and let users expand it to inspect saved changes, reasons and supporting references. Preserve prior and planned work across priority and evidence-status changes, using existing records and authorised editors.

## User Stories

1. As a planner, I want clicking a gap to open its details over my workspace, so that I can inspect it without losing my planning context.
2. As a planner, I want the same interaction for a tactic, so that record navigation is predictable.
3. As a small-screen user, I want the panel to use the full screen, so that details and actions remain readable.
4. As a planner, I want an Open full record route, so that I can continue deeper work on the complete record.
5. As a planner, I want closing details to restore filters, position and focus, so that I can resume where I was working.
6. As a keyboard user, I want labelled controls and reliable open, close and History expansion, so that I can inspect the same information without a pointer.
7. As a planner, I want current context and next action before History, so that the main task stays clear.
8. As a planner, I want History collapsed by default, so that detailed change records do not overwhelm the current record.
9. As a reviewer, I want changes shown newest first with actor, time, old/new values and reason, so that I can understand the latest decision.
10. As a reviewer, I want model-generated judgements to expose applicable supporting references, so that I can inspect their basis.
11. As a reader of older history, I want missing reasons and references labelled honestly, so that absent information is never invented.
12. As a gap reviewer, I want statement, objective assignment and priority decisions in history, so that I understand changes to the gap's meaning and importance.
13. As a gap reviewer, I want linked objective changes clearly identified as shared context, so that they are not mistaken for direct edits to the gap.
14. As a tactic reviewer, I want field and lifecycle changes in history, so that I understand the tactic's development.
15. As a planner, I want tactic-link and coverage changes visible from both records, so that I can explain their relationship from either direction.
16. As a planner reusing a tactic, I want history to identify the counterpart gap, so that separate relationship decisions remain understandable.
17. As a planner, I want one underlying relationship event reused across views, so that history does not become duplicated or inconsistent.
18. As an editor, I want every new saved change in covered flows to require a reason, so that future readers can understand my decision.
19. As a manual date editor, I want my reason recorded without requiring a reference, so that manual corrections remain practical.
20. As an authorised editor, I want corrections to create new history through the proper editor, so that past records cannot be silently rewritten.
21. As a planner, I want accepted, rejected and current tactic options discoverable from the gap, so that I can see which alternatives were considered.
22. As a planner, I want planned work and prior decisions reachable after a gap becomes Partial or Addressed, so that progress does not hide its explanation.
23. As a planner, I want a priority change to retain prior tactic decisions, so that those records are not orphaned.
24. As a planner with a Medium or Low gap, I want a clear manual/library route, so that I can plan work while preserving High-only AI eligibility.
25. As a planner, I want existing eligible downstream work to stay accessible when new inventory work appears, so that the app preserves previous access correctly.
26. As a workspace member, I want history and references to obey my access permissions, so that records from other workspaces are not exposed.
27. As a planner, I want clear loading, empty and error states with retry, so that a failed detail load does not lose my selection or workspace.
28. As a reviewer of a long-lived record, I want a bounded, understandable history view, so that large histories remain usable without silently pretending to be complete.

## Implementation Decisions

- KAN-124 owns the common panel, History presentation, navigation and downstream discovery. KAN-120 owns priority context, audited priority reasons/references and review transitions consumed by this interface. Preserve both original issue scopes.
- Use a shared side-panel interaction at relevant Inventory, Prioritisation and Tactics entry points. Show full-screen on narrow screens. Preserve a full-record route and restore underlying filters, position and keyboard focus when closing.
- Extend or consolidate the existing tactic edit panel, full gap/tactic detail content and shared History machinery. Keep authorised editing actions available through their responsible editors. Do not create duplicate selected-gap detail implementations, tactic entities, decision records or parallel audit stores.
- History is a labelled expandable section inside the panel, collapsed by default; it is not a second floating window. Keep current details and next action ahead of expanded history.
- History is read-only and newest first, with event type, affected record/relationship, actor (person/model/system), time, previous/new values where recorded, reason and applicable inspectable references. Corrections use authorised editors and append new changes.
- Gap history includes statement, objective assignment, priority/confirmation, tactic links and coverage. Linked changes affecting the record, such as an objective deadline causing priority review, are labelled as shared context rather than edits to the gap's statement.
- Tactic history includes fields, lifecycle, linked gaps and relevant coverage/decision events. Identify the counterpart gap for relationship events. Display one underlying relationship event from both endpoints; preserve distinct assessments for each gap–tactic relationship.
- All new saved domain changes in covered flows require a reason and audit record, including remaining gap/tactic field, lifecycle, proposal-decision, link and coverage paths. Consequential system changes link to the initiating reason. Manual date edits require no supporting reference; model-generated judgements require inspectable supporting references. Reuse any existing validation and extend uncovered entry points consistently. No-op/cancelled edits do not create substantive changes.
- Required changes and their audit entries persist consistently together; failures do not claim a successful change without its reason/history. Preserve entered input and current selection on save/load failure, and enforce existing permissions and workspace boundaries on server-side read/write paths.
- Show Reason not recorded for older missing reasons and Supporting references not recorded for this suggestion where applicable. Do not fabricate past reasons, references or old/new values.
- Retain discovery of accepted, rejected and current tactic options from a gap. Keep prior/planned work reachable after a gap leaves Open or changes priority. A tactic reused across gaps remains one tactic with separate relationships.
- Explain the manual/library route for Medium/Low priorities and preserve confirmed High/Open AI ideation. Preserve initial readiness/access rules and previously unlocked access, including when new unresolved Inventory work appears. Do not change evidence coverage semantics.
- Loading, empty and error states explain availability and offer retry without losing the selected record or underlying workspace. Bound history retrieval and make a limit or continuation clear. Existing history already limits retrieval; do not replace it with unbounded loading.
- The shared presentation must support keyboard navigation, focus containment/return, Escape, accessible expansion labels, readable old/new values and narrow-screen operation. Keep full-record and panel content aligned.

## Testing Decisions

- Primary testing boundary: existing browser-driven planning journeys with real authorised actions and persisted readback. Good tests prove what the user can do and see, rather than mirroring component structure or asserting private implementation choices.
- Extend existing tactic-side-panel, S8 prioritisation, tactic-ideation and manual/gated-planning scenarios using isolated workspaces and the suite's separate database. Reuse current session, record creation and stage helpers. Model responses stay deterministic; no paid AI runs are required.
- Prove opening gap/tactic details from relevant entry points; full-record fallback; closed-by-default History; expansion, keyboard focus/Escape and return; filters/position preserved; narrow-screen operation; and load errors with retry.
- Exercise confirmed High → accepted proposed tactic → planned tactic → Partial gap, preserving tactic, rationale, rejected/current alternatives and history throughout. Cover priority changes, Medium/Low manual routes and new unresolved Inventory.
- Through existing route/persistence/history boundaries, verify actor/time/reason/old-new values, required reasons across covered entry points, one relationship event visible at both endpoints, separate assessments for a reused tactic, and linked shared-objective history supplied by KAN-120.
- Use focused application-route tests for forbidden actions, cross-workspace history/reference access, missing records and invalid requests. Reuse attributable-edit, gap-record API and workspace-isolation test patterns. Use persistence integration checks for change/audit failure consistency; browser tests cover user-visible recovery.
- Cover incomplete older history, inspectable model references, explicit missing-reference labels, empty/error/loading states and bounded long histories.
- This is a verification plan, not evidence of passing application tests. The approach was presented to the owner for feedback; no testing response has been recorded, so it remains an explicit implementation assumption.

## Out of Scope

- A new browser popup workflow, a second nested floating window, editable historical events, fabricated history or a parallel audit system.
- Broadening AI ideation eligibility, changing evidence coverage rules or duplicating tactics for each linked gap.
- Rebuilding fit assessment, reuse/expansion/new-option generation or progress metrics owned by KAN-121, KAN-122 and KAN-123. Display their existing records where relevant without taking over their work.
- Recreating Inventory/readiness/access improvements owned by KAN-113/KAN-118, fixing the separate KAN-125 ingestion defect, or redesigning workshop/approval systems owned by KAN-84.
- Application implementation, commits, deployment or marking these issues Done during specification and ticket preparation.

## Further Notes

- Repository: https://github.com/Shashb21/synapse. Review baseline: kan-110-111-ingestion, commit 18b0f823e27343fe3d8d18221a1dcea450de802e, intended for later merge into main. Re-fetch this issue and inspect current integrated code before implementation.
- Companion specification: [KAN-120](https://synapse21.atlassian.net/browse/KAN-120). Follow the project glossary and agreed objective-date/priority-review decisions.
- KAN-113's Inventory work exists on kan-113-evidence-inventory with PR 107; inspect the integrated code rather than recreating it. KAN-118 owns preserved downstream access; KAN-76 provides existing tactic expansion behaviour.
- Existing full record pages, an editable tactic side panel, the Sheet interaction component and shared edit/audit history provide the implementation starting point. Extend these responsible layers before adding new abstractions.
- Owner/assignee: Calix Tan. Keep the issue open during design work. When published, preserve existing labels and add ready-for-agent.
