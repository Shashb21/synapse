# 03: Edit objective deadlines and decision context with priority review

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
