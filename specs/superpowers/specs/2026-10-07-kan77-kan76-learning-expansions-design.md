# KAN-77 and KAN-76: learning and tactic expansions

Status: design proposal for review; implementation has not started.

## Goal and Jira ownership

Complete the learning prerequisite (KAN-77, through KAN-78, KAN-79 and KAN-80), then implement tactic matching and expansion under KAN-76. KAN-67 supplies binding expansion acceptance criteria and must not become a second implementation. KAN-75 is already Done: verify and reuse its gap matching/review workflow rather than rebuilding it. Do not resolve an issue until implementation, required QA, a verification comment and its Done transition succeed.

## Existing code and baseline

The current checkout is KAN4 and contains unrelated uncommitted documentation and .gitignore changes. Leave those untouched. Cached origin/main includes KAN-74/KAN-75; cached origin/KAN-78-decision-learning includes the existing KAN-78/KAN-79 implementation, commits 23cb7c5 and 9924572. Refresh the relevant remote references before choosing the implementation baseline. Use an isolated feature worktree, preserving the existing learning implementation for review and repair rather than rewriting it.

The application has two implementations: the modular IEGP stages and the Accuracy Lab. These tickets describe modular S2/S3/S4/S8/S9/S10. Keep the product behavior in those stages and their shared kernel; do not create a parallel expansion implementation in Accuracy Lab.

## Approach and alternatives

Extend the existing decision-example store and stage decision paths, the kernel evaluation/prompt-variant machinery, and the tactic/coverage store. This preserves one owner for each invariant. A standalone learning service or a separate expansion engine would duplicate state and increase privacy and consistency risks. Rebuilding the existing unmerged learning branch would also discard reviewable work. Reuse and repair is the preferred approach.

## Learning data and privacy: KAN-78/KAN-79

Record each AI accept, edit or reject with its stage, decision kind, input/output, final values, rationale, workspace, timestamp, model and route. Review all required capture paths: recordEdit, gap suggestions, ideation, mapping edits and priority validation. Avoid duplicate examples from nested capture paths. Preserve the user's decision if lesson generation fails; failures must be observable and retryable.

Retain the model-generated de-identified lesson plus deterministic validation. De-identification means removing details that identify the customer, product or study. Numbers and quotations must also be removed as the ticket specifies. Resolve entity context from the recorded example's workspace, including when a background worker processes examples from several workspaces. Missing entity context, failed validation or failed generation must prevent sharing that lesson. Validate the privacy boundary again at retrieval, rather than trusting a stored status alone.

Retrieve three to five similar cases by stage and decision kind using the existing text-similarity approach. Same-workspace examples may contain their original text. Cross-workspace examples expose only validated lessons: no raw inputs, outputs, rationales or customer metadata. Present examples as past decisions, not instructions. Remove the old reviewer-rationales-as-rules path and retain example IDs in run traces.

Real-customer cross-workspace learning remains disabled until anonymised usage is covered by customer terms. Implement the sharing eligibility check with a safe default and test both eligible and ineligible cases; do not enable a real-customer rollout as part of development.

## Measured prompt improvement: KAN-80

Add an owner-only learning view in the existing admin interface. Show the accepted-unchanged, edited and rejected counts and shares per stage over time. Empty periods display no observations; they must not imply perfect agreement. Use the saved human outcome, not the rationale wording, to classify decisions.

An explicit admin action proposes a general stage-specific prompt revision using validated de-identified disagreement lessons only. Store immutable prompt versions with their parent version, stage, content, creator, timestamp and status. A revision is a candidate until evaluated and approved. It never replaces the active prompt merely because generation or scoring succeeds.

Extend the existing hillclimb evaluation layer to compare the candidate and current active version on the same frozen gold and decision-replay cases. Replay means rerunning the saved input and scoring the resulting decision against the saved human outcome. Exclude the held-out evaluation examples from worked-example retrieval and revision-generation inputs so the system cannot receive the answers it is being tested on. Keep replay scoped to the workspace authorised for evaluation; do not aggregate raw inputs across customers into a single model prompt. Eval execution must not write tactics, mappings or decisions into the live plan. Score final match/decision kinds for suggestions, explicit coverage verdicts for mapping, validated bands for prioritisation, and retained/rejected proposal decisions plus required final design fields for ideation; display each stage's metrics separately. Cases missing a replayable stage input or a determinate human target are excluded with a recorded reason and count, never counted as successes.

Persist the case set identity, prompt versions, model/route identity, score counts, baseline/candidate metrics and failures. Require a strict improvement on the combined evaluation and no regression on any scored gold metric. Missing gold, missing replay cases, failed cases or non-comparable runs make the candidate ineligible for promotion; the admin sees why. Do not invent a score for an unsupported decision kind.

Approval atomically changes the active stage version only if it still matches the evaluated baseline; stale approvals must fail clearly. Record the before/after and actor. Rollback explicitly restores the previous active version and records the same history. Existing owner authentication applies to every read and mutation API. User errors return a specific actionable response without exposing raw cross-workspace examples.

