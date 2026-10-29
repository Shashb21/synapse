# KAN-184 Timeline Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Preserve human timeline locks and keep state and audit records atomic under concurrent edits.

**Architecture:** Reuse `withWorkspaceTransaction` and PostgreSQL transaction-scoped advisory locking at the timeline mutation owner. Serialize the complete read/validate/write/audit sequence per workspace, including graph validation. All timeline writers that can overwrite metadata must participate; stage rebuilds must not persist metadata derived before a concurrent human edit.

**Tech Stack:** TypeScript, Drizzle, PostgreSQL, Vitest, Next.js 16.3.8.

**Spec:** https://synapse21.atlassian.net/browse/KAN-184 (fetched 2026-10-27). Independent edits must both survive or explicitly conflict; human locks must never silently disappear; state and audit must commit or roll back together; graph cycles remain prevented. A deterministic concurrent regression must synchronize requests with a barrier on the same initial state.

## Global Constraints

- Keep existing API signatures, authorization, workspace isolation, rationale validation, and audit attribution.
- Reuse the existing ambient workspace transaction; do not create a process-local mutex or new persistence abstraction.
- PostgreSQL locks must be scoped to the resolved workspace schema, not caller-supplied workspace ids.
- Cover all timeline metadata writers, including rebuild, add/remove, estimate acceptance, proposal review, and manual schedule/dependency edits.
- Keep slow LLM work outside locks where practical; revalidate persisted inputs or reject stale rebuilds explicitly before writing.
- Use this TypeScript repository's Vitest/database tests; no pytest for TypeScript.
- No unrelated UI changes, new dependencies, or schema migrations without demonstrated need.
- Controller owns commits, pushes, Jira, and PR operations. Worker must not dispatch subagents.

## Review Focus

- Concurrent schedule and dependency changes preserve both sets of human locks.
- Competing graph edges cannot both commit a cycle.
- Audit failure rolls back state and all earlier audit records in the edit.
- Rebuild or proposal/estimate changes do not overwrite a concurrent human decision.
- Lock scope prevents same-workspace races without leaking between schemas.

### Task 1: Serialize timeline mutations and prove atomicity

**Files:**
- Modify: `src/modules/stages/s10-timeline/module.ts`
- Create: `tests/kan-184-timeline-concurrency.test.ts`
- Modify only if needed for a real concurrent database harness: `src/lib/iegp/db.ts` or `tests/support/*`.

**Interfaces:** Keep public timeline function signatures. Existing ambient `db()` and `recordEdit()` calls must share the transaction. Use a private documented helper for common lock acquisition if it improves ownership.

- [ ] Trace every write to `timelineActivities` and existing transaction/audit behavior before editing. Read relevant installed Next.js documentation before editing any route code; avoid route changes if unnecessary.
- [ ] Write deterministic database regression tests first. Use a barrier with two independent database connections/requests synchronized on the same initial state; do not rely on sleeps or a one-connection pool that serializes away the race. Cover concurrent schedule/lane and dependency changes, graph edge conflicts, and forced audit/write failure rollback. Ensure a pre-fix test fails for the actual lost-update/atomicity defect.
- [ ] Implement the smallest coherent locking/transaction solution at the timeline owner. Acquire workspace lock before authoritative reads and cycle checks. Ensure rebuilds cannot overwrite metadata read before a human edit, using revalidation/conflict handling or re-deriving authoritative state under the lock. Keep all state and audit writes atomic.
- [ ] Test non-happy paths: invalid/cyclic dependencies do not modify state or audit; add/remove and estimate/proposal edits keep existing behavior; schema-scoped lock identity is stable.
- [ ] Run focused tests: `npx vitest run tests/kan-184-timeline-concurrency.test.ts tests/manual-timeline.test.ts tests/kan-25-manual-timeline.test.ts tests/expansion-timeline.test.ts tests/kan-90-attributable-edits.test.ts tests/kan-90-plan-coverage.test.ts`. Run `npm run typecheck` and `npx eslint <changed TypeScript files>`. Record exact commands/results and any environment limitations.
- [ ] Self-review the diff, and write the full report (including RED/GREEN evidence, modified files, verification, and limitations). Do not commit; controller handles git operations.
