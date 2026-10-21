# 02: Require and preserve reasons for manual priority decisions

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
