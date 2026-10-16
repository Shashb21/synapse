# 05: Make AI priority suggestions inspectable and safe to accept

## Parent

[KAN-120](https://synapse21.atlassian.net/browse/KAN-120)

## What to build

An AI priority suggestion includes readable reasoning and inspectable supporting references to supplied records. A reviewer can inspect its basis before acceptance, regenerate an unsupported suggestion, or make an explicit manual judgement with a reason. Extend existing S8 contracts, storage and history/reference handling as one complete behaviour.

## Acceptance criteria

- [ ] Carry references and the reasoning they support from supplied gap/objective/source context through model input/output validation, persisted suggestion details and review UI. Use real supplied record identifiers; do not manufacture support after generation.
- [ ] Validate targets exist, belong to authorised workspace context and are inspectable by the reviewing user. Missing, malformed, inaccessible or unrelated references cannot count as supported judgements. Confidence and administrator-only run traces are insufficient.
- [ ] Keep suggestions advisory. Unsupported output remains explicitly unsupported and cannot be accepted as a supported AI judgement. Offer regeneration or an explicit manual judgement with a reason; manual judgement does not require a supporting reference.
- [ ] Persist applicable inspectable references with the reasoned decision/history through the existing audit mechanism. Extend that mechanism's reference validation/readback so other covered model judgements can reuse it; do not create a second audit store.
- [ ] Show **Supporting references not recorded for this suggestion** on older unsupported suggestions. An unconfirmed older suggestion needs regeneration with valid support or explicit manual judgement before acceptance. Show **Reason not recorded** for older missing reasons without fabricating either.
- [ ] Preserve existing human-confirmed priorities at launch and human-entered scores/bands/rationale on reruns. Generate neither decision dates nor evidence deadlines. Retain AI-off/manual operation and existing eligibility/permissions.
- [ ] Model/save/reference-load failures produce accessible feedback, retain human input and do not partially save a decision or its history. Server-side requests cannot bypass the support checks.
- [ ] Browser tests with deterministic model responses prove inspection, supported acceptance, unsupported/manual alternatives, older records and rerun preservation. Focused S8/route/persistence checks cover invalid/inaccessible targets, incomplete output, workspace isolation and save/audit failure consistency. No paid AI calls.

## Blocked by

- **02: Require and preserve reasons for manual priority decisions** — supplies the audited acceptance/manual-decision path extended with supporting references.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect current S8 contracts. Existing suggestions do not yet carry citation fields; this is a data and behaviour change as well as presentation. KAN-124 reuses the resulting history/reference readback.
