# 08: Audit gap–tactic links and coverage from both records

## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

When a gap–tactic relationship or its coverage judgement changes, record the reason and show the same underlying change from both the gap and tactic. Keep separate assessments for each relationship when a tactic is reused. Extend existing write/history paths without changing the scientific meaning of coverage.

## Acceptance criteria

- [ ] Require meaningful reasons for new saved link/unlink and coverage changes across covered manual and system-assisted entry points. Record actor/time, affected endpoints, previous/new values and reason; consequential changes retain the initiating reason.
- [ ] Show one underlying relationship event in each endpoint's existing history, including shared panels when present. Identify the counterpart gap/tactic. Do not create duplicate tactics, separate decision stores or duplicate audit events for one change.
- [ ] One tactic linked to several gaps retains distinct coverage/history for each relationship. Unlinking or later status/priority changes do not erase prior relationship history.
- [ ] Covered model-generated coverage/relationship judgements require inspectable support, validated through the reference handling established for priority suggestions. Invalid/inaccessible support remains explicit; an authorised manual judgement with a reason remains available. Preserve older records honestly without fabricating support or reasons.
- [ ] Preserve existing coverage calculations, evidence statuses, fit semantics and permissions. A reason alone cannot authorise an otherwise forbidden change; validate workspace ownership and references server-side.
- [ ] Persist relationship/coverage changes and attributable history together or leave both unchanged. Reject stale conflicting writes and retain user input with accessible feedback on failure. No-op/cancelled actions create no substantive events.
- [ ] Browser tests prove reason-required changes and the same event visible from each endpoint, including a tactic reused across two gaps and retained history after unlink. Focused route/persistence checks cover isolation, invalid support, failure rollback and conflicting updates using existing history tests.

## Blocked by

- **05: Make AI priority suggestions inspectable and safe to accept** — supplies reference validation/storage/readback in the existing audit mechanism for reuse by covered model judgements. Current full-record history makes shared panels an optional presentation upgrade rather than a blocker.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect current relationship/history logic. KAN-121 owns fit/coverage product improvements; record and expose existing judgements here without taking over that redesign. Manual date changes retain their reason-only exception.
