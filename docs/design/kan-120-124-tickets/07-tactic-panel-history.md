# 07: Unify tactic details and editing with the shared history panel

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
