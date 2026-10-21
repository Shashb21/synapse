# KAN-120 prioritisation review

Design interview for [KAN-120](https://synapse21.atlassian.net/browse/KAN-120). The owner confirmed the consolidated design on 16 October 2026. No application implementation or runtime verification performed.

## Confirmed decisions

1. Keep the existing prioritisation method. The page should help a user explain why one gap deserves attention before another and identify the next action, without leaving the page. Tactic selection stays in the later workflow.
2. “Evidence needed by” means the latest date usable evidence must be available to inform the decision. It is distinct from the meeting/decision date and from tactic scheduling. Example: papers due 10 June for a committee meeting on 30 June imply an evidence deadline of 10 June.
3. Missing decision context does not introduce a new block on priority confirmation. Show explicit unknown/missing values, preserve existing confirmation rules, and do not silently invent context through AI. Priority confirmation does not imply complete context.
4. Show the existing gap statement as “Evidence needed”. Do not add or generate a separate gap question; a tactic's evidence question remains a distinct concept.
5. The objective owns a separate optional “Evidence needed by” date, shared by its linked gaps, alongside its existing decision date. Display this context on each linked gap in Prioritisation. Existing objectives start with an unknown evidence deadline; do not copy the decision date automatically. See [the date-ownership decision](../adr/0001-objective-evidence-deadline.md).
6. Retain one shared priority per gap across settings and explain “Priority applies across all settings”. Distinguish progress in the current setting view from progress across the whole plan. Preserve the existing initial Tactics gate, retained later-stage access and confirmed High/Open ideation rule.
7. Keep context editable through its responsible editors: objective/decision/dates in Setup, gap statement and objective assignment in the gap editor, and priority judgement in Prioritisation. Every saved change must be auditable with a reason for change. The later clarification below supersedes the initially proposed requirement for evidence on every manual edit.
8. Keep the matrix compact. Selected-gap details show Evidence needed, decision context (including objective and both dates), priority judgement (band/scores/rationale/confirmation), then next action. Grouped rows show band, evidence deadline and next action, with expansion to the same explanation. Preserve keyboard and narrow-screen access.
9. Label elapsed deadlines “Evidence deadline passed”. Warn when evidence is due after the decision date, but allow saving the valid date with the warning. Neither warning silently changes the priority band or evidence status. Reject invalid calendar dates. Saved edits require a reason and audit history.
10. Manual date changes require a reason, not a supporting reference. Supporting references are required for LLM-generated judgements. The owner explicitly rejected a mandatory supporting reference for manual date changes. Record who changed what, when, old/new values and the reason; apply this consistently across editing entry points.
11. Actual changes to the affected decision, evidence deadline, decision date or a gap's linked objective require priority review again for affected Open gaps. Show the impact before saving; preserve prior bands, scores, rationale and history. A previously confirmed High gap needs priority reconfirmation before new ideation. Keep existing tactics and previously unlocked navigation. Changing only a reference or explanatory note does not trigger this review.
12. LLM-generated priorities remain suggestions with reasoning and inspectable references to the supplied gap, objective or source records that support the reasoning. Model confidence is not evidence. Insufficient support is stated explicitly and leaves the judgement to a person. Human confirmation remains required; KAN-120 does not introduce automatic generation of decision dates or evidence deadlines.
13. A person authorised to edit an objective may correct its context and thereby cause affected priorities to need review, with the impact explained before saving. Only a person with prioritisation permission may assign or confirm the replacement priority.
14. A saved change to the Evidence needed statement also requires priority review again for the affected Open gap, retaining the previous judgement and rationale. Display-name-only edits retain confirmation. Both require reason and audit history.
15. Show an explicit primary next action for each priority state: Set priority (unset), Review and confirm priority (draft), Review changed context and reconfirm (context changed), Continue to tactics (confirmed High with access), or Priority confirmed with the appropriate route to remaining plan-wide work or review/change. Show missing-context prompts separately; they do not become new confirmation gates. Unsupported AI suggestions leave the manual judgement path available.
16. Preserve existing human-confirmed priorities when introducing the feature. Mark older AI suggestions without references as “Supporting references not recorded for this suggestion”; do not fabricate citations or historical reasons. Before accepting an unconfirmed older AI suggestion, regenerate it with support or make an explicit manual judgement with a reason. Existing evidence deadlines start unknown; subsequent context changes follow the new review rules.
17. Clicking a gap or tactic opens a shared side panel over the current workspace, full-screen on narrow screens. It contains a History section collapsed by default and an Open full record route. Closing it restores the previous workspace context and focus. This replaces a separate selected-gap detail presentation rather than introducing duplicate detail implementations.
18. History is newest first and explains what changed (old/new values where available), who/what changed it, when, why and supporting references when required or voluntarily supplied. Gap history includes statement, objective assignment, priority/confirmation, tactic links and coverage; tactic history includes fields, lifecycle and gap relationships. Include linked changes that affect the record, such as an objective deadline causing priority review. Show the same relationship event from both affected records, using shared history records. Mark missing historical reasons explicitly.
19. [KAN-124](https://synapse21.atlassian.net/browse/KAN-124) owns the shared gap/tactic detail panel and expandable History across Inventory, Prioritisation and Tactics. KAN-120 owns priority context, reasons, supporting references and review transitions exposed through that interface. Preserve KAN-124's existing downstream-discoverability scope. See [shared detail/history design](kan-124-record-details-history.md).

## Source findings

Read-only inspection of `kan-110-111-ingestion` found:

- Gaps have a statement describing missing evidence; tactics have a separate evidence-question field (`src/lib/iegp/types.ts`).
- Objectives own `key_decision` and `decision_date`; gaps reference an objective (`src/lib/iegp/schema.ts`). The objective editor is in Setup (`src/components/setup/setup-steps.tsx`). No separate evidence-needed-by field was found.
- Priority is one shared judgement per gap. Setting selection filters the view; it does not create a separate band. Gap confirmation, priority confirmation and evidence coverage are separate concepts.
- The current flow initially unlocks Tactics after all live Open gaps have confirmed priorities; ideation serves human-confirmed High/Open gaps. Later-stage access is retained once unlocked.
- Follow-up inspection found that objective decision/date edits, gap statement edits and objective reassignment currently leave priority confirmation unchanged. Objective edits have only an aggregate Setup audit entry; gap edits have more detailed history. Withdrawing confirmation when context changes would therefore be a deliberate behavior change, not existing behavior.
- Objective/gap editing uses the `validate` permission; assigning or confirming priorities uses `prioritize`. Any consequence of a context edit must respect that distinction.
- S8 does not currently attach citations to suggestions. Its input/output and placement storage need explicit supporting references and a readable in-product view; existing run IDs and dossier links alone do not meet the agreed reference requirement. An unconfirmed automatic placement can currently change on rerun; human-set values are preserved.
- Reconfirmation can reuse the existing retained band/scores and confirmation controls. Keep previous rationale in accessible history when a new confirmation reason becomes the current rationale; do not silently discard it.
- Both gap and tactic full record pages already use a shared `EntityHistory` component and an existing edit/audit loader. Extend those foundations for the KAN-124 panel and linked history rather than building another audit store. The current history entry type has no structured supporting-reference field; see the [shared detail/history source findings](kan-124-record-details-history.md#existing-foundations).

The interview resolved the timing distinction by choosing a separate optional objective-level evidence deadline. This is a small data-model addition to the original clarity ticket; the existing decision date retains its meaning.

## Final review

All product choices raised in the interview have been answered. The owner confirmed the consolidated design, and the full specifications are now published to KAN-120 and KAN-124, verified by readback, with ready-for-agent labels and the existing owner/status retained. Local specification copies are [KAN-120](kan-120-spec.md) and [KAN-124](kan-124-spec.md). The [ten-ticket proposal](kan-120-124-tickets/README.md) has complete draft bodies and blocking edges awaiting owner approval before child-ticket publication. No application implementation is authorised by this design interview alone.

## Implementation invariants implied by confirmed decisions

- Persist a context change, its reason/history and affected priority-review transitions together, or leave all of them unchanged on failure. Do not save new context while silently keeping affected priorities confirmed because an audit/reset failed.
- Compute affected linked gaps on the server, including gaps hidden by the current setting filter. Enforce existing workspace and permission boundaries.
- All saved changes in this feature need a reason and audit trail, including priority score/band edits, matrix drag changes, reconfirmation and automatic review transitions. A user-entered reason explains a human edit; a linked system reason explains a consequential review transition. View filters, selection and cancelled/no-op edits are not saved domain changes.
- Do not infer dates, manufacture missing historical reasons or references, or treat an inaccessible identifier as an inspectable supporting reference. Save errors preserve input and explain the failure accessibly.

## Verification plan

Implementation must prove:

- A user can explain a gap's priority and next action from Prioritisation alone, including AI-off/manual operation, unknown context and a gap with no linked objective.
- Existing objective decision dates keep their meaning; evidence deadlines are optional and initially unknown. Distinct dates, invalid dates, past deadlines and evidence-after-decision warnings behave as agreed.
- All linked gaps show one shared objective deadline; changing it requires review for affected Open priorities, including those hidden by a setting filter. Statement/objective reassignment changes affect the appropriate gap; title-only edits do not withdraw confirmation.
- Context edits preserve band/scores and historical rationale; reconfirmation records a new reason. New ideation respects renewed confirmation while existing tactics/navigation remain accessible.
- Date edits require a reason without requiring a reference. All relevant saved changes and automatic review transitions have history. No-op/cancelled edits do not masquerade as substantive changes.
- LLM suggestions have inspectable, valid supporting references and reasoning; missing or invalid support never becomes an accepted AI judgement. Human-set values survive reruns. Older records follow the agreed compatibility behavior without invented history.
- Context editing and priority-setting permissions remain distinct; forbidden operations and cross-workspace requests fail without partial writes or leaked history.
- Inject a failure during audit/review persistence: the context, priority confirmations and history stay consistent, with entered input preserved and an accessible error. Concurrent edits cannot silently overwrite a newer saved judgement or leave the wrong linked gaps confirmed.
- Keyboard users can open/close the detail panel, expand History, inspect evidence and return to the original trigger; narrow layouts preserve these actions and readable old/new values.

Use the repository's existing focused behavior tests and browser checks during implementation, recording actual commands/results then. This design-only review has not run application tests.
