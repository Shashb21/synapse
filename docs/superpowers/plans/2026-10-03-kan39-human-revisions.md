# KAN-39 human revisions implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development and delegate-implement for implementation. Work task-by-task with fresh reviews.

**Goal:** Authorized reasoned additions, edits, and removals create checked, relinked successors requiring fresh live approval.

**Architecture:** Extend immutable assembly/item history with explicit human origins and revision ancestry. Existing workspace locks serialize head publication; existing coverage logic links exact versions outside database transactions. Approval reads the current revision head rather than falling back to its baseline.

**Tech Stack:** TypeScript, Next.js 16.3.5, React 19, Drizzle/PostgreSQL, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-kan39-human-revisions-design.md`

## Global constraints

- Every human addition, edit, and removal requires author, reason, source/provenance and immutable lineage.
- Agents complete extraction and linking before the normal human review step.
- Changed output requires whole-set checks and a new approval before downstream use.
- Preserve unedited agent outputs and evaluator-only gold/model scores.
- Use authenticated contributors and organization-authorized workspace scoping.
- No shared branch merges; controller owns commits, dual-remote publication, PR and Jira lifecycle.

## Review focus

- A reviewer approving the old baseline after a human revision must receive conflict; no approval fallback.
- A failed coverage provider call leaves a visible blocked successor with a retry path.
- Competing contributors cannot publish siblings that silently replace each other's work.
- Changed extraction heads supersede human revisions and stale in-flight provider results.
- A human-added history-only backing claim must appear only through fresh approved exact projection.

### Task 1: Immutable human origins, revisions, linking and approval enforcement

**Files:** Extend `src/accuracy/domain/item-history.ts`, `assembly.ts`, `src/accuracy/store/schema.ts`, `db.ts`, `tenant.ts`, `assembly-store.ts`, `assembly-review-store.ts`, `item-history-store.ts`, and `src/accuracy/kernel/assembly-generation.ts`; create focused revision domain/store/kernel modules as needed. Extend `src/app/api/accuracy/assemblies/route.ts`. Tests: `tests/accuracy-assembly-revision.test.ts` and existing approval/history/generation tests.

**Interfaces:** Produce server revision creation/retry functions and authorized API responses containing saved successor assembly, revision/change lineage, and review state. Request supplies workspace/parent assembly, expected fingerprint/head, action, required reason, selected version for edit/remove, and validated content/source for add/edit; authors and origins are server-owned. Define and document exact exported types in the report for Task 2.

- [x] Write failing tests for reasoned add/edit/remove and exact unedited baseline preservation; malformed reasons/payloads/quotes and cross-workspace IDs reject.
- [x] Run `npx vitest run tests/accuracy-assembly-revision.test.ts --silent` and confirm failures target missing revision behavior.
- [x] Implement explicit human-origin persistence, atomic revision head publication and cleanup, preserving generated origin validation.
- [x] Reuse version-bound linking; retain unaffected coverage, remove obsolete pairs, and save/retry incomplete successors without holding transactions across provider calls.
- [x] Extend exact approval/current-head/inventory/publication revalidation to successors. Add tests for old approval refusal, stale parents, competing writers, new extraction during linking, incomplete linking retry, and fresh approval projecting edited/added content.
- [x] Add strict authenticated contributor API tests, rollback and unchanged experiment/gold score tests.
- [x] Run focused revision/approval/history/generation tests, `npm run typecheck`, and lint changed files. Record commands/results and exact interfaces for the reviewer and Task 2.
- [x] Controller reviews and commits the accepted task.

### Task 2: Contributor review controls and final integration

**Files:** Extend `src/components/accuracy/assembly-history.tsx` and focused revision form component, `tests/accuracy-assembly-history-ui.test.ts` (or existing UI test path), and `docs/kan-39-human-revisions.md`.

**Interfaces:** Consume Task 1's strict API and server-provided revision/review state. Never fabricate actor or lineage fields.

- [x] Read installed Next.js route/component guides and applicable frontend styling skill before edits.
- [x] Write failing tests for contributor add/edit/remove controls, required reason/provenance, baseline/revision labels, viewer read-only behavior, stale/failed refresh invalidation, and retry of incomplete links.
- [x] Implement schema-specific labeled forms using existing Ledger styling, keyboard controls and announced errors. Reload saved successor and reuse its fresh approval controls; preserve baseline navigation.
- [x] Add usage guide with explicit workflow, limits and verification commands.
- [x] Run focused UI/API/revision tests, typecheck, changed-file lint and diff whitespace check.
- [x] Controller reviews and commits accepted task; run full `npx vitest run --silent` once, then fresh whole-branch review.
- [ ] Fix material findings and verify affected tests. Publish branch to both remotes and create/attach PR against KAN38.
- [ ] Record verification and limitations in Jira; transition KAN-39 Done only after successful comment and checks. Select next eligible issue and arm the one-shot handoff per AGENTS.md.
