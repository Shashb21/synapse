# KAN-121: fit and coverage design interview

Issue: https://synapse21.atlassian.net/browse/KAN-121

The user confirmed all interview decisions and the consolidated design, then requested a specification and implementation tickets. The user approved the test boundaries and six-ticket breakdown. Specification KAN-140 and implementation tickets KAN-141 through KAN-146 were published and verified.

## Accepted decisions

1. Design fit describes how a tactic's documented design addresses a particular gap's requirements. It does not claim delivered evidence, and strong design fit does not independently change evidence status. Reuse existing coverage rules rather than create a second scoring engine.
2. Assessment origin, the recorded claim, human review and freshness are separate facts, not one lifecycle sequence. Relevant changes can require review without erasing previous human confirmation history; decisions 4, 5 and 11 define the confirmation and invalidation rules.
3. Each relationship shows what that tactic leaves unanswered. Linking a second tactic does not improve the first tactic's assessment. Combined remaining need remains the responsibility of the existing gap assessment.
4. An explicit human overall verdict and rationale confirm the overall coverage claim. Dimension confirmations remain separate. Acknowledging a review warning clears that warning only; it cannot create or upgrade a verdict or confirm unreviewed dimensions.
5. Substantive changes to supporting gap requirements or tactic design require renewed review. Preserve the previous judgement and confirmation history and show the reason. Cosmetic edits do not invalidate assessments. Existing sibling-review warnings remain distinct from changes to the assessment's own underlying requirements/design.
6. The library chooser retains both Link as unassessed and Assess and link. Preview alone saves no relationship or assessment; cancellation creates nothing. Reuse the existing assessment action, rationale, permissions and audit behavior. Reuse tactic records and preserve entered assessment work on a recoverable failure.
7. Per-tactic unanswered requirements are explanatory. Use recorded dimension verdicts and rationales, distinguish mismatch from unknown, and remain usable with AI disabled. Showing the explanation does not create or rewrite gaps; residual-gap actions remain deliberate human actions.
8. Each gap has an explicit, reviewable requirement basis drawn from linked EvidenceNeed records and gap context. Preserve requirement provenance and surface disagreements instead of silently choosing. Required, Not applicable and Not yet determined are distinct; omission does not establish non-applicability. Unresolved requirements do not prevent an unassessed tactic link.
9. Check newly parsed claims against relevant current gaps/tactics within the same plan. Reuse matching to link supporting information or raise source-backed possible discrepancies identifying affected records/relationships. Automatically flag possible discrepancies for review, but require a human decision before accepting a replacement claim or changing a confirmed assessment. A possible contradiction is distinct from an accepted change that makes an assessment outdated.
10. Unknown information cannot be included as established knowledge. It supports neither a match nor an asserted mismatch; do not fill it by inference merely to complete an assessment. A required unknown cannot justify Full coverage. Not applicable must be explicitly established rather than inferred from omission. Historical Full assessments lacking required support need review, not silent revalidation.
11. A pending discrepancy preserves the recorded verdict and gap status while prominently marking the assessment challenged/needs review. After a reviewer accepts a substantive underlying change, keep the old verdict and confirmation history, mark the affected assessment outdated and require reassessment. Outdated coverage cannot supply a current Full contribution to Addressed status. Other current assessments can still support that status. Recalculate through the existing coverage engine; approved inventories use revision/reapproval rather than mutation of their approved snapshot.
12. Document comparison states distinguish Pending, Completed, Failed and Not run because AI is disabled. A failed/unavailable comparison retains the parsed document and never implies no conflicts. Permit manual source linking/discrepancy reporting, plus retry after failure without duplicate links/findings. A completed check reporting no discrepancies is a result of that check, not proof that no conflict exists.
13. Only an authorised human coverage reviewer can confirm the requirement basis and coverage judgement. AI/extraction may propose requirements and applicability with supporting sources. Present the basis in the same assessment review flow; do not require a separate approval process for every field. Uncertain applicability must be resolved before Full confirmation, while provisional assessments and unassessed links remain allowed.
14. Keep one coherent feature specification with two connected implementation slices: requirements/relationship assessments, then incoming-document checks. The complete agreed feature includes both. Reuse coverage ownership, permissions, audit and revision rules rather than introducing a second coverage engine.

## Interview outcome

No unresolved product questions remain from this interview. The user clarified: "'link' or raise the discrepancy" and that the confirming coverage reviewer must be human. Supporting source linkage does not itself confirm coverage. The user confirmed the consolidated design. No application implementation was performed. The approved specification and six implementation tickets were published as separate Jira issues; source KAN-121 remains unchanged.

## Verification scenarios agreed in principle

- A planned tactic can have matching design requirements without implying completed evidence.
- A relevant change preserves previous confirmation history while visibly requiring review.
- Adding a second tactic does not change the first tactic's relationship assessment.
- Acknowledging a warning cannot create confirmed coverage, upgrade Partial to Full, or confirm every dimension.
- A comparator change requires renewed review with a reason; a title-only change does not.
- Cancelling preview creates nothing, an unassessed link remains explicit, and assessment failures retain user input for retry.
- Per-tactic explanations distinguish mismatch from missing information and create no gap records.
- Requirements specified by linked evidence needs remain visible despite omission from a gap summary; conflicting requirements are surfaced.
- A conflicting incoming protocol creates a source-backed discrepancy finding and preserves the saved assessment and confirmation history until human decision.
- Unknown required information cannot be represented as a match or justify Full; explicitly justified Not applicable does not count against fit.
- Pending discrepancies do not silently reopen a gap; accepted substantive changes invalidate affected assessments, preserve history and can change current derived status through the coverage engine/revision rules.
- Failed/AI-off comparisons never display a clean conflict result; parsed documents and manual actions remain available, and retry does not duplicate outcomes.

## Current implementation constraints

Source inspection on `kan-110-111-ingestion` at `18b0f82` found:

- `GapTacticCoverage` and the coverage store own per-relationship judgements; `PlanTactic` projects them for display.
- The existing gap detail page edits overall and dimension coverage. Manual mapping with coverage requires an overall judgement and rationale, but permits Unknown dimensions. General mapping can create an unassessed relationship.
- A human-locked Full assessment on a counting tactic can currently make a gap Addressed. This differs from merely confirming that an assessment was reviewed.
- The coverage `stale` field is explicitly unused for schema compatibility. The active `needs_review` flag is used after a sibling relationship changes; broader freshness semantics are not established.
- Existing residual-gap handling is distinct from a tactic's unanswered requirements.
- All ten coverage dimensions currently use Yes/Partial/No/Unknown; there is no per-dimension requiredness or Not applicable state. Structured requirements primarily live on associated EvidenceNeed records, while gaps also hold text and metadata. Decision 8 defines the desired assessment basis; its implementation does not yet exist.
- Extraction already compares Same/Overlapping/New gaps and tactics. It links source provenance or proposes human-reviewed changes. A new-source marker exists for reviewed gaps, but there is no explicit claim-contradiction finding or targeted assessment-impact comparison. Accepted gap merges already flag affected coverage rows for review.

These are source findings, not live browser verification. No application code has changed for this interview.
