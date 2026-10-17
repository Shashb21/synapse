# 01: Show evidence needed, decision context and priority next actions

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