## Tactic source matching: KAN-76

Extend S3's existing duplicate handling to explicit same / overlaps / new classifications. Validate the referenced tactic against the library supplied to the model. Same attaches source provenance to the existing tactic without creating another. New follows the existing creation path. Overlaps creates a review suggestion containing an expansion option and a separate linked tactic option; it cannot silently rewrite a human-locked tactic.

Reuse the structure of KAN-75's review queue, rationale and decision records, but keep tactic-specific persistence and acceptance owned by the tactic layer. Accepted expansions and accepted separate linked tactics use the same canonical mutations that S9 uses. Retain rejected decisions and source provenance for later review and learning.

## Ideation and expansions: KAN-76/KAN-67

Keep ideation restricted to open gaps with a human-validated High priority. Give proposer, critic and judge the full relevant tactic inventory, including completed, ongoing, planned and proposed tactics. Require each proposal to identify either a new tactic or an expansion with a valid existing tactic ID.

An expansion specifies the added population, endpoints, geography, data cut, analysis or instrument; the part of the gap covered; incremental cost/effort; timing; and feasibility risks. A completed study cannot acquire prospective enrolment; post-hoc analyses must be identified. Locked protocols may require an amendment. The critic compares expansion and new options, preferring comparable-quality options that are sooner or cheaper and explaining when an expansion is unsuitable. Validate model payloads rather than silently coercing invalid references or missing required fields.

The existing proposal review UI displays “Expand: <existing tactic>” or “New tactic”, allows editing before deciding, and requires the existing decision rationale. Acceptance of a new tactic keeps the current path. Acceptance of an expansion records an activity attached to the existing tactic, with immutable scope/history and its own lifecycle status. It does not create a second library tactic or change the base tactic's lifecycle. Repeated/concurrent acceptance must not create duplicate activities.

An accepted expansion initially has status proposed. Coverage attributable to it remains non-counting even if its parent tactic is completed or ongoing. Existing coverage from the parent tactic remains intact. A human explicitly marking the expansion planned or ongoing makes its contribution eligible for the ordinary coverage/status calculation; this does not itself human-validate full coverage. Preserve human locks, rejection memory and audit records. Coordinate this additive coverage provenance contract with KAN-83 rather than duplicating its shared status engine.

Extend S10 to show each expansion as an activity under its existing tactic, with independent dates, status and proposed/counting indication. Timeline rebuilds preserve human schedule/dependency edits and do not collapse multiple expansion activities into the parent row.

## Ownership and verification

Learning capture/retrieval stays in src/modules/kernel/decision-examples.ts and src/lib/iegp/learning-capture.ts, with the stage decision paths consuming it. Prompt version storage, evaluation and promotion stay in the kernel alongside prompt-versions.ts, prompt-variant.ts and hillclimb-loop.ts. Admin views and authorised routes expose that kernel behavior.

Tactic and expansion persistence stays with src/lib/iegp/types.ts and store.ts and the module-owned proposal/suggestion schemas. Coverage eligibility stays in src/lib/iegp/engine.ts; S3 and S9 cannot implement separate status rules. S10 and its existing timeline components consume persisted expansion activities.

Use the repository's TypeScript testing tools (Vitest and Playwright). Tests follow Arrange / Act / Assert: set up a scenario, perform the action, check observable behavior. Verify privacy failures, all capture paths, retrieval/traces, agreement denominators, isolated replay, promotion eligibility, stale approvals, rollback, same/overlaps/new, editing/acceptance/rejection, concurrent decisions, proposed expansion coverage, existing locked coverage, history and timeline rebuilds. Run focused tests per task, then type checking and the relevant browser flows.

Run the Corvantix acceptance scenario with a real connected model: show at least one sensible expansion beside new ideas, accept it, confirm the tactic count is unchanged, coverage is non-counting while proposed, and the timeline nests the activity. Stub-only results do not satisfy this acceptance. Report missing database/model access as a limitation and leave the relevant Jira issues open.

## Execution order

1. Refresh baseline, verify KAN-75, review and repair existing KAN-78/KAN-79 with a fresh implementer and task review.
2. Deliver KAN-80 agreement reporting and candidate version generation.
3. Deliver isolated gold/replay evaluation, guarded admin promotion and rollback; complete KAN-77 only when its children satisfy verification.
4. Implement the expansion persistence and shared coverage eligibility contract.
5. Extend S3 matching and its human review queue.
6. Extend S9 proposer/critic/judge, editable proposal review and canonical acceptance.
7. Extend S10, run unit/browser/Corvantix QA and perform a whole-branch review.

Each implementation task gets a fresh implementer, a requirements and quality review, a bounded fix loop, and a persistent SDD ledger. Publish commits to both required remotes when authorised. Do not merge or deploy without the required final integration approval.
