# KAN-122 design discussion

Ticket: https://synapse21.atlassian.net/browse/KAN-122

Status: scope approved by the user on 2026-10-25, with instructions to update KAN-122 and implement on a new branch using subagent-driven development. Jira now includes these decisions. Implementation plan: [kan-122-plan.md](kan-122-plan.md).

Implementation on `kan-122-ideation-evidence`: recommendation contracts, context safeguards and review surfaces are implemented. Independent review and its corrections are complete; the affected browser flow passed. Full regression verification and pull-request checks are the final delivery gates. The Jira completion lifecycle remains required before the issue is marked Done.

## Agreed decisions

1. Judge recommendations primarily by their additional contribution toward the remaining evidence need. A scientifically plausible study that duplicates existing evidence is insufficient.
2. Reusing existing evidence and requesting a coverage reassessment can be the best outcome. Do not force an expansion or new study merely to provide options. Ideation cannot itself close the gap.
3. Allow conditional recommendations when feasibility is uncertain. State missing information and required checks prominently; unknown feasibility must not be presented as established feasibility or impossibility.
4. Reuse adds no work to an existing tactic; expansion adds work, including a new analysis of existing data; a new tactic is a separate activity. Reusing a planned output does not imply evidence is available today.
5. Acting on reuse brings the existing tactic into the gap's coverage-review workflow. Preserve existing assessments and avoid duplicate tactics or relationships; ideation does not confirm coverage.
6. Conditional proposals may be accepted as proposed/unassessed. Preserve unresolved feasibility conditions visibly in the accepted proposal and wherever it is reviewed or used in planning.
7. Each recommendation explains the overall remaining need, its additional contribution, why it is preferable to relevant alternatives, and assumptions, feasibility limits or timing constraints. Keep the Judge score secondary and explicitly non-probabilistic.
8. Consider existing tactics together, but do not assume separate studies establish a valid comparison. Any proposed comparative analysis must explain the method's feasibility and relevant data-compatibility checks.
9. Surface apparent disagreements with recorded coverage for review, preserve the recorded assessment, and make affected recommendations conditional on resolving the discrepancy.
10. Explicitly report when no credible option meets the evidence deadline. Leave the need unresolved and distinguish any useful longer-term option from a timely solution; do not silently relax the deadline.
11. Build the per-gap brief from recorded requirements, priority rationale, tactic designs/lifecycle and coverage assessments. Keep missing or conflicting requirements explicit; suggested requirements need human confirmation. Offer conditional options only when meaningful, otherwise explain what must be clarified first.
12. Check for material supporting-context changes before acceptance. Changes affecting contribution, feasibility or eligibility require renewed review of the affected proposal, preserving its prior reasoning and using existing review mechanisms where suitable.
13. In AI-off workflows, expose the relevant context and allow users to enter rationale and uncertainties without requiring a written comparison of all three routes before saving. Preserve existing eligibility, acceptance and coverage safeguards.

## Verification scenarios implied by these decisions

- An older-patient study without a comparator must not be recommended as sufficient for a comparative-effectiveness question merely because population and outcomes match.
- Existing evidence that appears sufficient can lead to a reuse/reassessment recommendation without creating a duplicate tactic or closing the gap.
- Unknown comparator-data availability produces an explicitly conditional expansion option and a clear availability check.
- A new analysis of existing data is expansion, not reuse; using an already planned output does not mark evidence delivered.
- Reuse routes to coverage review without duplicating or overwriting existing tactics or assessments.
- Accepting a conditional proposal preserves its unresolved condition in subsequent planning views and leaves coverage unassessed.
- Separate treatment and standard-care studies with incompatible designs do not automatically establish comparative evidence.
- A recommendation that conflicts with recorded coverage flags the discrepancy without overwriting the assessment.
- When all credible options miss the evidence deadline, the result states that limitation and identifies longer-term options separately.
- An unspecified required comparator stays unknown or is suggested for human confirmation, not silently established by ideation.
- A material gap-requirement or tactic-lifecycle change between generation and acceptance requires renewed review of the affected proposal.
- AI-off users can inspect context and save a manual proposal without a mandatory three-route comparison; existing safeguards remain enforced.

## Scope and implementation follow-up

- No unanswered product questions remain from this interview. The user approved implementation of the consolidated scope.
- Before implementation, compare these decisions with current code and the Jira description. Context-change checks, reuse routing, and visibility of accepted feasibility conditions across planning views may touch related work; identify existing owners and flag any additional scope rather than creating parallel systems.
- Verify recommendation payloads and controlled/stubbed recommendation paths, acceptance invariants, duplicate prevention, changed-context handling and AI-off operation. Paid AI runs are not required.
- Keep KAN-122 open until implementation, verification and the repository Jira completion lifecycle succeed. The ticket description has been updated; delivery evidence will be recorded after verification.

## Existing implementation facts

Read-only inspection found new and expansion proposal kinds, existing comparative prompt guidance, and protection of proposed/unassessed acceptance and parent tactics. These are existing mechanisms to extend, not evidence that KAN-122 is implemented.
