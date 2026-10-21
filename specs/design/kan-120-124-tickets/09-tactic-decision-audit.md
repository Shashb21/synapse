# 09: Audit tactic edits, lifecycle and option decisions consistently

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
