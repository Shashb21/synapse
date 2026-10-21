# 03: Preview and link a library tactic with or without assessment

## Parent

https://synapse21.atlassian.net/browse/KAN-121

Specification: https://synapse21.atlassian.net/browse/KAN-140

## What to build

Preview the tactic’s fit in the library chooser, then deliberately link it as unassessed or assess and link it using the existing human review workflow.

## Acceptance criteria

- [ ] Expose the relationship fit preview without persisting a relationship or assessment. Closing or cancelling the preview creates nothing.
- [ ] Provide Link as unassessed even when requirements are unresolved, and label the saved relationship accordingly.
- [ ] Provide Assess and link using the existing assessment action, human verdict/rationale and requirement-basis rules; reuse the tactic record.
- [ ] An unsuccessful assessed link leaves no partial confirmed relationship; retain entered assessment values and show a recoverable error.
- [ ] Repeated save or retry cannot create duplicate relationships, tactic records or assessment decisions.
- [ ] Enforce existing permissions and audit at the server boundary; viewers cannot mutate relationships.
- [ ] Support keyboard opening, navigation, cancellation and completion, with clear focus handling and accessible validation/error feedback.
- [ ] Verify persisted outcomes and rejection paths through public actions; run a focused Playwright flow for cancellation, both link actions and retained input after failure.

## Blocked by

- https://synapse21.atlassian.net/browse/KAN-141
- https://synapse21.atlassian.net/browse/KAN-142
