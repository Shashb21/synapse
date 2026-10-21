# 04: Audit gap edits and review priorities after meaning changes

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
