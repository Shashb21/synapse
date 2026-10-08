# KAN-77 and KAN-76 Learning and Tactic Expansions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish decision learning before tactic matching, then support reviewed expansions of existing tactics without duplicate studies or premature gap addressing.

**Architecture:** Reuse and repair the existing KAN-78/KAN-79 implementation. Extend the kernel's prompt/evaluation machinery and the modular IEGP tactic, coverage and timeline layers. An expansion is a persisted child activity with an independent lifecycle and coverage scope.

**Tech Stack:** TypeScript, Next.js 16.3.5, React, PostgreSQL, Drizzle, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-kan77-kan76-learning-expansions-design.md` (approved by the user).

## Global Constraints

- KAN-76 owns implementation; KAN-67 supplies binding expansion acceptance criteria and must not become a second implementation.
- Complete KAN-77 through KAN-78, KAN-79 and KAN-80 before starting KAN-76 implementation. Verify and reuse KAN-75; do not reopen or rebuild it without an evidenced defect.
- Keep product behavior in the modular IEGP stages and their shared kernel; do not create a parallel expansion implementation in Accuracy Lab.
- Same-workspace examples may contain their original text. Cross-workspace examples expose only validated lessons: no raw inputs, outputs, rationales or customer metadata.
- Missing entity context, failed validation or failed generation must prevent sharing that lesson.
- Real-customer cross-workspace learning remains disabled until anonymised usage is covered by customer terms.
- A revision is a candidate until evaluated and approved. It never replaces the active prompt merely because generation or scoring succeeds.
- Require a strict improvement on the combined evaluation and no regression on any scored gold metric. Missing gold, missing replay cases, failed cases or non-comparable runs make the candidate ineligible for promotion.
- Exclude the held-out evaluation examples from worked-example retrieval and revision-generation inputs so the system cannot receive the answers it is being tested on.
- Keep ideation restricted to open gaps with a human-validated High priority.
- An accepted expansion initially has status proposed. Coverage attributable to it remains non-counting even if its parent tactic is completed or ongoing. Existing coverage from the parent tactic remains intact.
- Preserve human locks, rejection memory and audit records. Coordinate the additive coverage contract with KAN-83; do not duplicate its shared status engine.
- Use an isolated worktree. Preserve the current checkout's unrelated edits. Read relevant installed Next.js guides before editing routes or UI.
- Use Vitest and Playwright for this TypeScript project. Required real-model Corvantix QA cannot be substituted with stub output.
- The controller owns git publication and Jira operations. Implementers do not push or spawn agents. Any published commit must reach both origin and github.

## Review Focus

1. Background lesson generation for a foreign workspace must load that workspace's names and refuse sharing when context is unavailable (Task 1).
2. Held-out examples, empty evaluation sets, changed model/routes and stale baselines must never produce a promotable result (Task 3).
3. Concurrent proposal acceptance must produce one expansion and one decision history entry, or a clear conflict, with no partial writes (Tasks 4 and 6).
4. A proposed expansion of an ongoing tactic must not count, while original human-locked coverage remains intact (Task 4).
5. Multiple expansions of the same tactic must retain distinct dates, identities and manual edits after timeline rebuilds (Task 7).

## Setup and task ledger

- Refresh origin/main, github/main and both KAN-78-decision-learning refs. Compare the fetched hashes before choosing a base. Use origin/main product flows plus the existing learning commits; leave the divergent KAN4 checkout intact. If learning has already merged, use that behavior rather than replaying the commits.
- Create a feature worktree under `/private/tmp/synapse-kan77-kan76` and branch `codex/kan77-kan76-learning-expansions`. Repository instructions permit normal authorised implementation setup; never overwrite an existing directory or branch with work.
- Copy this plan and its approved spec into the worktree without modifying the root's other documents. Record starting HEAD, baseline and related branch hashes in the ledger.
- Use `scripts/sdd-workspace` from the SDD skill for this plan, then create its `progress.md`. Include the required self-consistency rows and every pair of tasks sharing files/interfaces in the preflight table. Record rulings before dispatch.
- Run the smallest baseline test set covering KAN-75, existing S3/S9 and learning. Record commands, output and environment limitations. Check dependency installation and database requirements without exposing credentials.
- Associate Tasks 1–3 with KAN-78/79/80 respectively; Task 1 may repair both learning children. Tasks 4–7 belong to KAN-76 with KAN-67 acceptance included. Never mark a Jira issue Done before required verification and a successful summary comment.

### Task 1: Reuse and repair decision capture and privacy boundaries

**Files:**
- Reuse/modify: `src/modules/kernel/decision-examples.ts`, `src/lib/iegp/learning-capture.ts`, `src/modules/kernel/agentic.ts` and the capture integrations on the existing learning branch.
- Modify as required: `src/modules/workspaces/store.ts`, `src/modules/stages/s2-gap-extract/suggestions.ts`, `src/modules/stages/s4-kg-mapping/module.ts`, `src/modules/stages/s6-partial-split/module.ts`, `src/modules/stages/s8-prioritization/module.ts`, `src/modules/stages/s9-ideation/module.ts`, `src/app/api/iegp/route.ts`.
- Test: `tests/kan-78-79-decision-learning.test.ts`; create `tests/decision-learning-privacy.test.ts`.

**Interfaces:**
- Preserve `recordDecisionExample(draft: DecisionExampleDraft): Promise<string | null>` and existing capture helper signatures.
- Extend `similarExamples` arguments with `exclude_ids?: string[]` and `allow_cross_workspace?: boolean`, defaulting cross-workspace reuse to false until the requesting workspace is explicitly eligible.
- Add `withLearningExclusions<T>(ids: readonly string[], fn: () => Promise<T>): Promise<T>` using the same request-scoping pattern as prompt variants; agentic lookup consumes it.
- Add `learningSharingEligible(workspaceId: string): Promise<boolean>`; persist eligibility through the existing workspace/settings layer, default false. Require eligibility for both source and recipient. No customer sharing is enabled in this task.
- Extend examples with optional originating run/prompt/actor provenance and a nullable replay input. Retain compatibility with legacy rows; missing provenance is visible rather than fabricated from the current route.

- [ ] **Step 1: Write failing behavioral tests.** Assert that lesson generation for example B loads workspace B even while workspace A is ambient; lookup failure leaves no shareable lesson; cross-workspace prompts never contain B's raw text; disabled sharing excludes foreign lessons; excluded IDs never appear; S2/S4/S8/S9 and residual decisions produce one correctly classified example with available originating provenance. A logging failure must leave the human action successful and observable.
- [ ] **Step 2: Run focused tests and record expected failures.** `npm test -- tests/kan-78-79-decision-learning.test.ts tests/decision-learning-privacy.test.ts`. Do not replay already-merged implementation.
- [ ] **Step 3: Repair the existing implementation.** Resolve the recorded workspace through existing workspace lookup and `runInWorkspace`; refuse cross-workspace sharing without entity context; rank foreign cases by validated lessons rather than raw customer input; revalidate lessons before emission. Capture full replayable input where available and retain explicit exclusions where unavailable. Keep worked cases descriptive, retain example trace IDs and remove the old hard-rules injection. Put duplicate-capture protection in the shared capture owner.
- [ ] **Step 4: Verify repaired paths.** Run the focused commands above plus existing `tests/modules-contracts.test.ts` and KAN-75 suggestion tests. Confirm the added tests cover the failure behavior without merely mocking the final result.
- [ ] **Step 5: Self-review, report and commit Task 1.** Report RED/GREEN evidence, changed files and limitations to the task report. The controller performs the fresh requirements/quality review and records the outcome before continuing.

### Task 2: Agreement reporting and immutable prompt candidates

**Files:**
- Create: `src/modules/kernel/learning-agreement.ts`, `src/modules/kernel/prompt-revisions.ts`, `src/app/api/admin/learning/route.ts`, `src/app/admin/learning/page.tsx`, `src/components/platform/learning-console.tsx`.
- Modify: `src/components/admin/admin-nav.ts`, `src/modules/kernel/schema.ts`, `src/modules/kernel/db.ts` for registered schema setup.
- Test: `tests/learning-agreement.test.ts`, `tests/prompt-revisions.test.ts`, `tests/admin-learning-api.test.ts`; create `e2e/features/decision-learning-admin.spec.ts`.

**Interfaces:**
- `agreementSeries(examples: DecisionExample[], bucket: "day" | "week"): AgreementBucket[]`, where each bucket contains stage, period, total, accepted, edited, rejected and nullable shares. Count every valid decision once; zero total produces null shares.
- `proposePromptRevision(args: { stage: StageId; workspace_id: string; actor: Actor; exclude_ids: string[] }): Promise<PromptRevision>`.
- `PromptRevision` contains id, stage, parent revision, instruction text, creator/time and candidate/evaluated/active/superseded state. Candidates are immutable; revising creates another version.
- Owner-only `GET /api/admin/learning` returns agreement and revision metadata for the authorised admin workspace. `POST` accepts the Zod-validated action `propose` plus stage; the server resolves workspace and actor, never trusting those from arbitrary request fields. The server freezes held-out cohort IDs before generation and passes them as exclusions; a client cannot shrink this exclusion set. Persist training and held-out identities with the candidate so later evaluation can prove separation.

- [ ] **Step 1: Write failing tests.** With one accepted, one edited and two rejected decisions assert counts `1/1/2`, total `4`, shares `.25/.25/.5`. Assert stage separation, invalid timestamps handled explicitly, empty buckets have null shares, non-owner access denied, and a generated revision receives lessons only and cannot change the active version.
- [ ] **Step 2: Run tests.** `npm test -- tests/learning-agreement.test.ts tests/prompt-revisions.test.ts tests/admin-learning-api.test.ts` and record RED evidence.
- [ ] **Step 3: Implement the focused kernel and admin flow.** Reuse existing owner page/API gates, selected admin workspace, LLM routing and AI-off behavior. Candidate generation uses validated disagreement lessons outside exclusions. Show counts/date range and an accessible agreement chart with a textual table. Preserve existing admin styling and responsive behavior; use impeccable/uncodixfy instructions for the UI.
- [ ] **Step 4: Verify.** Run focused tests, `npm run typecheck`, and `npm run test:e2e -- e2e/features/decision-learning-admin.spec.ts` for permission, reporting and candidate creation. Separate database/model availability failures from code failures.
- [ ] **Step 5: Self-review, report and commit Task 2; obtain its task review.**

### Task 3: Held-out replay scoring, guarded promotion and rollback

**Files:**
- Create: `src/modules/kernel/decision-replay.ts`, `src/modules/kernel/prompt-revision-evals.ts`.
- Modify: `prompt-revisions.ts`, `prompt-variant.ts`, `hillclimb-loop.ts`, `agentic.ts`, the participating S2/S3/S4/S6/S8/S9 modules, the admin learning route/console.
- Test: `tests/decision-replay.test.ts`, `tests/prompt-revision-evals.test.ts`, `tests/prompt-revisions.test.ts`, `tests/admin-learning-api.test.ts`, admin learning E2E.

**Interfaces:**
- `scoreDecisionReplay(example: DecisionExample, output: unknown): ReplayScore` returns scored metric values or an explicit unsupported/unreplayable reason.
- `evaluatePromptRevision(args: { revision_id: string; workspace_id: string; actor: Actor }): Promise<RevisionEvaluation>` records frozen cohort IDs, baseline/candidate version, model/route identity, separate gold/replay metrics and counts, failures and eligibility/reasons.
- `promotionEligibility(evaluation: RevisionEvaluation): { eligible: boolean; reasons: string[] }` is pure and independently testable.
- `activatePromptRevision(args: { revision_id: string; evaluation_id: string; expected_active_id: string | null; actor: Actor }): Promise<PromptRevision>` and `rollbackPromptRevision(args: { stage: StageId; expected_active_id: string; actor: Actor }): Promise<PromptRevision | null>` perform atomic pointer/history mutations.
- Extend existing prompt scoping so every participating live stage reads the approved active revision; evaluation supplies a scoped candidate override without changing the live pointer. Keep legacy static variants compatible.
- Add owner API actions `evaluate`, `approve`, `rollback`; validate IDs and expected active version. Read case details only in the authorised workspace.

- [ ] **Step 1: Write failing replay and promotion tests.** Accepted cases compare against AI proposals; edited cases compare against final human values; rejected cases expect the stage's explicit reject decision and never reward reproducing rejected text. Suggestion classification, coverage verdict, priority band and proposal outcome/design each have a typed projection; unsupported legacy records produce exclusions. Assert candidate `.8` versus baseline `.7` with non-regressing gold is eligible; equality, any gold regression, empty gold/replay, failures and mismatched routes are ineligible. No cases used in evaluation appear in generation/retrieval. Dry-run replay must leave live plan counts and decision logs unchanged.
- [ ] **Step 2: Run focused tests and retain RED output.** `npm test -- tests/decision-replay.test.ts tests/prompt-revision-evals.test.ts tests/prompt-revisions.test.ts tests/admin-learning-api.test.ts`.
- [ ] **Step 3: Implement the evaluation contract.** Use the existing curated-gold harness and stage execution under isolated read-only evaluation state; a `dry_run` flag alone is insufficient if a stage still persists side effects. Build a fixed replay cohort from this workspace's replayable decisions and withhold its IDs. Combined score is the equal-weight mean of the gold and replay composites; each composite preserves the existing metric semantics and documents numerator/denominator. Promotion requires strict combined improvement and no lower individual gold metric, with complete comparable evidence. Persist immutable evaluation records; evaluation never activates a revision.
- [ ] **Step 4: Implement atomic approval/rollback and UI.** Guard approval against changed prompt pointer, changed routing, outdated candidate/evaluation and non-owner access. Store actor and before/after revisions in the same transaction as pointer changes. Concurrent approvals cannot both succeed from the same expected baseline. Show individual metrics, excluded cases, reasons, candidate diff and rollback history. Explicitly distinguish a sweep champion from an active prompt.
- [ ] **Step 5: Verify.** Run focused tests, `npm run typecheck`, and the admin learning E2E, including stale approval, forbidden access and rollback restoring the previous instruction on a subsequent live call. Record failures/limitations; review Tasks 1–3 together for KAN-77 acceptance before beginning tactic implementation.
- [ ] **Step 6: Self-review, report, commit and obtain the task review.** Update Jira children and KAN-77 only after their complete verification/comment/transition requirements succeed.

### Task 4: Canonical expansion storage and scoped coverage eligibility

**Files:**
- Create: `src/lib/iegp/tactic-expansions.ts` for canonical expansion mutations.
- Modify: `src/lib/iegp/types.ts`, `src/lib/iegp/store.ts`, `src/lib/iegp/schema.ts`, `src/lib/iegp/engine.ts`, `src/modules/stages/s4-kg-mapping/module.ts`, `src/app/api/plan/route.ts`.
- Test: `tests/tactic-expansions.test.ts`, `tests/expansion-coverage.test.ts`; reuse `tests/manual-mapping.test.ts` and `tests/iegp-store.test.ts`.

**Interfaces:**
- Add `TacticExpansion` with id, tactic_id, gap_ids, incremental scope/design, feasibility risk, cost/effort, timing, status, origin/proposal, version/history, dates and actor provenance. `IegpState.expansions` contains these children; legacy persisted workspaces load an empty list.
- `acceptTacticExpansion(args: { proposal_id: string; tactic_id: string; gap_id: string; scope: ExpansionScope; rationale: string; actor: Actor; expected_tactic_version: string }): Promise<TacticExpansion>` creates a proposed child atomically with coverage/decision/history.
- `setExpansionStatus(args: { expansion_id: string; status: TacticStatus; rationale: string; actor: Actor; expected_version: string }): Promise<TacticExpansion>` records human lifecycle changes.
- Add nullable `expansion_id` on `GapTacticCoverage`; null is existing parent scope. Allow parent and multiple child-scope assessments for one gap/tactic without identity collisions. Add optional expansions input to coverage/status calculation, and update all consumers with the loaded children. Preserve old calls for parent-only coverage.
- S4 sees explicit scope identifiers and commits to the supplied scope; it never merges proposed child scope into the parent's question or overwrites its locked assessment.

- [ ] **Step 1: Write failing tests.** An ongoing parent plus proposed child coverage leaves the new gap Open; marking the child planned makes its assessment eligible, without automatically human-validating full coverage. Original locked parent coverage is unchanged. Missing child, wrong parent/workspace, cancelled/rejected scope, stale version, missing rationale and repeated/concurrent acceptance fail safely. Assert one child/coverage/history on duplicate retry and no partial records after transaction failure.
- [ ] **Step 2: Run tests.** `npm test -- tests/tactic-expansions.test.ts tests/expansion-coverage.test.ts tests/manual-mapping.test.ts tests/iegp-store.test.ts` and capture RED output.
- [ ] **Step 3: Implement additive migrations and canonical mutations.** Preserve legacy tactic IDs/counts and null-scope mappings. Use scoped database transactions and existing human mapping/rejected-pair guards; explicit human acceptance may override a rejected pair through the existing documented human path. New model reruns cannot bypass it. Accepted expansions do not silently rewrite locked parent design. Expose scope/history in the existing tactic details with editable child status.
- [ ] **Step 4: Extend the shared status owner and S4 target contract.** Proposed, cancelled and rejected expansion scope never counts; planned/ongoing/completed scope follows ordinary eligibility and human-validation rules. Missing expansion records fail closed for that coverage. Confirm coordinated contract against KAN-83 without editing its live worktree.
- [ ] **Step 5: Verify, self-review, report, commit and obtain the task review.** Run focused tests plus typecheck. Demonstrate a pre-existing workspace loads unchanged and a second expansion does not replace the first scope.

### Task 5: S3 same / overlaps / new matching and source review

**Files:**
- Modify: `src/modules/stages/s3-tactic-extract/module.ts`, `schema.ts`, `src/lib/iegp/store.ts`, `src/lib/iegp/types.ts`, tactic page/review components and existing plan API.
- Create: `src/modules/stages/s3-tactic-extract/suggestions.ts`.
- Test: `tests/s3-llm.test.ts`, `tests/tactic-suggestions.test.ts`; extend `e2e/features/s3-tactic-extract.spec.ts`.

**Interfaces:**
- S3 matching output: `match: "same" | "overlaps" | "new"`, `target_tactic_id: string | null`, shared/new scope, expansion option and separate linked tactic option with source quote. Validate same/overlaps target IDs against supplied inventory; new requires null target.
- `decideTacticSuggestion(args: { id: string; decision: "expand" | "separate" | "reject"; rationale: string; actor: Actor }): Promise<TacticSuggestion>` persists one decision and calls Task 4's canonical expansion mutation for expand. Separate creates a linked tactic from the documented source, preserving its supported lifecycle; no model invents commitment.
- Persist multiple source references on same matches without overwriting parent design or duplicating a source sentence. Overlaps only creates a pending suggestion.

- [ ] **Step 1: Write failing tests.** Same attaches source and preserves tactic count/design; new creates one tactic; overlaps makes no unreviewed tactic mutation. Unknown targets and invalid classification/target combinations are rejected. Expand, separate and reject require rationale, preserve quotes/history and cannot be decided twice. Locked parent design remains unchanged. Model reruns retain rejected suggestions.
- [ ] **Step 2: Run tests.** `npm test -- tests/s3-llm.test.ts tests/tactic-suggestions.test.ts` and record RED evidence.
- [ ] **Step 3: Extend existing model and persistence paths.** Keep proposer/critic/judge behavior and repair/validation conventions. Reuse KAN-75 review layout and permissions patterns, retaining separate tactic-specific ownership. Capture each human review outcome in the learning log from Task 1.
- [ ] **Step 4: Verify.** Run focused tests, typecheck and the S3 browser flow for current-versus-proposed scope, editing, rationale and decision outcomes.
- [ ] **Step 5: Self-review, report, commit and obtain the task review.**

### Task 6: S9 expansion alternatives, editing and acceptance

**Files:**
- Modify: `src/modules/stages/s9-ideation/module.ts`, `src/modules/kernel/schema.ts`, `src/components/ideation/proposal-card.tsx`, `proposal-fields.ts`, `gap-proposal-group.tsx`, `src/app/ideation/page.tsx`, `src/app/api/plan/route.ts`.
- Test: `tests/s9-llm.test.ts`, `tests/manual-plan-prioritize-ideate.test.ts`, `tests/s9-expansions.test.ts`; extend `e2e/features/s9-ideation.spec.ts`.

**Interfaces:**
- Proposal discriminator: `proposal_kind: "new" | "expansion"`, `target_tactic_id: string | null`, expansion scope/coverage, incremental cost/effort, timing, feasibility and comparative rationale. Existing persisted proposals default to new; `tactic_id` remains acceptance result, never the proposed target. Add `expansion_id` for accepted child identity.
- Preserve existing edit and decision signatures, adding typed expansion fields. `decideIdeationProposal` dispatches expansion acceptance to Task 4 and new acceptance to the existing tactic path. Both guard current proposal state.
- Keep the shared high-only eligibility function and emit “Expand: <existing tactic>” / “New tactic” on review cards.

- [ ] **Step 1: Write failing tests.** Given a High validated gap and a realistic existing registry, proposer receives full status/design and proposes expansion plus new options; critic/judge comparison includes quality, time/cost and feasibility. A completed trial expansion is post-hoc; prospective additions require a credible amendment/new study. Unknown target, incomplete expansion and invalid numeric timing fail validation. Medium/Low/unvalidated gaps stay excluded.
- [ ] **Step 2: Run tests.** `npm test -- tests/s9-llm.test.ts tests/manual-plan-prioritize-ideate.test.ts tests/s9-expansions.test.ts` and capture RED output.
- [ ] **Step 3: Extend proposer/critic/judge and persisted proposal contract.** Do not enforce a fabricated expansion when the library offers none; require explicit consideration/comparison and keep valid alternatives. Preserve human edits and target identity on reruns, rejection/restore behavior and source/run provenance. Retain rejected expansion memory keyed by gap, target and scope; an explicit human restore permits reconsideration.
- [ ] **Step 4: Extend existing UI and API.** Display target/current scope beside added scope, allow editing before accept/reject and use existing rationale dialogs/permissions. Atomically accept into the existing target without a duplicate tactic, preserve parent locks/status, record history and learning, and surface stale/deleted target conflicts clearly. Correct stale ideation copy to High only.
- [ ] **Step 5: Verify.** Focused unit tests, typecheck and S9 browser tests assert labels, edits retained, acceptance tactic count unchanged, proposed child status, reject/restore and duplicate-click safety.
- [ ] **Step 6: Self-review, report, commit and obtain the task review.**

### Task 7: Nested expansion timeline and full acceptance QA

**Files:**
- Modify: `src/modules/stages/s10-timeline/build.ts`, `module.ts`, `src/components/timeline/timeline-board.tsx`, `gantt-chart.tsx`, relevant timeline detail/actions.
- Test: `tests/expansion-timeline.test.ts`, `tests/manual-timeline.test.ts`, `tests/s10-llm.test.ts`; extend `e2e/features/s10-timeline.spec.ts` and add `e2e/features/tactic-expansion-acceptance.spec.ts`.

**Interfaces:**
- Expansion timeline activities use `ACT-EXP-${expansion.id}` and carry `expansion_id`, parent `tactic_id`, activity-specific status, dates, scope and coverage eligibility. Parent identity remains `ACT-${tactic.id}`.
- Reuse schedule/dependency origin and lock preservation. Existing timeline actions resolve expansion activity identity rather than mutating the parent's schedule or status.

- [ ] **Step 1: Write failing tests.** Two expansions under one parent render distinct nested activities. Proposed child shows non-counting status; child planned status updates eligibility. Parent and each child's manual dates/dependencies survive rebuild. Removing/restoring one child does not remove siblings or parent. Exports retain the parent-child relationship.
- [ ] **Step 2: Run tests.** `npm test -- tests/expansion-timeline.test.ts tests/manual-timeline.test.ts tests/s10-llm.test.ts` and record RED output.
- [ ] **Step 3: Extend timeline build, persistence and display.** Preserve legacy activity IDs, independent scheduling and human locks. Use accessible grouping and controls consistent with existing timeline UI; expose no implementation jargon to product users.
- [ ] **Step 4: Run acceptance QA.** Run focused unit tests, `npm run typecheck`, lint on changed files and the S3/S9/S10/admin/expansion browser flows. Use the Corvantix QA workspace with a connected real model and capture at least one sensible registry expansion beside fresh ideas, unchanged tactic count after acceptance, proposed/non-counting scope, explicit planned status transition and nested timeline activity. Avoid destructive resets of a shared workspace; use an authorised isolated QA copy when needed. Missing model/database access leaves live acceptance unverified and the issues open.
- [ ] **Step 5: Self-review, report, commit and obtain the task review.**

## Final review and Jira completion

- Generate one whole-branch review package against the recorded starting base. Dispatch a fresh reviewer on the most capable available model, including all parked/minor ledger entries and the approved spec. Follow the skill's single final fix wave and scoped re-review.
- Record complete verification commands/results and material limitations. Only then add concise implementation/verification comments and transition eligible KAN-78/79/80/77/76/67 issues to Done. Do not resolve KAN-67 merely because its duplicate link exists.
- Preserve all ledger rulings for the final response. Do not delete artifacts while an acceptance check or integration approval is pending.
- Follow the branch finishing skill for integration. Push only the agreed branch, to both remotes, and obtain approval for merge/publication where required. The controller handles git operations.
- Once Jira confirms Done, perform the mandated assigned Ready/To Do selection and lifecycle handoff using the authenticated connector and successful transition evidence. Do not arm a handoff for an already-running issue or without complete next-issue context.

## Controller self-review

- Spec coverage: learning capture/privacy/retrieval are owned by Task 1; agreement/generation by Task 2; replay/approval/rollback by Task 3; expansion lifecycle/status/history by Task 4; S3 matching/review by Task 5; S9 alternatives/review/acceptance by Task 6; timeline and real-model QA by Task 7.
- Interfaces: later tasks consume the canonical expansion mutation and independent coverage identity from Task 4; prompt activation depends on persisted revision/evaluation identities from Tasks 2–3. Existing proposal `tactic_id` is never overloaded as a target field.
- Review focus: each of the five listed risks has a named behavioral test step in its owning task. Legacy rows remain readable, customer sharing defaults off, and unsupported replay cases are visible exclusions.
- Remaining execution prerequisites: refreshed remote evidence, isolated workspace baseline tests and confirmation that the database/real-model QA environment is available. Their absence cannot be presented as passed verification.
