# KAN-122 implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development, with sequential implementation and independent review.

**Goal:** Compare reuse, expansion and new tactics against the remaining evidence need while preserving scientific coverage review.

**Architecture:** Extend customer S9 and the existing relationship and requirement owners. Store recommendation reasoning and its reviewed context in existing proposal JSON; do not create a parallel approval system. The separate accuracy claims pipeline remains unchanged.

**Tech Stack:** TypeScript, Next 16, React, Zod, Drizzle/Postgres, Vitest, Playwright.

**Spec:** specs/design/kan-122-design-discussion.md (all 13 decisions approved by the user's instruction to update and build).

## Global Constraints

- S4 remains authoritative for recorded coverage. Ideation never closes a gap or confirms coverage.
- Preserve human-confirmed High/Open eligibility, authorization, audit history, original tactic records and AI-off manual operation.
- Reuse adds no work; expansion adds work, including new analysis of existing data; new is a separate activity. Planned output is not delivered evidence.
- Acceptance creates proposed/unassessed new or expansion work. Reuse preserves existing assessments and requests coverage review without duplicate tactics or relationships.
- Missing/conflicting requirements remain explicit. Suggested requirements need human confirmation. Unknown feasibility is conditional, with visible required checks.
- Preserve original reasoning and require renewed review after material context changes. Extend existing review mechanisms.
- No paid AI calls. Use controlled model responses. Use disposable test databases only.
- Design discussions and supporting plans belong in specs/design; add KAN-122 to specs/README.md.
- Workers are not alone in the codebase; preserve other edits. Workers must not spawn agents, commit or push; controller owns git operations.

## Review Focus

- Empty/unknown comparator requirements must remain unknown, including when planning names a comparator.
- Separate incompatible studies cannot silently become comparative evidence.
- Reuse of planned output cannot change lifecycle, existing assessments or original timeline timing.
- Changed requirements, coverage, priority rationale or tactic lifecycle must block silent acceptance; renewed review preserves prior reasoning.
- Conditional accepted work must retain visible checks in tactic review and planning, including AI-off workflows.

### Task 1: Context and recommendation contract

**Files:** Create focused S9 context/contract helpers as needed; modify src/modules/stages/s9-ideation/module.ts and its tests. Reference /private/tmp/kan122-implementation-facts.md for existing owner locations.

**Interfaces:** Produce a single exported per-gap brief builder from IegpState and recorded priority placements; a stable semantic acceptance-basis representation; typed recommendation fields used in proposal output and JSON design metadata. Establish exact exported names/types in report for later tasks.

- [x] Add failing Vitest tests for a missing-comparator brief containing confirmed requirements/unknowns, objective evidence deadline, priority rationale, mapped designs/lifecycle and coverage. Use Arrange (prepare data), Act (call behavior), Assert (check result).
- [x] Add controlled proposer/critic/judge tests for reuse, conditional comparator expansion, incompatible comparisons, coverage disagreement and no credible timely option. Assert context and persisted output semantics, not keyword-based medical inference.
- [x] Implement brief using requirement-basis.ts and canonical objective/coverage records; do not invent confirmed requirements or infer coverage. Include supporting-context versions for relevant requirements, priority, tactics/children and assessments; exclude irrelevant UI/write metadata.
- [x] Extend every initial, revision, critic, judge and deterministic stub path for reuse, remaining need, incremental contribution, comparison, feasibility checks, coverage discrepancy and deadline/unresolved outcome. No forced three-route quota. A gap may return no credible option with an explicit explanation; preserve this outcome for later readback.
- [x] Preserve compatibility for older records and existing controlled test outputs; new model contracts should require meaningful reasoning and validate target identity/lifecycle. Reuse target must be an existing eligible accepted tactic. New analysis is expansion. Score is a non-probabilistic review rating.
- [x] Run new tests and focused s9-llm/s9-expansions/planning-context regressions; report exact commands/results and any baseline failures. Report interfaces and changed files in task report; no commit.

### Task 2: Acceptance, reuse and retained context

**Files:** S9 module/helper from Task 1; src/lib/iegp/store.ts (relationship owner only as needed); src/app/api/plan/route.ts; src/modules/stages/s10-timeline/module.ts; src/lib/iegp/learning-capture.ts; src/modules/kernel/decision-replay.ts; focused tests.

**Interfaces:** Consume Task 1 exported brief, recommendation reasoning and context basis. Produce complete proposal readback/manual fields and accepted-option context available to Task 3. Reuse existing mutation/readback APIs.

- [x] Write failing behavioral tests for reuse with absent/existing relationship, repeated/concurrent acceptance, rejection safeguards, unchanged tactic/assessment, proposed/unassessed new/expansion acceptance and retained conditions.
- [x] Write stale-context tests for changed gap requirements, coverage, priority rationale and tactic lifecycle between generation and acceptance, including explicit renewed human review and immutable original reasoning. Test rollback on failure.
- [x] Preserve recommendation reasoning, unresolved checks and original context in JSON metadata, strict readers, manual create/edit and immutable AI baseline. Optional manual comparison/conditions must save without all three route comparisons.
- [x] Extend existing source acceptance transaction and lock order. Reuse returns existing tactic id and requests existing coverage review, preserving dimensions/verdict/locks/history. Absent mapping is unassessed and duplicate prevention must be protected by owner locks. No new tactic/expansion for reuse. Preserve rejected relationship protections.
- [x] Gate material stale acceptance with current reviewed context token through existing expected-version/manual review mechanisms, so choosing manual cannot silently bypass a changed context. Preserve original basis and audit renewed review; browser must be able to submit reviewed current basis.
- [x] Retain accepted conditions via proposal source for new/expanded work and expose a shared read model for Task 3. Ensure S10 excludes reuse from supplying timing/design. Extend learning/replay contracts so reuse is never silently treated as new.
- [x] Run new tests plus s9-expansions, manual-plan-prioritize-ideate, tactic-expansions, expansion-coverage, expansion-timeline and relevant audit/replay tests; typecheck and scoped lint. Report exact results and exported interfaces; no commit.

### Task 3: Review UI, manual operation and integration

**Files:** src/components/tactic-ideation/{data,ideation-board,tactic-panel}.tsx/ts; src/components/ideation/{proposal-card,proposal-fields,gap-proposal-group}.tsx/ts; src/lib/iegp/tactic-record.ts; src/components/timeline/timeline-board.tsx; existing shared planning views as needed; tests/e2e; specs/README.md.

**Interfaces:** Consume per-gap brief, proposal reasoning/current reviewed basis and accepted-option context from Tasks 1-2. Follow existing component and action-dialog patterns; read relevant node_modules/next/dist/docs before API/UI edits.

- [x] Write behavior/render tests for context with AI off and no proposals, conditional checks and missed-deadline outcomes, reuse acceptance wording/navigation, secondary non-probabilistic Judge rating, manual optional rationale/uncertainties and stale acceptance review.
- [x] Expose relevant brief to eligible gaps on primary and legacy review surfaces, including AI-off and empty recommendations. Show remaining need, contribution, comparison and unresolved checks before score/details. Show unresolved deadline/discrepancy explanations without implying coverage changed.
- [x] Support reuse/manual target selection via existing API and coverage-review navigation; maintain accessibility and existing permissions. Submit reviewed current basis for deliberate renewed review after change and keep history.
- [x] Show accepted feasibility checks in shared tactic review, proposal/board planning and timeline, using proposal as source without overwriting parent descriptions/assessments. Reuse must not appear as new work.
- [x] Update design discussion status and specs index. Run focused UI tests, relevant existing regressions, npm run typecheck and scoped lint; add/run an affected browser flow using disposable E2E infrastructure where available. Report limitations honestly; no paid models, no commit.
