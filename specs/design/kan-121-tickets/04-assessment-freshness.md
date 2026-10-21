# 04: Require reassessment after substantive requirement or tactic changes

## Parent

https://synapse21.atlassian.net/browse/KAN-121

Specification: https://synapse21.atlassian.net/browse/KAN-140

## What to build

When a supporting requirement or tactic design changes, preserve the previous judgement while clearly requiring renewed review and recalculating current coverage safely.

## Acceptance criteria

- [ ] Compare the requirement/design basis used by the assessment with substantive accepted edits; mark only affected relationship assessments outdated with a specific reason.
- [ ] Cosmetic or title-only changes do not invalidate assessments. Preserve previous verdicts, human confirmation history and audit records.
- [ ] Keep sibling-assessment warnings separate from changes to the relationship’s own basis. Acknowledging a warning cannot re-confirm an outdated assessment or upgrade coverage.
- [ ] Exclude outdated Full assessments from current Full contribution to Addressed through the existing engine. Other current eligible assessments may still support Addressed; preserve existing tactic lifecycle eligibility.
- [ ] For approved inventories, use the existing revision/reapproval process and retain the approved snapshot.
- [ ] Expose outdated state and reason in the existing relationship assessment view and allow explicit human reassessment using the current basis.
- [ ] Enforce authorisation and version-conflict checks; stale edits cannot silently overwrite newer review. Repeated handling must not duplicate historical invalidation events.
- [ ] Verify substantive versus cosmetic changes, shared-tactic impact, sibling warnings, reassessment, current status with another Full contribution and approved snapshot preservation through public workflows; add focused engine tests only where necessary.

## Blocked by

- https://synapse21.atlassian.net/browse/KAN-141
