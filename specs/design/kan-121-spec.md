# KAN-121: gap–tactic fit, coverage and incoming evidence review

## Problem Statement

People reviewing a gap cannot reliably distinguish a tactic's documented design fit, its recorded coverage judgement, human confirmation and whether that judgement remains current. They need to understand what each tactic leaves unanswered, even when another tactic addresses the same gap. New documents can contradict existing requirements or tactic designs without a targeted, cited review process. Missing information must never become invented knowledge or unjustified Full coverage.

## Solution

Show a requirements-based assessment for each gap–tactic relationship, including design fit, recorded coverage, unanswered requirements, human review and freshness. Give reviewers one explicit gap requirement basis, preserving its sources and unresolved disagreements. Allow both unassessed linking and assessment while linking a library tactic.

Check every newly parsed document against relevant gaps and tactics in its plan. Link supporting claims or raise cited possible discrepancies for human review. Preserve existing judgements while a discrepancy is pending; an accepted substantive change makes affected assessments outdated and triggers the existing coverage and revision rules.

## User Stories

1. As a gap reviewer, I want to see the requirements drawn from linked evidence needs and gap context, so that assessment uses the complete requirement basis.
2. As a gap reviewer, I want requirement sources and disagreements shown, so that I can resolve conflicts without silently losing evidence.
3. As a human coverage reviewer, I want to distinguish Required, Not applicable and Not yet determined, so that missing requirements are not mistaken for irrelevant ones.
4. As a human coverage reviewer, I want to review the requirement basis within the assessment flow, so that confirmation does not require a separate ceremony for every field.
5. As a human coverage reviewer, I want Full confirmation blocked by unanswered required information or unresolved applicability, so that confirmed coverage has support.
6. As a reviewer, I want unknown information distinguished from a known mismatch, so that uncertainty does not become an unsupported factual claim.
7. As a reviewer, I want explicitly justified non-applicability preserved, so that irrelevant dimensions do not prevent appropriate coverage.
8. As a reviewer, I want unsupported historical Full assessments flagged for review, so that old data is neither fabricated nor silently revalidated.
9. As a planner, I want to see documented design fit separately from delivered evidence, so that a promising planned tactic does not imply completed research.
10. As a planner, I want assessment origin, saved verdict, human confirmation and freshness shown separately, so that I understand what a judgement means today.
11. As a planner, I want each tactic's unanswered requirements explained from saved verdicts and rationales, so that I can understand its specific limitations.
12. As a planner, I want independent assessments when one tactic serves multiple gaps, so that one relationship cannot overwrite another.
13. As a planner, I want a tactic's limitations preserved when another tactic is added, so that combined coverage does not hide individual shortcomings.
14. As a library user, I want to preview a tactic before linking it, so that I can assess relevance without saving unwanted records.
15. As a library user, I want Link as unassessed, so that unresolved requirements do not stop useful planning.
16. As a library user, I want Assess and link using the existing review flow, so that I can save a deliberate relationship and judgement together.
17. As a library user, I want cancellation to create nothing and failed saves to retain my input, so that exploration and retry are safe.
18. As a keyboard user, I want accessible preview, assessment and error feedback, so that I can complete the same workflow without a pointer.
19. As a human coverage reviewer, I want an explicit overall verdict and rationale to confirm overall coverage, so that acknowledging a warning cannot create or upgrade coverage.
20. As a reviewer, I want dimension confirmations kept separate from the overall confirmation, so that unreviewed details remain visible.
21. As a reviewer, I want substantive requirement or design edits to require reassessment, so that old confirmations do not appear current after their basis changes.
22. As a reviewer, I want cosmetic edits to preserve assessment freshness, so that harmless changes do not generate unnecessary review.
23. As an auditor, I want prior judgements, confirmations and review reasons retained, so that I can reconstruct changes.
24. As a planner, I want outdated Full contributions excluded from current Addressed status, so that current status follows current eligible assessments.
25. As an inventory approver, I want approved snapshots preserved through revision and reapproval, so that later changes do not rewrite an approved decision.
26. As a document uploader, I want each newly parsed document compared with relevant records in the same plan, so that supporting and conflicting claims reach the right review context.
27. As a reviewer, I want supporting passages linked with provenance, so that I can inspect their source without treating linkage as coverage confirmation.
28. As a reviewer, I want possible discrepancies to identify cited claims and affected relationships, so that I can judge whether an apparent conflict is real.
29. As a reviewer, I want pending discrepancies to challenge current confirmation without replacing the saved verdict or gap status, so that uncertainty remains visible until a human decides.
30. As a human coverage reviewer, I want to accept or dismiss a discrepancy with a rationale, so that extracted claims cannot silently replace confirmed knowledge.
31. As a document uploader, I want Pending, Completed, Failed and Not run because AI is disabled shown separately, so that parsing success is not confused with comparison success.
32. As a document uploader, I want a failed comparison to retain my document and support retry without duplicate outcomes, so that failures do not lose work or multiply findings.
33. As a reviewer working without AI, I want manual linking, discrepancy reporting and assessment explanations, so that human review remains usable.
34. As a viewer, I want read-only access governed by existing permissions, so that assessment and source decisions remain restricted to authorised reviewers.
35. As a planner, I want no-discrepancy wording reserved for completed checks, so that an unchecked document is never presented as clean or a completed check as proof that no conflict exists.

