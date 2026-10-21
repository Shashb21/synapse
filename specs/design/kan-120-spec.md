# KAN-120: Explain and review gap priorities

Specification for [KAN-120](https://synapse21.atlassian.net/browse/KAN-120), synthesised from the confirmed design interview. Product design confirmed on 16 October 2026. Testing approach presented to the owner for feedback; browser journeys and focused server checks are the selected verification plan. No application implementation performed.

## Problem Statement

People can score and confirm gaps but cannot easily see the evidence needed, the affected decision, when usable evidence is required, or the next action. A priority can remain confirmed after its underlying decision context changes. Model suggestions do not currently supply inspectable supporting references. These weaknesses make it difficult to explain or revisit a planning decision reliably.

## Solution

Keep the existing prioritisation method and make its context visible. Show the existing gap statement as Evidence needed, the linked objective's affected decision, a separate optional Evidence needed by date, the decision date, priority rationale and next action. Require reasons for saved changes and supporting references for model-generated judgements. Require another human priority review after relevant context changes, preserving the previous judgement and history. Present this information through the shared detail experience owned by KAN-124.

## User Stories

1. As a planner, I want to read the Evidence needed statement beside a priority, so that I understand what is missing.
2. As a planner, I want the existing statement reused, so that a second generated question does not change the gap's meaning.
3. As a planner, I want to see the affected objective and decision, so that I understand what the evidence will inform.
4. As a planner, I want an Evidence needed by date distinct from the decision date, so that briefing deadlines are represented accurately.
5. As an objective editor, I want one shared evidence deadline for linked gaps, so that their decision context stays consistent.
6. As a planner, I want missing context labelled explicitly, so that absence is not mistaken for an AI inference.
7. As a planner, I want to confirm a priority when context is incomplete, so that optional information does not become a new workflow gate.
8. As a planner, I want to retain configurable scoring axes and manual overrides, so that existing prioritisation practices continue to work.
9. As a planner, I want to know that priority applies across all settings, so that filtering does not imply independent judgements.
10. As a planner, I want a clear next action for unset, draft, changed-context and confirmed priorities, so that I know how to proceed.
11. As a planner, I want local-view progress distinguished from plan-wide work, so that I understand any remaining initial Tactics gate.
12. As an objective editor, I want to see the affected linked gaps before saving context changes, so that I understand their shared impact.
13. As an authorised editor, I want every saved change to require a reason, so that others can understand why it happened.
14. As a manual date editor, I want to save with a reason without supplying a reference, so that an unsupported evidence requirement does not block a human correction.
15. As a planner, I want invalid dates rejected and unusual valid dates explained, so that I can correct errors while retaining justified exceptions.
16. As a planner, I want an elapsed deadline labelled Evidence deadline passed, so that urgency is visible without an automatic priority change.
17. As a priority reviewer, I want changed decisions or dates to require another review of affected Open gaps, so that confirmation does not appear to endorse outdated context.
18. As a gap editor, I want statement or objective-assignment changes to require priority review, so that the judgement is reconsidered for the revised gap.
19. As a gap editor, I want display-name-only changes to retain confirmation, so that wording clean-up does not create unnecessary reviews.
20. As a priority reviewer, I want previous scores, band and rationale preserved, so that I can compare the old judgement with the new context.
21. As an authorised context editor without prioritisation permission, I want to correct context without assigning a new priority, so that permissions match my responsibility.
22. As an authorised priority reviewer, I want reconfirmation to record my new reason, so that the latest decision and previous rationale remain traceable.
23. As a planner, I want new ideation to respect renewed priority review while retaining access to existing tactics, so that an outdated confirmation does not create new suggestions or hide prior work.
24. As a planner, I want model suggestions to include reasoning and inspectable references, so that I can check the basis of a judgement.
25. As a planner, I want unsupported suggestions identified explicitly and a manual judgement path available, so that weak model support does not force a decision.
26. As a planner, I want my scores and bands preserved on model reruns, so that automation does not overwrite my work.
27. As an existing user, I want already-confirmed priorities preserved at launch, so that introducing this feature does not invalidate all previous reviews.
28. As a reviewer of an older unconfirmed model suggestion, I want to regenerate it with support or make an explicit manual judgement, so that missing historical references are not silently accepted.
29. As a reader of history, I want missing past reasons or references identified honestly, so that the app never invents a decision record.
30. As an editor, I want failed saves to retain my input and leave context, confirmation and history consistent, so that I can retry safely.
31. As a planner working with colleagues, I want stale edits detected, so that a concurrent change cannot silently overwrite a newer judgement.
32. As a keyboard or small-screen user, I want context, references and actions accessible, so that I can make the same decisions as other users.

## Implementation Decisions

- Preserve the current prioritisation engine, Decision impact × Time pressure defaults, configurable axes, manual placement, overrides and human confirmation. One priority belongs to each gap across settings.
- Evidence needed is the gap's existing statement. A tactic's evidence question remains distinct; do not add a second gap-question field.
- Extend the existing objective model with an optional evidence deadline alongside the existing affected decision and decision date. Existing deadlines begin unknown; retain the meaning of historical decision dates. No inferred or generated dates and no per-gap deadline overrides.
- Reuse responsible editors and existing permission boundaries: objective/decision/date context in Setup, gap statement/objective assignment in the gap editor, and priority judgement in Prioritisation. Objective/gap editing and assigning/confirming a priority remain separate permissions.
- Show evidence needed, objective/decision/both dates, band/scores/rationale/confirmation and next action in the shared record details. Keep the matrix compact; grouped rows show band, evidence deadline and next action. Explain Priority applies across all settings; missing context remains secondary and nonblocking. Use Priority confirmed for acceptance of a priority judgement, keeping it distinct from human review of the gap's evidence assessment and from its evidence status.
- Next actions are Set priority; Review and confirm priority; Review changed context and reconfirm; Continue to tactics for a confirmed High gap with access; or Priority confirmed with a route to remaining plan-wide work or review/change. Preserve initial global Tactics unlocking and retained access after unlocking.
- Every new saved domain change covered by this feature requires a meaningful reason and attributable audit entry, including score/band changes, matrix drags and reconfirmation. Audit entries retain actor, time, old/new values and applicable references. Consequential system transitions link to the initiating reason. Filters, selections, cancelled edits and no-op saves do not create substantive domain-change entries.
- Manual date edits require a reason without a supporting-reference requirement. Supporting references are mandatory for model-generated judgements, not for every manual edit.
- Actual changes to affected decision, evidence deadline, decision date, linked objective or Evidence needed statement require affected Open gaps to have priority reviewed again. Compute affected gaps on the server across all setting views and show shared impact before saving. Preserve band, scores and previous rationale/history. Display-name-only edits retain confirmation while recording reason/history; reference/note-only changes do not trigger review.
- Authorised context editors may cause this transition even without prioritisation permission. Only authorised priority reviewers may assign or confirm the replacement judgement. New ideation requires reconfirmed High/Open eligibility; existing tactics and unlocked navigation remain accessible.
- Persist context changes, reasons/history and consequential review transitions consistently together, or leave all unchanged on failure. Recheck relevant context and permissions at save time; concurrent edits cannot silently overwrite a newer decision or leave the wrong linked gaps confirmed. Failed saves retain user input and give an accessible error.
- Reject invalid calendar dates. Label past evidence deadlines Evidence deadline passed. Warn if the evidence deadline follows the decision date but allow a valid-date save with a reason. Neither warning changes band or evidence status automatically.
- Extend the existing S8 input/output, storage and readable suggestion details with references to supplied gap, objective or source records and the reasoning they support. Reference targets must exist, belong to authorised workspace context and be inspectable by the reviewing user. Confidence and admin-only run traces do not satisfy this requirement. No second audit store.
- Insufficient or invalid support remains explicit and cannot be accepted as a supported model judgement. Manual judgement with a reason remains available. Preserve human-set values on reruns.
- Preserve existing human-confirmed priorities at launch. Older model suggestions without references show Supporting references not recorded for this suggestion. Accepting an unconfirmed older suggestion requires regeneration with support or an explicit manual judgement with reason. Missing historical reasons show Reason not recorded. Never fabricate past references or reasons.
- KAN-124 owns shared panel/history/navigation presentation. KAN-120 supplies priority context, reasons, references and review transitions for that interface. Each can use existing full record/history surfaces while the common presentation is introduced.

## Testing Decisions

- Primary testing boundary: the existing browser-driven planning journey, exercising real authorised application actions and persisted readback. Prefer visible outcomes over internal helper calls or snapshotting implementation structure.
- Extend existing S8 prioritisation, manual/gated planning and tactic-panel browser scenarios using isolated workspaces and the suite's separate database. Deterministic model responses avoid paid AI calls.
- Add focused checks through existing application routes/stage interfaces for denied permissions, cross-workspace access, invalid or inaccessible references, incomplete model responses, invalid dates and older records. Follow the existing gap-record API and S8 contract test patterns.
- Use the existing persistence/history integration pattern for failure and concurrency cases that cannot reliably be proved in a browser: context, audit and confirmation must change together or remain unchanged. Add only the smallest test hook needed to induce failure; do not introduce a new production service solely for tests.
- Cover several gaps sharing an objective, including one hidden by the current setting filter; affected versus unaffected gap states; statement/objective/title-only edits; retained rationale and audited reconfirmation; changed-context High eligibility; and retained existing tactics/navigation.
- Cover unset/draft/confirmed/review-needed next actions, unknown context, AI-off/manual workflows, settings-wide priority, supported/unsupported suggestions, human-value preservation and launch compatibility.
- Verify keyboard opening/closing, reference inspection, focus restoration, narrow-screen readability, warning/error announcements and input retention through the KAN-124 shared presentation.
- This is a verification plan, not evidence of passing application tests. The approach was presented to the owner for feedback; no testing response has been recorded, so it remains an explicit implementation assumption.

## Out of Scope

- Replacing scoring, building a new prioritisation engine, automatically assigning priorities from dates, or broadening AI ideation beyond confirmed High/Open gaps.
- Generating dates, adding a second gap question, requiring references for manual date edits, or inventing historical reasons/references.
- Redesigning tactic fit assessment, ideation option generation or progress metrics already owned by KAN-121, KAN-122 and KAN-123.
- Recreating Inventory/readiness/access work owned by KAN-113/KAN-118, fixing the separate ingestion-clearing defect KAN-125, or redesigning workshops/approval systems owned by KAN-84.
- Implementing application code or marking Jira issues Done during specification and ticket preparation.

## Further Notes

- Repository: https://github.com/Shashb21/synapse. Review baseline: kan-110-111-ingestion, commit 18b0f823e27343fe3d8d18221a1dcea450de802e, intended for later merge into main. Re-fetch the issue and inspect the current integrated code before implementation.
- This specification follows the project glossary and the agreed decisions to keep evidence deadlines separate from decision dates and to review priorities after material context changes.
- Companion specification: [KAN-124](https://synapse21.atlassian.net/browse/KAN-124). Existing S8 suggestions lack reference fields; objective edits lack detailed per-objective history. These are deliberate data/behaviour additions, not UI-only changes.
- Owner/assignee: Calix Tan. Keep the issue open during design work. When published, preserve existing labels and add ready-for-agent.
