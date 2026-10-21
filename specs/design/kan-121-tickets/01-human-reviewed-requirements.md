# 01: Confirm relationship coverage against a human-reviewed requirement basis

## Parent

https://synapse21.atlassian.net/browse/KAN-121

Specification: https://synapse21.atlassian.net/browse/KAN-140

## What to build

In the existing gap assessment flow, review a sourced requirement basis and save a supported human coverage judgement, while allowing provisional assessments and unassessed links.

## Acceptance criteria

- [ ] Show a persisted gap requirement basis from linked EvidenceNeed records and gap context, including source provenance and unresolved disagreements.
- [ ] Distinguish Required, explicitly justified Not applicable and Not yet determined. Omission never implies non-applicability.
- [ ] Only an authorised human coverage reviewer can confirm the basis and coverage. AI/extraction may propose sourced values. Review the basis within the existing flow without separate per-field approval.
- [ ] An explicit overall verdict and rationale confirm overall coverage; dimension confirmations remain separate. Warning acknowledgement never creates or upgrades coverage.
- [ ] Reject confirmed Full when required information is Unknown, No or Partial, applicability is unresolved, or requirement conflicts are unresolved. Unknown proves neither match nor mismatch.
- [ ] Allow provisional assessments and unassessed linking when the basis is unresolved. Preserve one tactic record with independent per-gap assessments.
- [ ] Identify unsupported historical Full assessments for review, preserve their history and approved snapshots, and do not silently revalidate them or treat them as newly verified current Full contributions.
- [ ] Enforce the same validation at the public action/request boundary, with existing permissions, audit and version-conflict protections. Failed validation saves no partial confirmation.
- [ ] Verify saved and rejected outcomes through existing Vitest public-action/request tests, including legacy data, AI proposals, human confirmation, unresolved requirements and independent relationships.

## Blocked by

None (can start immediately).