## Implementation Decisions

- Extend the existing per-relationship coverage model, public actions and read models. Keep the existing coverage engine responsible for combined gap status and remaining need; preserve tactic lifecycle eligibility. Do not create a parallel scoring engine.
- Establish a persisted, reviewable gap requirement basis from linked EvidenceNeed records and gap context. Preserve provenance and conflicting requirements. Use the existing coverage dimensions with explicit Required, Not applicable and Not yet determined applicability. Omission is never non-applicability.
- AI and extraction may propose source-backed requirements and judgements. Only an authorised human coverage reviewer can confirm the requirement basis and coverage judgement. Review the basis within the existing assessment flow.
- Confirmed Full requires all applicable requirements satisfied. Required Unknown, Partial or No, unresolved applicability and unresolved requirement conflicts prevent confirmed Full. Explicitly justified Not applicable does not count against fit. Unknown establishes neither match nor mismatch.
- Preserve provisional assessments and unassessed links when requirements remain unresolved. Flag unsupported legacy Full assessments for review; do not invent missing support, silently confirm them or rewrite historical snapshots. Unsupported legacy assessments must not be treated as newly verified current Full contributions.
- Store and present assessment origin, recorded verdict, human confirmation and freshness as separate facts. Overall confirmation requires an explicit human verdict and rationale; dimension confirmations remain separate. Warning acknowledgement cannot create or upgrade coverage or confirm dimensions.
- Show Fit to this gap, known matches, known mismatches, uncertainty, expected contribution and each tactic's unanswered requirements. Derive explanatory text from recorded dimensions and rationales, including when AI is disabled. Keep combined remaining need at gap level; create no automatic residual gaps.
- Reuse one tactic record across relationships. The chooser offers Link as unassessed and Assess and link using existing assessment actions, permissions and audit. Preview and cancellation persist nothing. Recoverable failures preserve input; retry must not duplicate relationships or assessments.
- Substantive changes to supporting requirements or tactic design make affected assessments outdated, preserving the old verdict, confirmations and reason. Cosmetic edits do not. Existing sibling-review warnings remain distinct, and one relationship never copies its verdict into another.
- An outdated assessment cannot supply the current Full contribution needed for Addressed. Recalculate through the existing engine, allowing other eligible current assessments to count. Preserve approved snapshots through existing revision/reapproval rules.
- Extend existing ingestion and Same/Overlapping/New matching to compare extracted source-backed claims with relevant records in the same plan. Link supporting information or raise cited possible discrepancies identifying affected relationships. Ingestion must not become another coverage engine.
- A pending discrepancy preserves the recorded verdict and derived gap status while prominently challenging current confirmation. Human review with rationale precedes replacement of confirmed knowledge. Acceptance of a substantive change invokes assessment invalidation; dismissal preserves the judgement and records the decision. Resolving one finding must not clear unrelated review reasons.
- Persist comparison outcomes as Pending, Completed, Failed or Not run because AI is disabled. Parsing success is independent. Failure retains the document; manual source linking and discrepancy entry remain available. Repeated execution or retry creates no duplicate links or findings. Only a completed check may report no discrepancies detected, with no claim of certainty.
- Reuse existing authorisation, source provenance, audit, revision and version-conflict protections. Validate relationships and source references within the plan at the server boundary. Stale review submissions must not overwrite newer confirmed knowledge. Provide accessible status/error feedback and keyboard operation.
- Deliver one feature through two connected areas: requirements/relationship assessment, and incoming-document checks. Both are required. The ticket breakdown will split these into manageable complete user workflows; wider workshop integration remains separate.

## Testing Decisions

- Approved primary test seam: exercise public application actions or request handlers, then inspect saved state and the read model visible to users. A test seam is the boundary where a test enters the application and observes the result. Prefer these existing boundaries over new test-only interfaces.
- Use Vitest and existing manual-mapping, expansion-coverage, ingestion and AI-disabled route test patterns. Use deterministic model responses for comparison cases. Test observable judgements, history, status, permissions and duplicate prevention, rather than private helper calls or source text.
- Cover missing required comparator versus known unsuitable comparator; justified non-applicability; conflicting requirements; uncertain applicability; human versus AI confirmation; provisional linking; unsupported legacy Full; and independent relationships. Verify rejected requests persist no partial changes.
- Cover substantive versus cosmetic edits, sibling warnings, warning acknowledgement, current versus outdated Full contributions and preservation of approved snapshots. Use focused existing engine tests only for eligibility rules that need direct proof.
- Cover supporting claims, cited conflicts, pending versus accepted changes, dismissal, stale reviewer submissions, cross-plan rejection and independent unresolved review reasons.
- Cover Pending/Completed/Failed/AI-disabled states, retained parsed documents, manual fallback, duplicate-free retries and truthful no-discrepancy wording. Assert that parsing alone never completes comparison.
- Add a small number of Playwright journeys using the existing browser-flow patterns: keyboard-accessible preview/cancel, link-only and assessed link, preserved input after failure, and document discrepancy review through the visible status change. Do not duplicate the full application-action matrix in the browser.
- The user approved these implementation test boundaries. Application tests and live browser verification have not been run for this documentation task.

## Out of Scope

Application implementation during this planning task; a second coverage/scoring engine; automatic confirmation or replacement of human judgements; invented missing facts; automatic residual-gap creation; copying tactics per gap; changing existing tactic lifecycle eligibility; a separate approval ceremony for each requirement; cross-plan claim matching; a redesign of wider workshop integration; and closing or modifying source issue KAN-121.

## Further Notes

Source issue: https://synapse21.atlassian.net/browse/KAN-121. All fourteen interview decisions and the consolidated design were confirmed by the user. The user approved the test boundaries and six-ticket breakdown for publication. Published specification: https://synapse21.atlassian.net/browse/KAN-140. Implementation tickets KAN-141 through KAN-146 were published with ready-for-agent labels and verified blocking links. Source KAN-121 remains unchanged.

The source inspection found fixed coverage dimensions without applicability, an explicitly unused compatibility freshness field, and matching without targeted contradiction findings. These are implementation gaps. Reuse active coverage, matching and revision ownership rather than assuming those capabilities already exist. Re-fetch the source issue and inspect the current integrated code before implementation.
